# 设计参考

以下项目只提供设计思路，无直接代码复制、无运行时依赖。

- [dsh-loop-breaker](https://github.com/chip-philo-gh/dsh-loop-breaker/blob/df773eb/lib/index.js#L268-L295)：每轮限定自动续跑次数；本项目默认关闭自动续跑。
- [dsh-attention-health](https://github.com/donghangxunlang-cmd/dsh-attention-health/blob/eb1be7b/lib/guard.js#L10-L26)：用相同行识别循环；本项目不采集历史、不全轮取消。
- [dsh-repetition-guard](https://github.com/aclypea/dsh-repetition-guard/blob/5a58501/lib/repetition-guard.js#L151-L213)：区分正文和思考、使用有界检测；本项目只检测封行后的思考内容。
- [dsh-dupguard](https://github.com/zqh260619/dsh-dupguard/blob/8b19dd4/lib/engine.js#L173-L208)：参考尾部重复匹配的取舍；本项目不采用通用周期匹配。
