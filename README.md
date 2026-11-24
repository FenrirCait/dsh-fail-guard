# dsh-fail-guard

[中文](README.zh.md)

Standalone DeepSeek Harness protection against repeated tool failures and repetitive reasoning. One installation, one Cordis entry, one configuration form. Neither legacy guard is required.

## Install from dshmarket

Use the existing **FenrirCait/dsh-fail-guard** entry in dshmarket and subscribe/install it. Follow the market's reload or restart prompt for the selected DSH profile. No second guard package or manual Cordis configuration is needed.

The generated catalog currently maps this entry to the prebuilt npm package. Its install command is:

```sh
dsh plugin --profile desktop add dsh-fail-guard
```

A new release must also be published to that npm package for the mapped market subscription to receive it; pushing Git alone does not update the npm distribution. When using the GitHub source directly instead:

```sh
dsh plugin --profile desktop add github:FenrirCait/dsh-fail-guard
```

This repository includes prebuilt host and browser files in `lib/`; subscribers do not need to run a build or install development dependencies. Keep those generated files in the Git commit when preparing an update. The package declares its single Cordis entry through `dsh.bundle.patch`. Verified host baseline: DSH 0.2.2-rc.5; other versions within the declared peer ranges have not all been tested.

## Settings

Open **Plugins → dsh-fail-guard → Details**. The new entry is `dsh-fail-guard-standalone`; older settings are not loaded or migrated.

- Tool failure: enabled by default. Three consecutive matched failures by the same tool in one turn trigger a notice, not a forced cancellation.
- Repetition: enabled by default. Five consecutive matching eligible reasoning lines within a block can cut a stream. It does not rewrite answer text.
- Automatic resume: off by default. When enabled, at most one resume is requested per turn, and it never overrides a failure notice.

Observe-only mode is off by default. When enabled, detections appear in the turn footer without cutting the stream, steering the model, or requesting a resume. The footer records only the turn, rule, count and action. Streams with more than 64 active blocks are passed through without further checks.

### Short-fragment observation (experimental)

Under **Experimental features**, enable the short-fragment experiment and save. It is off by default and independent of both the existing repetition guard and its observe-only mode. Dense repeated fragments, including alternating, cross-block, and run-on fragments, can produce one counter-only summary per turn. The experiment never steers, cuts, resumes, saves text or hashes, or writes an automatic diagnostic report.

This rule is for calibration, not comprehensive loop detection. Overlong lines or excess active blocks stop observation without changing the stream. A line without a newline is evaluated when its reasoning block closes. Self-check still covers the two original guards only.

### Other experiments

All four switches default to off and are independent. Fuzzy repetition observes nearby, nearly identical complete reasoning lines. Cross-turn failure counts adjacent failed turns for the same tool and arguments, within a two-minute window; success, a changed operation, or missing evidence breaks the streak. Simulated stop only records repeated failures in one turn and never cancels a call or turn. Active steering queues at most one guide after an existing exact repetition cut; observe-only suppresses it, and legacy automatic resume takes precedence. Queued does not mean delivered or recovered. Experimental summaries contain no raw arguments or operation fingerprints.

### Local feedback

In a completed turn, open **Guard diagnostics → Mark guard feedback** and select one rule. A recorded hit can be marked correct or as a false positive. A rule with no available hit record can be reported as a false negative; that does not establish whether the rule was enabled or ran, and any enablement answer is self-reported. Preview the JSON, optionally omit the exporting plugin version and recorded count/action, and explicitly download it to decide whether to share. The feedback file does not contain conversation content, session identifiers, or notes. No automatic upload; the existing manual and automatic diagnostic formats are unchanged.

## Evaluate or roll back

Use DSH 0.2.2-rc.5 and a sandbox profile. Back up its package manifest, lockfile and profile patch. Install the local archive with `dsh plugin --profile sandbox add <archive.tgz>` and restart that profile. Do not run the standalone legacy repeat package alongside it. To roll back, reinstall the previous archive, restore the sandbox configuration snapshot if changed, and restart.

Build with Node.js 24: `npm ci`, `npm test`, `npm pack`. See [design references](REFERENCES.md).
