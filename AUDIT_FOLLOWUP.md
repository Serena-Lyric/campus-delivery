# AUDIT_FOLLOWUP

> 本文件记录代码审核后确认的待修正项。它不创造新的产品规则；修复时仍以 `PRODUCT_DECISIONS.md`、`EXCEPTION_HANDLING.md` 和 `ROLE_RESPONSIBILITIES.md` 为准。

## 1. 每日未取餐无责取消必须真正封顶

当前 `cancelBeforePickup()` 会在达到 `riderDailyFreeCancelLimit` 时触发 warning / 当日暂停新接单，但不会拒绝该骑手对**暂停前已经持有的其他未取餐订单**继续调用同一“无责取消”入口。

这与已确认的“第一版每个自然日最多 2 次未取餐无责取消（配置化）”不一致。

修复要求：

- `riderDailyFreeCancelLimit` 不只是 warning 触发点，也是 responsibility-free cancel 的每日使用上限。
- 当日已使用次数达到配置上限后，再次调用 pre-pickup responsibility-free cancellation 必须拒绝。
- 当日暂停仍然只禁止**新 claim**，不得自动终止或破坏骑手已经持有的其他订单。
- 对“已持有但免费取消额度已经用完”的订单，本轮不要自行发明新的免责退出路径；免费取消 API 拒绝即可，后续异常退出规则由产品继续设计。
- 增加回归测试：骑手在触发第 2 次 warning 前已经持有第 3 个订单，第 3 次调用无责取消必须失败，而该订单本身仍保持原持有状态。
- 配置值变化后逻辑仍成立，不得硬编码 `2`。

## 2. ExceptionCase 需要完整的状态迁移保护

当前 case ownership 操作虽然使用 CAS/version，但多个入口缺少“当前状态是否允许该动作”的 guard。

已确认风险包括：

- `RESOLVED` case 仍可能被 release 回 `OPEN`；
- `RESOLVED` case 仍可能被 transfer / takeover / escalate 改回工作状态；
- `ESCALATED` 后原普通管理员仍可能继续执行 resolve，削弱“升级给超级管理员”的语义；
- 已解决 case 缺少统一 terminal-state 保护。

修复要求：

- 为 ExceptionCase 建立显式 transition guard / state machine，不能只依赖 version。
- 第一版 `RESOLVED` / `CLOSED` 视为终态；除非以后产品明确设计“重新打开”，当前不得通过 release/transfer/takeover/escalate/普通 resolve 等入口重新进入工作状态。
- `ESCALATED` 表示普通管理员已经把案件升级到超级管理员处理；OPERATOR 在该状态下不得继续执行普通 resolution/economic action。
- SUPER_ADMIN 可以 takeover/处理 ESCALATED case，但不能绕过审计。
- release / transfer / takeover / escalate / non-economic resolve / economic resolve 都必须验证合法来源状态。
- 增加状态矩阵测试，至少覆盖：resolved → release/transfer/takeover/escalate 全部拒绝；escalated → operator resolve/refund 拒绝；super admin 合法接管后可继续。

## 3. 退款/赔付经济动作必须同时具备幂等、version 与状态前置条件

当前 `POST /admin/exception-cases/:caseId/resolve` 接受 `expectedVersion`，但当 `resolutionType=REFUND_AND_CLOSE` 时实际调用的 `refundAndCloseExceptionCase()` 没有使用该 expectedVersion，也没有在写入赔付义务前拒绝已经通过其他方式解决的 case。

因此可能出现：管理员打开旧版本 case → 用户随后接受 remake，使 case 变为 `REMAKE_AND_CONTINUE / RESOLVED` → 管理员仍用旧页面执行 refund-and-close，产生赔付/退款事实。

骑手的 `/exception-cases/:caseId/voluntary-compensation` 也必须防止已经 RESOLVED/CLOSED 的 case 被再次改写；骑手主动原价赔付目前只确认用于严重餐损/丢失场景，不应成为任意异常 case 的通用覆写入口。

修复要求：

- admin refund-and-close 必须实际校验 `expectedVersion`，并在任何经济写入前验证当前 case 状态允许该动作。
- 同一事务内完成：case row/version/status precondition → obligation/ledger reservation → refund fact → case resolution。
- 幂等 key 继续保留；“有 idempotency”不能替代 version/status guard。
- rider voluntary compensation 必须拒绝 RESOLVED/CLOSED case，并限制在产品已确认允许骑手主动赔付的严重餐损/丢失流程或其他以后明确允许的状态。
- 已经 `REMAKE_AND_CONTINUE` 的 case 不能被 stale refund 或 voluntary compensation 覆写；如果 remake 后再次发生异常，应创建新的异常事实/case，而不是改写原 case。
- 增加并发/陈旧页面测试：
  - customer accept remake 后，旧 expectedVersion 的 admin refund 必须失败；
  - resolved remake 后 rider voluntary compensation 必须失败；
  - 相同 refund request 的真正重试仍保持幂等，只生成一份 obligation/refund。

## 4. 报告真实性修正

上一轮 `CODEX_REPORT.md` 把 refund/freeze/close 概括为“case row lock + unique idempotencyKey + transaction”，并在审核项中归入“高风险动作幂等/版本保护”。

实际代码只有部分动作具备 version/status precondition。因此后续报告必须逐个业务分支核对：

- 请求是否携带 expectedVersion；
- service 是否真的使用 expectedVersion；
- 是否检查合法当前状态；
- 幂等保护解决的是重复执行还是陈旧状态执行；
- terminal state 是否能被其他入口重新打开。

不能因为同一个 route schema 里存在 `expectedVersion`，就声称所有分支都受 version 保护。
