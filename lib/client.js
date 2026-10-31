/**
 * dsh-fail-guard 的插件管理页配置卡。
 *
 * 走 `plugins.bundle.config` 这个 slot——它把卡片内嵌在「插件 → 详情」里，
 * 和 `dsh-session-leftover-purge` 是同一套写法，比 `settings` 那套轻：
 * 不用打包工具，`jsx()` 手写，产物就是一个 `window.__ModuleLoader__.load`。
 *
 * 配置读写全部经由 `ctx.configForms.get(NS)` 的 scope：
 *   scope.getSnapshot()  → { value: {...} }
 *   scope.subscribe(fn)  → 返回取消订阅函数
 *   scope.set(key, val)  → Promise<boolean>，false 表示被部署拒绝
 *
 * NS 必须与 cordis.patch.yml 里本插件的条目 id 逐字一致，否则拿不到配置。
 */

window.__ModuleLoader__.load({
  id: 'dsh-fail-guard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const { jsx, jsxs } = require('react/jsx-runtime');
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

const NS = 'dsh-fail-guard';

/** 与 index.js 的 Config .default(...) 保持一致；「恢复默认」按这张表回填。 */
const DEFAULTS = {
  threshold: 2,
  sameToolOnly: true,
  debug: false,
  logFile: '',
  stopSummary: '连续失败，已叫停',
  stopText:
    '连续失败已达阈值，现在停手。按顺序说清四件事：① 试过什么（命令/参数原样列出）② 完整错误原文（不要归纳）③ 初判原因 ④ 需要用户做什么。说完就停，不许换命令、换参数、换工具继续试。要查资料先去查，不许拿试错当探索。',
};

const BOOLS = [
  { key: 'sameToolOnly', label: '只按同一工具累计', hint: '关掉则任何工具的失败都累加到同一个连续计数里' },
  { key: 'debug', label: '写诊断日志', hint: '把每个事件、每次计数、每次叫停写进日志文件；关掉不影响判定' },
];

const NUMBERS = [
  { key: 'threshold', label: '连续失败次数', hint: '同一工具连续失败几次后叫停。1 表示失败即叫停', min: 1 },
];

const TEXTS = [
  { key: 'stopSummary', label: '折叠行摘要', hint: '注入段在界面上显示的一行摘要' },
  { key: 'logFile', label: '日志路径', hint: '留空则用插件目录下的 fail-guard.log' },
];

const AREAS = [
  {
    key: 'stopText',
    label: '停手指令正文',
    hint: '被推给模型的那条指令。改成四要素之外的内容也可以，但越具体越好用',
    rows: 6,
  },
];

const ALL_KEYS = [...BOOLS, ...NUMBERS, ...TEXTS, ...AREAS].map((f) => f.key);

const labelStyle = { fontSize: 14, lineHeight: 1.5 };
const hintStyle = { fontSize: 12, opacity: 0.62, marginTop: 2, lineHeight: 1.6 };
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '10px 0',
  borderBottom: '1px solid rgba(128,128,128,.18)',
};
const stackStyle = Object.assign({}, rowStyle, { flexDirection: 'column', alignItems: 'stretch', gap: 8 });
const inputStyle = {
  width: 140,
  padding: '6px 10px',
  fontSize: 14,
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,.35)',
  background: 'transparent',
  color: 'inherit',
  outline: 'none',
};
const wideInputStyle = Object.assign({}, inputStyle, { width: '100%', boxSizing: 'border-box' });
const areaStyle = Object.assign({}, wideInputStyle, {
  minHeight: 108,
  resize: 'vertical',
  fontFamily: 'inherit',
  lineHeight: 1.6,
});
const buttonStyle = {
  padding: '7px 18px',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,.4)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
};
const primaryStyle = Object.assign({}, buttonStyle, {
  background: '#4d6bfe',
  borderColor: '#4d6bfe',
  color: '#fff',
});

function TextRow(props) {
  const { label, hint, value, wide, multiline, rows, onCommit } = props;
  const [text, setText] = React.useState(value === undefined || value === null ? '' : String(value));
  React.useEffect(() => {
    setText(value === undefined || value === null ? '' : String(value));
  }, [value]);
  const commit = () => {
    const next = text;
    if (next !== (value === undefined || value === null ? '' : String(value))) onCommit(next);
  };
  const tag = multiline ? 'textarea' : 'input';
  const style = multiline ? areaStyle : wide ? wideInputStyle : inputStyle;
  const nodeProps = multiline
    ? { value: text, rows: rows === undefined ? 6 : rows, style, onChange: (e) => setText(e.target.value), onBlur: commit }
    : {
        type: 'text',
        value: text,
        style,
        onChange: (e) => setText(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        },
      };
  const head = jsxs('div', {
    style: { flex: 1, minWidth: 0 },
    children: [
      jsx('div', { style: labelStyle, children: label }),
      hint ? jsx('div', { style: hintStyle, children: hint }) : null,
    ],
  });
  // 满宽输入框（wide）不能跟标签并排：input 的 width:100% 会把标签挤到零宽，
  // 中文就逐字换行（实测就是竖排）。所以 wide 也走上下布局。
  const stacked = multiline || wide;
  return jsxs('div', {
    style: stacked ? stackStyle : rowStyle,
    children: [head, jsx(tag, nodeProps)],
  });
}

function BoolRow(props) {
  const { label, hint, checked, onToggle } = props;
  return jsxs('div', {
    style: rowStyle,
    children: [
      jsxs('div', {
        style: { flex: 1, minWidth: 0 },
        children: [
          jsx('div', { style: labelStyle, children: label }),
          hint ? jsx('div', { style: hintStyle, children: hint }) : null,
        ],
      }),
      jsx(primitives.Switch, { checked, label, onChange: onToggle }),
    ],
  });
}

function NumberRow(props) {
  const { label, hint, value, min, onCommit } = props;
  const [text, setText] = React.useState(value === undefined || value === null ? '' : String(value));
  React.useEffect(() => {
    setText(value === undefined || value === null ? '' : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      setText(value === undefined || value === null ? '' : String(value));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < (min === undefined ? 0 : min)) {
      setText(value === undefined || value === null ? '' : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return jsxs('div', {
    style: rowStyle,
    children: [
      jsxs('div', {
        style: { flex: 1, minWidth: 0 },
        children: [
          jsx('div', { style: labelStyle, children: label }),
          hint ? jsx('div', { style: hintStyle, children: hint }) : null,
        ],
      }),
      jsx('input', {
        type: 'number',
        min: min === undefined ? 0 : min,
        value: text,
        style: inputStyle,
        onChange: (e) => setText(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        },
      }),
    ],
  });
}

function FailGuardCard(props) {
  const scope = props.scope;
  const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [messageIsError, setMessageIsError] = React.useState(false);

  React.useEffect(() => {
    if (typeof scope.subscribe !== 'function') return undefined;
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()));
  }, [scope]);

  const saved = (snapshot && snapshot.value) || {};
  const current = draft === null ? saved : draft;
  const changed = draft === null ? [] : ALL_KEYS.filter((key) => draft[key] !== saved[key]);
  const dirty = changed.length > 0;

  const note = (text, isError) => {
    setMessage(text);
    setMessageIsError(isError === true);
  };
  const edit = (key, value) => {
    note('', false);
    setDraft(Object.assign({}, current, { [key]: value }));
  };
  const resetToDefaults = () => {
    note('', false);
    const next = Object.assign({}, current);
    for (const key of ALL_KEYS) next[key] = DEFAULTS[key];
    setDraft(next);
  };
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    note('', false);
    try {
      for (const key of changed) {
        const ok = await scope.set(key, draft[key]);
        if (ok === false) throw new Error(`「${key}」被本部署拒绝`);
      }
      setDraft(null);
      note(`已保存 ${changed.length} 项`, false);
    } catch (error) {
      note(`保存失败：${String(error && error.message ? error.message : error)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return jsxs('div', {
    style: { padding: '4px 0 8px' },
    children: [
      ...BOOLS.map((f) =>
        jsx(
          BoolRow,
          {
            label: f.label,
            hint: f.hint,
            checked: current[f.key] === true,
            onToggle: (next) => edit(f.key, next),
          },
          f.key,
        ),
      ),
      ...NUMBERS.map((f) =>
        jsx(
          NumberRow,
          { label: f.label, hint: f.hint, min: f.min, value: current[f.key], onCommit: (next) => edit(f.key, next) },
          f.key,
        ),
      ),
      ...TEXTS.map((f) =>
        jsx(
          TextRow,
          { label: f.label, hint: f.hint, wide: true, value: current[f.key], onCommit: (next) => edit(f.key, next) },
          f.key,
        ),
      ),
      ...AREAS.map((f) =>
        jsx(
          TextRow,
          {
            label: f.label,
            hint: f.hint,
            multiline: true,
            rows: f.rows,
            value: current[f.key],
            onCommit: (next) => edit(f.key, next),
          },
          f.key,
        ),
      ),
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' },
        children: [
          jsx('button', {
            type: 'button',
            onClick: save,
            disabled: !dirty || busy,
            style:
              !dirty || busy
                ? Object.assign({}, primaryStyle, { opacity: 0.45, cursor: 'not-allowed' })
                : primaryStyle,
            children: busy ? '保存中…' : '保存',
          }),
          jsx('button', {
            type: 'button',
            onClick: resetToDefaults,
            disabled: busy,
            style: buttonStyle,
            children: '恢复默认',
          }),
          dirty
            ? jsx('span', { style: { fontSize: 12, opacity: 0.65 }, children: `${changed.length} 项未保存` })
            : null,
          message
            ? jsx('span', {
                style: { fontSize: 12, color: messageIsError ? '#d9534f' : '#3aa657' },
                children: message,
              })
            : null,
        ],
      }),
      jsx('p', {
        style: { fontSize: 12, opacity: 0.55, marginTop: 12, lineHeight: 1.6 },
        children:
          '这些字段标了 .volatile()，保存后立即生效，不用重启。' +
          '「恢复默认」只是把草稿填回默认值，点保存才真正写入。',
      }),
    ],
  });
}

const inject = ['slots', 'locale', 'configForms'];

function apply(ctx) {
  const scope = ctx.configForms.get(NS);
  ctx.effect(
    () =>
      ctx.configForms.whileServed([NS], () =>
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-fail-guard', inject: () => ({ scope }) },
            FailGuardCard,
          ),
        ),
      ),
    'fail-guard: page',
  );
}

    Object.assign(exports, { NS, apply, inject, FailGuardCard, DEFAULTS });
    return module.exports;
  },
});
