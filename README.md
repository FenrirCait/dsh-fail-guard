# dsh-fail-guard

English | [中文](README.zh.md)

Stops the agent when it keeps failing on the same tool: after N consecutive failures it pushes a four-part stop instruction (what it tried / the full error text / the first guess at why / what you need to do) so it reports instead of trying a fourth way to spell the same command.

## Why it has to come from outside

Repeated short lines in reasoning ("Do it. Do it.") are usually not model degradation — they are the residue of **consecutive failure**: the same thing fails, the parameters change, it fails again, nothing new comes in, so the same "time to act" decision gets re-made over and over.

Prompt-level rules ("stop after two consecutive failures") do not work in that state — **the model is not reading the prompt then, it is reading its own thinking.** The interruption has to come from outside.

Measured on a 74-turn session: turns 1–67 kept the share of short single-line fragments between 7% and 48%; the moment a task hit a dozen consecutive failed steps it jumped to 81.6%, then 85.9% / 89.1% / 91.4%.

## Install

```sh
dsh plugin --profile desktop add dsh-fail-guard
```

Restart once. `cordis.patch.yml` is applied through the `dsh.bundle` manifest — no need to edit your profile config.

## Configuration

Edit it in **Plugins → dsh-fail-guard → details**. Fields are marked `.volatile()`: **saving takes effect immediately, no restart.**

| Key | Default | Meaning |
| --- | --- | --- |
| `threshold` | `2` | Consecutive failures before stopping |
| `sameToolOnly` | `true` | Count per tool; turn off to share one counter across all tools |
| `stopText` | built in | The instruction pushed into the conversation |
| `stopSummary` | built in | The one-line summary shown in the panel |
| `debug` | `false` | Write events, counts and trips to a log file |
| `logFile` | `<plugin dir>/fail-guard.log` | Where `debug` writes |

Or set it directly in `cordis.patch.yml`:

```yaml
- id: dsh-fail-guard
  config:
    threshold: 3
```

## What counts as a failure

A `tool/result` counts if either holds: `message.isError === true`, or `meta.opsShell.exitCode` exists and is non-zero. Both are needed — a shell command exiting 1 is not marked `isError`, and some tool-level errors carry no exit code. Counters are per session and per tool, and any success resets them.

## Limits

- It does not abort the call that just failed — that already happened
- It does not judge whether a failure is "real"; any non-zero exit counts
- It does not reset the conversation; the stop instruction is just one more user message
- It is not a rate limiter: after a trip, further failures start counting again and will trip again at the threshold

## License

MIT
