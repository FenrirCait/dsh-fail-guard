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
 * 监听 `session/event`，记下每个 `tool/call` 的 callId→工具名，
 * 再看每个 `tool/result` 是不是失败（`message.isError` 或 `meta.opsShell.exitCode !== 0`）。
 * 同一个会话里**同一工具**连续失败达到 `threshold` 次，就用 `agent.steer()`
 * 推一条停手指令进去——那是一条真正的用户消息，会进下一步被模型读到。
 *
 * ## 为什么用 steer 而不是 inject
 *
 * `inject` 只是让人**看见**（面板上的 notice），不改变模型接下来做什么；
 * `steer` 才进收件箱、被下一步claim。这一点是 dsh-huanqi 的注释先说清的，
 * 这里照抄同一个接口用法。
 *
 * ## 依赖如何解析
 *
 * `@deepseek-ai/*` 声明在 peerDependencies，由宿主从安装目录软链进 profile
 * （dsh-app-boot 的 healProfileModuleFallback）。所以本地插件不需要自己装它们。
 *
 * ## postmortem 0001 的约束
 *
 * 不写 `export default apply`——Loader 的 `unwrapExports` 会取 `default ?? exports`，
 * 把整个命名空间丢掉，`inject` / `Config` 全没了。这里导出具名 `Config` + `apply`。
 */

import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';

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
      kind: 'plugin:stall-guard',
      // form: 'notice' 要求同时给 summary：客户端据此渲染成折叠的 context 行，
      // 而不是一条用户气泡（抄 dsh-repeat-guard 的 resume.ts）。
      form: 'notice',
      summary,
    },
    id: randomUUID(),
  };
}

/** 插件名（cordis 用来定位）。 */
export const name = 'dsh-fail-guard';

/** 需要的服务：`agents` 用于按 sessionId 取 live Agent 句柄。 */
export const inject = ['agents'];

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
  /** 计数口径说明：每次 steer 之后该会话的计数清零。 */
  debug: z.boolean().default(false).volatile(),
});

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof Config>} config
 */
export function apply(ctx, config) {
  console.log('[fail-guard] 已加载，连续失败停手生效');

  /** sessionId → { tool, count } */
  const streak = new Map();
  /** callId → toolName（tool/result 里没有工具名，只能从 tool/call 记） */
  const callNames = new Map();

  const isFailure = (data) => {
    const message = data?.message ?? {};
    if (message.isError === true) return true;
    const exitCode = data?.meta?.opsShell?.exitCode;
    if (exitCode === undefined || exitCode === null) return false;
    return exitCode !== 0 && exitCode !== '0';
  };

  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    const data = event?.data ?? {};

    if (type === 'tool/call') {
      if (data.callId && data.name) callNames.set(data.callId, data.name);
      if (callNames.size > 500) callNames.clear();      // 防止长会话无限增长
      return;
    }

    if (type !== 'tool/result') return;

    const sessionId = session?.id;
    if (!sessionId) return;

    const toolName = callNames.get(data?.message?.toolCallId) ?? 'unknown';

    if (!isFailure(data)) {
      streak.delete(sessionId);                          // 成功一次就清零
      return;
    }

    const sameTool = config.sameToolOnly.get();
    const prev = streak.get(sessionId);
    const next =
      prev && (!sameTool || prev.tool === toolName)
        ? { tool: prev.tool, count: prev.count + 1 }
        : { tool: toolName, count: 1 };
    streak.set(sessionId, next);

    if (config.debug.get()) {
      console.log(
        `[fail-guard] 失败 callId=${data?.message?.toolCallId} tool=${toolName} ` +
          `prev=${prev ? prev.tool + ':' + prev.count : 'none'} → ${next.tool}:${next.count}`,
      );
    }

    const threshold = config.threshold.get();
    if (next.count < threshold) return;

    streak.delete(sessionId);

    if (config.debug.get()) {
      console.log(`[fail-guard] 会话 ${sessionId} 工具 ${toolName} 连续失败 ${next.count} 次，叫停`);
    }

    const agent = ctx.agents.get(sessionId);
    if (!agent || typeof agent.steer !== 'function') return;

    agent.steer(userNotice(config.stopText.get(), config.stopSummary.get()));
  });
}
