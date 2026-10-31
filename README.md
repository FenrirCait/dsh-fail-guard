# dsh-fail-guard

English | [中文](README.zh.md)

Stops the agent when it keeps failing.

After N consecutive failures on the same tool, it pushes a four-part stop instruction into the
conversation — what you tried, the exact error text, the first guess at why, what you need from
the user — so the agent reports instead of trying a fourth variation of the same command.

## What it actually treats

Thinking-loop repetition ("做。做。做。", "Let me… Let me…") usually is not model degradation.
It is **consecutive trial and error**: the same thing fails, the parameters change, it fails
again, no new information arrives, and the same "time to act" decision gets re-made over and over.

Measured on one 74-turn session (2026-10-30): short-phrase line share stayed in the 7–48% band
for 67 turns, then jumped to 81.6% the moment a browser-scrolling task started failing repeatedly,
and stayed at 85.9% / 89.1% / 91.4% afterwards.

A prompt-level rule ("stop after two consecutive failures") does not work in that state, because
the model is not reading the prompt at that moment — it is reading its own thinking. The
interruption has to come from outside. That is what this plugin does.

## Install

```sh
dsh plugin --profile desktop add dsh-fail-guard
```

Restart DSH once. `cordis.patch.yml` is applied automatically through the `dsh.bundle` manifest.

## Configuration

**There is no settings panel for this plugin, and that is expected.** DSH renders a
configuration form only for plugins that ship a `dsh.client` bundle (a client-side module);
`dsh-fail-guard` is a server-side plugin only, so its detail page shows just the enable switch,
the version and the source. Edit `cordis.patch.yml` instead — the fields are `.volatile()`, so a
change is hot-reloaded and needs no restart.

All options have defaults; the plugin works with an empty config.

| Key | Default | Meaning |
| --- | --- | --- |
| `threshold` | `2` | Consecutive failures before the stop instruction is pushed. |
| `sameToolOnly` | `true` | Count failures per tool. `false` counts any failure toward the same streak. |
| `stopText` | built in | The instruction that gets pushed. Override to change the wording. |
| `stopSummary` | built in | One-line summary shown in the panel notice. |
| `debug` | `false` | Write every event, count and trip to a log file. |
| `logFile` | `<plugin dir>/fail-guard.log` | Where `debug` writes. The Electron main-process console is not readable from anywhere, so a file is the only way to see what the plugin actually received. |

Override in `cordis.patch.yml`:

```yaml
- id: dsh-fail-guard
  config:
    threshold: 3
    sameToolOnly: true
```

## How failure is detected

A `tool/result` counts as a failure when either is true:

- `message.isError === true`
- `meta.opsShell.exitCode` is present and non-zero

Both are checked because neither is complete on its own: a shell command that exits 1 is not
marked `isError`, and some tool-level errors carry no exit code.

The counter is per session and per tool, and clears on any success.

## Why `steer` and not `inject`

`inject` only shows a notice in the panel — it does not change what the model does next.
`steer` enters the inbox and is claimed by the next step. This is the same interface choice
`dsh-huanqi` documents.

## What it does not do

- It does not stop the tool call that just failed — that already happened.
- It does not judge whether a failure was "real"; any non-zero exit counts.
- It does not reset the conversation. The stop instruction is one extra user turn, nothing more.
- It is not a rate limiter. If the agent keeps failing after the instruction, the streak restarts
  and it will be stopped again `threshold` failures later.

## License

MIT
