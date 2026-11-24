# dsh-fail-guard · 独立实现

一个 npm 包、一个 Cordis 条目 dsh-fail-guard-standalone、一个详情页。旧配置不读取、不迁移；1.0.0 为正式版候选；预构建 lib 随 Git 仓库分发，市场订阅不要求用户构建。保留旧工程与旧压缩包。

## 接口约定

- src/options.ts 共享 ENTRY_ID、PACKAGE_NAME、DEFAULTS、LIMITS。配置均为扁平 volatile：failureEnabled=true、failureLimit=3（2–12）、repeatEnabled=true、repeatLimit=5（3–15）、resumeOnRepeat=false。开启续跑后，每轮最多一次。
- src/failure/index.ts 导出 createFailureTracker()，包含 call(id,tool,turn,step)、result(id,turn,step,failed,limit): string|null、clear()、clearPending()。宿主按 agent 会话维持实例，匹配真实事件、忽略历史替换、每轮至多一次通知。
- src/repetition/index.ts 导出 guardReasoning(source,limit,onCut)。仅检查完整思考行，匹配连续相同的短行；放过空行、纯标点和明显结构行。隔离块索引；只有同块非空续写、且无其他活动块时才截断，不改正文、不记录思考文本，正常结束与关闭协议有测试。
- src/client/index.tsx 导出 apply/inject，只注册 plugins.bundle.config，按包名索引。新配置条目使用单次原子保存，拒绝时保留草稿，支持只读和加载状态。
- test 下按模块单测；构建产生 lib，浏览器依赖来自宿主。参考插件只借鉴机制，不复制代码，不设运行依赖。

## 验收

归档仅包含一个 Cordis 入口；两个引擎用合成事件单独验收。运行编译、构建、测试、同场景性能基准及独立复审；通过后仅在固定 sandbox 测试不迁移、恢复旧包，再留新版人工检查。正式环境、GitHub 和 npm 不动。
