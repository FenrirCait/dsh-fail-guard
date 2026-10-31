/**
 * dsh-fail-guard — 连续失败停手守卫。
 *
 * ## 它解决什么
 *
 * 复读（thinking 里连串「做。」「写。」）的成因不是模型退化，是**连续试错**：
 * 同一件事失败、换参数、再失败，没有新信息，于是同一个「该动手了」的决定被反复重下。
 * 2026-10-30 在一份 74 轮的会话里实测：前 67 轮短句行占比在 7–48% 波动，
 * 从「用浏览器滚评论区连续十几步失败」那一刻断崖跳到 81.6%，之后 85.9% / 89.1% / 91.4%。
 *
 * 提示词层的规则（R3「连续失败第 2 次必须停手」）对已经进入循环的状态无效——
 * 那个状态下模型读的不是提示词，是它自己的 thinking。所以需要外部打断。
 *
 * ## 它怎么做
 *
 * 记下每个 `tool/call` 的 callId→工具名，再看每个 `tool/result` 是不是失败
 * （`message.isError` 或 `meta.opsShell.exitCode !== 0`）。同一个会话里**同一工具**
 * 连续失败达到 `threshold` 次，就用 `agent.steer()` 推一条停手指令进去——
 * 那是一条真正的用户消息，会进下一步被模型读到。
 *
 * ## 事件挂在哪（2026-11-01 修：第一次发布时挂错了）
 *
 * `session/event` 是在 **agent 自己的 ctx** 上发出的（`dsh-agent-loop` 的
 * `appendToolResult` → agent carrier），不是插件根 ctx。挂在根 ctx 上收不到任何一条，
 * 表现为「插件已加载但永远不叫停」。对照 `dsh-mnemon` 的写法：
 * `this.agent.ctx.on("session/event", ...)`。
 *
 * 现在两条路都接：`agent/created` 给新会话挂载，另外在根 ctx 上也挂一份兜底
 * （Cordis 事件会向父 ctx 冒泡，若宿主版本允许就直接生效）。
 *
 * ## 为什么用 steer 而不是 inject
 *
 * `inject` 只是让人**看见**（面板上的 notice），不改变模型接下来做什么；
 * `steer` 才进收件箱、被下一步 claim。
 *
 * ## 诊断日志
 *
 * `config.debug` 打开时写 `fail-guard.log`（与插件同目录）。这是唯一能看到
 * 「它到底收到事件没有」的地方——Electron 主进程的 console 不在任何我能读的文件里。
 */

import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/** 插件名（cordis 用来定位）。 */
export const name = 'dsh-fail-guard';

/** 需要的服务：`agents` 用于按 sessionId 取 live Agent 句柄。 */
export const inject = ['agents'];

/**
 * 造一条 steer 用的用户消息。
 *
 * 不用 `createUserMessage`（`@deepseek-ai/dsh-llm`）：那个包不在 profile 的
 * node_modules 里，本地插件 import 它会 ERR_MODULE_NOT_FOUND（实测）。
 * 它的实现只是 `createMessage({ ...input, role: 'user' })`，产物字段是
 * `{ content, source, role, id }`——这里照抄同一个形状，零外部依赖。
 */
function userNotice(text, summary) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:fail-guard',
      // form: 'notice' 要求同时给 summary：客户端据此渲染成折叠的 context 行，
      // 而不是一条用户气泡（抄 dsh-repeat-guard 的 resume.ts）。
      form: 'notice',
      summary,
    },
    id: randomUUID(),
  };
}

/**
 * 停手指令正文。四条对应 R3 的四要素，最后一句堵住「换个命令再试」这条路。
 */
const DEFAULT_STOP_TEXT = [
  '连续失败已达阈值，现在停手。按顺序说清四件事：',
  '① 试过什么（命令/参数原样列出）',
  '② 完整错误原文（不要归纳）',
  '③ 初判原因',
  '④ 需要用户做什么',
  '说完就停，不许换命令、换参数、换工具继续试。要查资料先去查，不许拿试错当探索。',
].join('\n');

/** 面板折叠行显示的文字。 */
const DEFAULT_STOP_SUMMARY = '连续失败，已叫停';

/** 配置。volatile 的字段由宿主设置页读写，取值要 `.get()`。 */
export const Config = z.object({
  threshold: z.number().min(1).default(2).volatile(),
  stopText: z.string().default(DEFAULT_STOP_TEXT).volatile(),
  stopSummary: z.string().default(DEFAULT_STOP_SUMMARY).volatile(),
  /** 只在同一工具上累计；关掉则任何工具失败都累加。 */
  sameToolOnly: z.boolean().default(true).volatile(),
  /** 写 fail-guard.log（插件同目录），用来确认事件到底有没有进来。 */
  debug: z.boolean().default(false).volatile(),
  /** 日志文件路径；留空则用插件目录下的 fail-guard.log。 */
  logFile: z.string().default('').volatile(),
});

const DEFAULT_LOG = 'C:/Users/fenri/.dsh/local-plugins/dsh-fail-guard/fail-guard.log';

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  const logPath = () => config.logFile.get() || DEFAULT_LOG;
  const log = (msg) => {
    if (!config.debug.get()) return;
    try {
      appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  };

  log('=== apply() 开始 ===');

  /** sessionId → { tool, count } */
  const streak = new Map();
  /** callId → toolName（tool/result 里没有工具名，只能从 tool/call 记） */
  const callNames = new Map();
  const attached = new Set();

  const isFailure = (data) => {
    const message = data?.message ?? {};
    if (message.isError === true) return true;
    const exitCode = data?.meta?.opsShell?.exitCode;
    if (exitCode === undefined || exitCode === null) return false;
    return exitCode !== 0 && exitCode !== '0';
  };

  const onSessionEvent = (session, event) => {
    const type = event?.type;
    const data = event?.data ?? {};

    if (type !== 'tool/call' && type !== 'tool/result') {
      log(`事件 ${String(type)}（忽略）`);
      return;
    }

    if (type === 'tool/call') {
      if (data.callId && data.name) callNames.set(data.callId, data.name);
      if (callNames.size > 500) callNames.clear(); // 防止长会话无限增长
      log(`tool/call ${data.name} callId=${data.callId}`);
      return;
    }

    const sessionId = session?.id ?? data?.sessionId ?? 'unknown';
    const toolName = callNames.get(data?.message?.toolCallId) ?? 'unknown';
    const failed = isFailure(data);
    log(
      `tool/result session=${sessionId} tool=${toolName} isError=${data?.message?.isError} ` +
        `exit=${JSON.stringify(data?.meta?.opsShell?.exitCode)} → ${failed ? '失败' : '成功'}`,
    );

    if (!failed) {
      streak.delete(sessionId); // 成功一次就清零
      return;
    }

    const sameTool = config.sameToolOnly.get();
    const prev = streak.get(sessionId);
    const next =
      prev && (!sameTool || prev.tool === toolName)
        ? { tool: prev.tool, count: prev.count + 1 }
        : { tool: toolName, count: 1 };
    streak.set(sessionId, next);
    log(`  连续计数 ${next.tool}:${next.count}（阈值 ${config.threshold.get()}）`);

    const threshold = config.threshold.get();
    if (next.count < threshold) return;

    streak.delete(sessionId);

    const agent = ctx.agents.get(sessionId);
    if (!agent || typeof agent.steer !== 'function') {
      log(`  !! 拿不到 agent 或没有 steer：session=${sessionId} agent=${!!agent}`);
      return;
    }

    log(`  >> 叫停 session=${sessionId} tool=${toolName} count=${next.count}`);
    agent.steer(userNotice(config.stopText.get(), config.stopSummary.get()));
  };

  /** 给某个 agent 的 ctx 挂监听（这才是 session/event 真正发出的地方）。 */
  const attach = (agent) => {
    if (!agent?.id || attached.has(agent.id)) return;
    if (!agent.ctx || typeof agent.ctx.on !== 'function') {
      log(`attach 失败：agent ${agent?.id} 没有 ctx.on`);
      return;
    }
    attached.add(agent.id);
    agent.ctx.on('session/event', onSessionEvent);
    log(`attached agent ${agent.id}`);
  };

  // 1) 新会话：agent/created 时挂载
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent ?? payload;
    log(`agent/created ${agent?.id}`);
    attach(agent);
  });

  // 2) 不再在根 ctx 上挂 session/event。
  //    2026-11-01 实测：根 ctx 和 agent.ctx 两处都会收到同一个事件
  //    （Cordis 事件向父 ctx 冒泡），日志里每条都出现两次 →
  //    连续计数直接翻倍，一次失败就凑够阈值 2。
  //    只保留 agent.ctx 那一路（attach 里挂的），根 ctx 这条必须没有。
  log('根 ctx 不挂 session/event（避免与 agent.ctx 重复计数）');

  // 3) 已经活着的会话（插件热加载/重启后不会再有 agent/created）
  try {
    const list = ctx.agents?.list?.();
    if (Array.isArray(list)) {
      log(`现存 agent ${list.length} 个`);
      for (const a of list) attach(a);
    } else {
      log('ctx.agents.list() 不可用，跳过现存会话挂载');
    }
  } catch (err) {
    log(`枚举现存 agent 失败：${err && err.message}`);
  }

  log('=== apply() 结束 ===');
}
