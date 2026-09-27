# AUDIT_SECOND_PASS_2026-09-27

> 审核对象：`9b648de3845355ee383ae0fb477a6207d5884969`（`fix: close audited safety and consistency gaps`）及报告提交 `e36c0ca98302b83a4b3fac6b300216e21297e17c`。
> 结论：上一轮 `CODEX_TASK.md` 的 1–12 项绝大多数已经在真实 runtime/test 中得到支持，但第二遍按“所有入口、所有状态组合、所有角色”继续审核后仍发现以下缺口，因此 **本轮仍未验收通过，`CODEX_REPORT.md` 暂不删除**。
> 本文件只记录能够依据现有产品决策确定的问题；商家初始配送费真实结算语义、严重失败订单的 rider base payout 是否 earned 等仍待产品/真实运营确认，不在本轮擅自决定。

## 1. 已确认本轮真正修好的部分

以下内容已从 runtime 代码确认，不只是报告自述：

- 默认 `platformCommissionBps=0`，新安全 migration 只中性化当前 active 配置，不再把未确认 5% 佣金当业务默认。
- 非零 rider-entered `voluntaryPaymentMinor` 会在形成 ledger/funding 事实前被拒绝。
- `releaseCompensationReservations()` 不再把 release 等同于 write-off；释放 reservation 后相应增加 platform advance/outstanding，obligation 保持未结。
- remake participant action 已纳入状态 guard，ESCALATED 不能被普通 rider/customer 直接覆写。
- ESCALATED case 可以由 Super Admin A 分配给 Super Admin B，不能直接分给 OPERATOR。
- capacity history 有新增 migration 基于明确 completed assignment/task/delivered order 回填。
- exception classifier 有 safe fallback，deterministic route suggestion 默认 OPERATOR_POOL。
- item classifier 已移出订单写 transaction；写事务重新校验商品事实。
- rider order-pool 不再混用 live merchant/location name 与历史地点 snapshot。
- “奶油蛋糕” deterministic fallback 关键词优先级已修正。
- 文档已明确 merchant initial delivery amount 真实资金语义仍待 W/真实运营验证；当前 reference-only runtime 只是 provisional。

Codex 报告中的 typecheck/unit/integration/build/migration/seed 结果属于本地执行自报；GitHub implementation commit 当前没有独立 CI status，因此审核不把本地报告等同于独立 CI 验证。

## 2. P0：通用异常入口可绕过严重餐损/丢失专用入口约束

### 事实

`POST /rider/orders/:orderId/severe-exception` 正确限制：

- 仅责任骑手；
- 仅 `SEVERE_FOOD_DAMAGE / FOOD_LOST`；
- 必须已经实际 PICKED_UP。

但通用 `POST /orders/:orderId/exceptions` 仍接受整个 `ExceptionType` 枚举，并直接调用 `createExceptionEvent()`；后者没有对 severe 类型执行同样的角色/阶段约束。

因此订单相关参与者可以绕过 dedicated severe route，在不合法阶段创建 `SEVERE_FOOD_DAMAGE / FOOD_LOST` case。

### 修复要求

- severe damage/loss 的业务入口约束必须集中或等价执行，不能由通用 route 绕过。
- 最小方案可以是在通用 exception route 明确拒绝 severe self-report 类型，要求责任骑手使用 dedicated route；或在 service 层统一 severe actor/stage guard。
- 用户后续投诉严重问题可使用既有投诉/争议类型进入人工处理，不应伪造“责任骑手取餐后主动上报 severe incident”的事实。
- 增加负向测试：通用 endpoint 不能在错误角色/阶段创建 severe case；dedicated rider-after-pickup 正常路径仍工作。

## 3. P0：严重餐损/丢失可被通用 `CONTINUE_FULFILLMENT` 绕过用户明确同意

### 已确认产品规则

严重餐损/丢失如果采用“重新制作并继续履约”路径，必须由用户明确接受继续等待后才能继续配送。

### 当前代码问题

通用 admin `/resolve` 可以把 IN_PROGRESS/WAITING case 解析为 `CONTINUE_FULFILLMENT`。同时 `deliverTask()` 对 severe case 的放行条件把：

- `REMAKE_AND_CONTINUE`
- `CONTINUE_FULFILLMENT`

都视为可继续送达。

因此管理员可以在用户从未接受 remake proposal 的情况下，把 severe case 标 `CONTINUE_FULFILLMENT`，随后骑手完成送达，绕过用户确认规则。

### 修复要求

- 对 `SEVERE_FOOD_DAMAGE / FOOD_LOST`，普通继续履约不能成为绕过 customer-confirmed remake 的替代入口。
- 在产品未来明确设计“误报 severe / admin reclassification”之前，严重 case 的正常继续履约放行只认可用户明确接受形成的 `REMAKE_AND_CONTINUE`。
- `/resolve` 对 severe case 的 `CONTINUE_FULFILLMENT` 应拒绝，或确保它不能解除 severe delivery block。
- 增加测试：admin CONTINUE_FULFILLMENT 不能使 severe order 可 deliver；customer accepted remake 可以。

## 4. P0/P1：`deliverTask()` 只检查最新一条 severe case，会忽略更早未解决 incident

当前 delivery guard 对 severe case 使用按 `createdAt desc` 的单条 `findFirst()`。如果同一订单存在多条 severe case，较新的 case 已完成 `REMAKE_AND_CONTINUE`，但较早 case 仍 OPEN/WAITING/ESCALATED，当前代码可能只看到最新 case 并允许送达。

已确认原则是：新的后续 incident 应新建 case，不能覆盖/改写旧 case。这也意味着后来的 case 不能让早先仍未解决的严重事件“消失”。

修复要求：

- 送达前应检查所有与该订单相关、仍具有阻塞意义的 severe case，而不是只看最新一条。
- 至少保证任何未解决 severe case 都会阻止正常 deliver。
- 结合上一节，只有所有相关 severe incident 都处于明确允许继续的合法结果时才可继续。
- 增加多 severe case 回归测试。

## 5. P1：用户拒绝补餐时可能形成 `OPEN + currentHandlerAdminId != null` 卡死状态

### 复现场景

1. OPERATOR 先 claim severe case → `IN_PROGRESS + handler`；
2. rider 发起 remake proposal → `WAITING_FOR_PARTICIPANT`，handler 仍存在；
3. customer reject；
4. 当前 `respondToRemake()` 无条件把 case 改为 `OPEN`，但不清除 `currentHandlerAdminId/claimedAt`。

这样会形成 `OPEN + handler`：

- 新管理员 claim 需要 `OPEN + handler=null`，无法领取；
- 原 handler 的 release/transfer/escalate/resolve 又不允许从 OPEN 执行；
- 只能靠 Super Admin takeover 解卡。

另外，从其他 WAITING 语义进入 remake 时，reject 后可能残留不相容的旧 `resolutionType/resolutionNote`。

### 修复要求

- participant transition 必须维持 case 状态与 handler invariant。
- 推荐最小语义：如果 reject 时已有有效 handler，则回到 `IN_PROGRESS` 并保留该 handler；如果没有 handler，则回 `OPEN` 且 handler 必须为 null。
- 清理与新状态不相容的旧 resolution 字段，避免 `OPEN/IN_PROGRESS` 携带陈旧 WAITING resolution。
- 补测试：operator claim → propose → reject 后 case 仍可由原 handler 正常处理；无 handler proposal → reject 后回共享池可重新 claim。

## 6. P1：`ESCALATED_OTHER` 可作为伪升级的普通 resolve 出口

Schema 的 `ExceptionResolutionType` 仍包含 `ESCALATED_OTHER`。当前 `/admin/exception-cases/:caseId/resolve` 接受完整 enum，只单独禁止 `REMAKE_AND_CONTINUE`，因此 OPERATOR 可以用 `ESCALATED_OTHER` 调用普通 resolve；service 会把 case 直接标为 `RESOLVED`，而不是进入真正 `ESCALATED` 状态和 Super Admin 决策边界。

产品已经明确：需要升级时必须进入 audited escalation，普通管理员升级后不能继续普通处理。

修复要求：

- 在最终 outcome enum 设计完成前，public `/resolve` 不允许 `ESCALATED_OTHER` 作为 terminal resolution。
- 真正的升级必须走 `/escalate` → `ESCALATED` → Super Admin takeover/reassign。
- 可以暂时保留数据库 enum 兼容历史，不要求为了漂亮立即 drop enum。
- 增加 OPERATOR 无法以 `ESCALATED_OTHER` resolve 的测试。

## 7. P1：订单池修 snapshot 时丢失了“实际取餐商家名称”

`ORDER_POOL_DECISIONS.md` 已确认骑手接单前必须知道：**哪个商家/店 + 可执行取餐点/区域**。

当前 rider DTO 为：

- `merchantId`
- `pickupLocationNameSnapshot`
- `pickupRegionSnapshot`

其中 `pickupLocationNameSnapshot` 来自 `Merchant.campusLocation.name`，并不是商家/店名。之前 live Merchant name 被删除后，骑手只剩 UUID，无法知道去小吃街里的哪一家店取餐。

修复要求：

- 不要重新把 live merchant name 当历史订单权威字段。
- 给 Order 增加 `pickupMerchantNameSnapshot`（或等价不可漂移字段），订单创建时快照 merchant display name。
- rider DTO 返回 stable merchantId + merchant name snapshot + pickup location/region snapshot。
- 既有开发数据可通过新增 pre-production migration 用当前 Merchant.name 做最佳可用 backfill，并明确这只是历史缺失快照的兼容近似。
- 测试：创建订单后修改 Merchant.name 和 CampusLocation.name，骑手池仍显示创建时 merchant/location snapshot。

## 8. P1：WRONG_ADDRESS 已确认用户责任，但通用异常接口仍会自动创建 admin case

产品已经确认：地址填写错误原则上是用户责任；骑手按原订单地址正确送达即完成原履约；额外转送双方自愿协商，平台不主动介入。

当前通用 `createExceptionEvent()` 对任何 `ExceptionType` 都会 `openExceptionCase()`，因此单纯上报 `WRONG_ADDRESS` 也会进入共享管理员异常池。这会把一个已经明确不需要平台介入的普通用户责任事实重新变成后台案件。

修复要求：

- 单纯 `WRONG_ADDRESS` 事实不应自动要求管理员判责/处理。
- 可以保留结构化事实记录，但不自动 open ExceptionCase；如果用户/骑手对结果产生真实争议，则通过 `DELIVERY_DISPUTE`/明确投诉流程进入 admin pool。
- 不因 WRONG_ADDRESS 自动改变已确认的原地址履约完成语义。
- 增加测试：WRONG_ADDRESS 可记录事实但不自动创建 case/不改变订单状态；真实 dispute 仍能创建 case。

## 9. 文档漂移：两个已经确认的规则仍被写成未决/争议

需要同步主产品文档与角色文档：

1. `PRODUCT_DECISIONS.md` 5A 仍写“冷却期间不能接新单；已存在订单/异常处理边界以后再补充”。已经确认的规则是：暂停/冷却只影响**新 claim**，不取消、不回池、不改变已经持有的订单；已有订单继续按原流程履约/处理。
2. `ROLE_RESPONSIBILITIES.md` 的待补充仍列“骑手冷却期间已持订单的边界”，应删除并在骑手章节明确上述已确认行为。
3. `PRODUCT_DECISIONS.md` 商家风险归因仍把“地址错误”与用户失联/系统异常一起写成“有争议结果”。现在应明确：已确认的 WRONG_ADDRESS 是用户责任，不能作为商家责任信号；其他尚未归因的失败仍只保留事实。

## 10. 明确不在本轮修的事项

以下仍未确认或依赖 W/真实运营，不得借本次修补擅自决定：

- 商家初始配送金额的真实资金语义及 50→45 等结算假设；
- 商家初始配送金额 pre-claim 的完整上下调规则；
- 严重异常未正常送达时 rider base payout 是否视为 earned；
- 平台垫付后的长期追偿、future income deduction、write-off；
- 正式商品佣金比例、支付通道费、税费；
- 真实 Jev 网络接入、动态定价算法；
- 5 单后的自动升级/自动降容量。

## 11. 验收状态

- `9b648de...`：上一轮 1–12 项多数真实修复，但存在本文件第 2–9 节的新发现，不能标记完全通过。
- `CODEX_REPORT.md`：**继续保留**。
- 下一轮应只修本文件中能够依据既有规则确定的缺口，不扩展 W 依赖的 pricing/settlement 设计。
