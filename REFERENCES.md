# Design Reference

The following projects only provide design ideas, with no direct code copy or runtime dependencies.

- [dsh-loop-breaker](https://github.com/chip-philo-gh/dsh-loop-breaker/blob/df773eb/lib/index.js#L268-L295)：Each round limits the number of auto-runs; auto-run is turned off by default in my project.
- [dsh-attention-health](https://github.com/donghangxunlang-cmd/dsh-attention-health/blob/eb1be7b/lib/guard.js#L10-L26)：Use the same row to identify loops; my project doesn't collect history or fully cancel cycles.
- [dsh-repetition-guard](https://github.com/aclypea/dsh-repetition-guard/blob/5a58501/lib/repetition-guard.js#L151-L213)：Distinguish between the main text and thinking, using bounded detection; my project only checks the thinking content after it’s finalized.
- [dsh-dupguard](https://github.com/zqh260619/dsh-dupguard/blob/8b19dd4/lib/engine.js#L173-L208)：Refer to the trade-offs of repeating matches at the tail; my project doesn't use general cycle matching.
