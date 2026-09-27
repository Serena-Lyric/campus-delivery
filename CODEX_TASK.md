# CODEX_TASK

## 当前任务：修复 2026-09-27 第二遍独立审核发现的边界漏洞

上一轮修复实现：`9b648de3845355ee383ae0fb477a6207d5884969`。
上一轮报告：`e36c0ca98302b83a4b3fac6b300216e21297e17c`。
第二遍独立审核：`AUDIT_SECOND_PASS_2026-09-27.md`。

本轮仍然不是扩展新业务，而是把已经确认的严重异常状态机、异常入口、订单池事实和文档真值收口。开始前必须完整阅读并遵守：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `AUDIT_SECOND_PASS_2026-09-27.md`
4. `AUDIT_HANDOFF_2026-09-27.md`
5. `AUDIT_FOLLOWUP.md`
6. `EXCEPTION_HANDLING.md`
7. `ORDER_POOL_DECISIONS.md`
8. `ROLE_RESPONSIBILITIES.md`
9. `IMPLEMENTATION_PLAN.md`
10. `DELIVERY_PRICING_DECISIONS.md`
11. 当前 `CODEX_REPORT.md`

如代码/旧测试/README 与上述已确认规则冲突，不要为了兼容旧行为保留错误语义。另一方面，本任务明确列出的未决事项不得被你自行补成长期产品规则。

---

## 0. 本轮明确禁止决定的事项

不要修改或重新解释：

- 商家初始配送金额是真实商家成本、纯 reference 还是混合概念；
- “商品 50、配送 5、商家结算 45”等待 W 验证的假设；
- 商家初始配送金额的完整 pre-claim 上下调规则；
- 严重异常未正常送达时 rider base payout 是否 earned；
- 平台垫付后的长期追偿、future-income deduction、write-off；
- 正式商品佣金比例、支付通道费、税费；
- 真实 Jev 网络接入；
- 动态定价算法；
- 5 单后的自动升级/自动降容量。

当前 `platformCommissionBps=0`、merchant initial amount provisional reference、非零 rider self-reported payment 被拒绝等安全状态继续保持。

---

## 1. P0：关闭通用 exception endpoint 对 severe self-report 的绕过

### 问题

`POST /rider/orders/:orderId/severe-exception` 已正确限制 severe damage/loss 为“责任骑手 + 已 PICKED_UP”。但通用 `POST /orders/:orderId/exceptions` 接受整个 `ExceptionType`，可以绕过上述入口约束创建 `SEVERE_FOOD_DAMAGE / FOOD_LOST` case。

### 必须修复

- severe damage/loss 的 actor/stage invariant 必须不可绕过。
- 优先最小实现：通用 exception endpoint 不接受 `SEVERE_FOOD_DAMAGE / FOOD_LOST` 作为普通上报类型；责任骑手必须走 dedicated severe route。
- 如果选择 service 层集中 guard，也必须保证所有调用路径一致。
- 用户对严重问题的投诉应通过 dispute/complaint 类型进入人工处理，不得伪造“责任骑手取餐后主动 severe report”事实。

### 测试

- customer/general endpoint 不能创建 severe case；
- rider 在未 pickup 阶段不能借 general endpoint 创建 severe case；
- dedicated responsible-rider-after-pickup severe route 继续成功。

---

## 2. P0：严重餐损/丢失不能被通用 `CONTINUE_FULFILLMENT` 绕过用户确认

### 已确认规则

严重餐损/丢失如果走重新制作继续履约，必须由用户明确接受继续等待；`REMAKE_AND_CONTINUE` 的用户确认不能被 admin 普通 continue 替代。

### 当前风险

admin `/resolve` 可把 severe case 解析为 `CONTINUE_FULFILLMENT`；`deliverTask()` 又把 severe `REMAKE_AND_CONTINUE` 与 `CONTINUE_FULFILLMENT` 都视为可继续送达。

### 必须修复

- 对 `SEVERE_FOOD_DAMAGE / FOOD_LOST`，通用 `CONTINUE_FULFILLMENT` 不得解除 severe delivery block。
- 在产品以后明确设计“severe 误报/重新分类”路径之前，severe 正常继续履约仅认可用户明确接受 remake 后形成的 `REMAKE_AND_CONTINUE`。
- 可以在 admin resolve 层拒绝 severe + CONTINUE_FULFILLMENT，并在 `deliverTask()` 再做 defense-in-depth。
- 不影响其他适合 `CONTINUE_FULFILLMENT` 的非 severe exception。

### 测试

- admin 把 severe case 尝试 resolve 为 CONTINUE_FULFILLMENT 时被拒或仍不能 deliver；
- customer 明确接受 remake 后可以正常继续 deliver；
- 非 severe 的合法 CONTINUE_FULFILLMENT 行为如现有产品允许，应保持。

---

## 3. P0/P1：送达前不能只检查最新一条 severe case

### 问题

当前 `deliverTask()` 只按 `createdAt desc` 取最新一条 severe case。后来的 resolved case 不能掩盖更早仍 OPEN/WAITING/ESCALATED 的 severe incident。

### 必须修复

- 送达前检查该订单所有 severe cases 的阻塞状态，或用等价 query 明确寻找任何 blocking severe case。
- 任一未解决 severe case 必须阻止 deliver。
- 结合第 2 项：只有所有需要处理的 severe incident 都处于已确认允许继续的合法结果时才可继续；不能把后续 case 当成旧 case 的覆盖层。
- 新事件仍然是新 case，不改写旧 case。

### 测试

构造至少两条 severe case：较早一条仍 unresolved，较新一条为 REMAKE_AND_CONTINUE；deliver 仍必须被阻止。处理所有 blocking case 后才可按合法路径继续。

---

## 4. P1：修复 remake reject 的 handler/state invariant

### 问题

`IN_PROGRESS + handler` 的 severe case 可以由 rider 发起 remake 变 WAITING，但 customer reject 目前无条件写成 OPEN，并保留 handler，形成 `OPEN + currentHandlerAdminId != null` 卡死状态。

### 必须修复

- 如果 reject 时 case 有有效 handler：回到 `IN_PROGRESS`，保留 handler，使原管理员能继续退款/争议判断/升级。
- 如果 reject 时没有 handler：回到 `OPEN`，并保证 handler/claimedAt 为 null，使其回共享池。
- participant 状态变化时清理与新状态不相容的陈旧 `resolutionType/resolutionNote/resolvedAt`；不要留下 `OPEN/IN_PROGRESS + WAITING_FOR_INFORMATION` 等矛盾语义。
- 保持 ESCALATED guard 不回退。

### 测试

1. operator claim → rider propose → customer reject → case=IN_PROGRESS、handler 仍为原 operator，operator 可继续合法处理；
2. 无 handler → rider propose → reject → case=OPEN、handler null，可重新 claim；
3. reject 后不存在陈旧 resolution metadata。

---

## 5. P1：禁止 `ESCALATED_OTHER` 伪装成普通 terminal resolve

### 问题

`ExceptionResolutionType.ESCALATED_OTHER` 当前可以经 `/admin/.../resolve` 进入普通 `resolveNonEconomicCase()`，最终把 case 标 RESOLVED，而不是进入真正 ESCALATED + Super Admin 边界。

### 必须修复

- public admin resolve API 暂时不允许 `ESCALATED_OTHER` 作为终态 resolution。
- 真正升级必须走 `/escalate`，产生 `ExceptionCase.status=ESCALATED` 和审计，再由 Super Admin takeover/reassign。
- 可以保留 enum 做历史兼容，本轮不要求 destructive schema 清理。

### 测试

- OPERATOR 用 `ESCALATED_OTHER` resolve 被稳定拒绝且 case 不改变；
- `/escalate` 正常路径继续工作。

---

## 6. P1：恢复订单池中的“实际取餐商家名称”，但必须是 snapshot

### 已确认产品事实

骑手接单前必须知道：本单能拿多少钱、**去哪个商家/店取餐**、具体取餐点/区域、目的地、物品粗分类、数量。

### 当前回归

上一轮为消除 live name 漂移，Rider DTO 删除了 Merchant.name，只剩 `merchantId + pickupLocationNameSnapshot + pickupRegionSnapshot`。`pickupLocationNameSnapshot` 是 CampusLocation 名称，不是店名；UUID 不能告诉骑手去小吃街哪一家店。

### 必须修复

- Order 增加 `pickupMerchantNameSnapshot` 或等价不可漂移字段。
- 创建订单时快照当前 Merchant.name。
- Rider order-pool DTO 返回：stable merchantId + merchant name snapshot + pickup location snapshot + pickup region snapshot。
- 不重新把 live Merchant.name 作为历史订单履约权威文本。
- 既有 pre-production 开发数据可用新增 migration 从当前 Merchant.name 做 best-effort backfill，并在 migration/report 说明这是历史缺失快照的兼容近似，不是生产审计范式。
- 按 AGENTS 不修改旧 migration。

### 测试

创建订单后修改 Merchant.name、pickup CampusLocation.name、destination CampusLocation.name；该历史订单 rider pool 仍显示创建时的 merchant/pickup/destination snapshots，同时保留 stable ids。

---

## 7. P1：WRONG_ADDRESS 是用户责任事实，不应默认进入 admin exception pool

### 已确认产品规则

- 用户地址/位置填错属于用户责任；
- 骑手按原预留地址正确送达即完成平台原订单履约；
- 用户可自行取或与骑手自愿协商额外转送；
- 平台第一版不主动介入这种额外转送安排。

### 当前问题

通用 `createExceptionEvent()` 对任何 ExceptionType 都自动 `openExceptionCase()`。因此单纯记录 WRONG_ADDRESS 也会进入共享管理员异常池，与“平台不主动介入”的边界冲突。

### 必须修复

- `WRONG_ADDRESS` 可保留为结构化事实，但单纯该事实不自动创建 ExceptionCase，也不自动改变订单状态/履约责任。
- 如果之后真正发生投诉/争议，使用 `DELIVERY_DISPUTE` 或明确投诉类型进入 admin pool。
- 不因为 WRONG_ADDRESS 自动退款、处罚、判骑手责任或修改商家风险归因。

### 测试

- WRONG_ADDRESS 上报：事实存在、无 ExceptionCase、订单状态不被自动改写；
- 后续 DELIVERY_DISPUTE 仍能创建独立 admin case。

---

## 8. 同步三处已确认但仍漂移的产品/角色文档

只做已确认规则校正，不创造新规则。

### `PRODUCT_DECISIONS.md`

把 5A 中：

> 冷却期间骑手不能继续接新订单；已存在订单/异常处理的具体边界以后再补充。

改为明确：

- 暂停/冷却只阻止**新 claim**；
- 不取消、不回池、不改变骑手已经持有的订单；
- 已持订单继续按原履约/异常流程处理。

商家风险归因处不要再把“地址错误”写成尚未归因的争议项；应改为：

- 已确认 WRONG_ADDRESS 属于用户责任，不作为商家责任信号；
- 用户失联、骑手责任、系统异常及其他尚未明确归因的失败继续先保留事实。

### `ROLE_RESPONSIBILITIES.md`

- 骑手章节明确 pause/cooldown 只影响新 claim，不改变已持订单。
- 从“待后续补充”删除“骑手冷却期间已持订单的边界”。

如 README 有相同过期表述一并同步。

---

## 9. 保持上一轮已经修好的安全边界

本轮回归必须保证不破坏：

- default commission=0；
- compensation release 不 write-off；
- non-zero rider self-reported payment 被拒；
- terminal/ESCALATED state guards；
- Super Admin A → B reassignment；
- capacity 1→2→5、history backfill、global/override cap；
- rider no-fault cancellation daily cap；
- merchant rescue 100% pass-through；
- user tip 100% pass-through；
- platform subsidy accounting；
- item/exception classifier fallback；
- no real Jev network dependency；
- role-facing DTO funding isolation。

---

## 10. 测试、migration 与报告

先跑针对性测试，再执行完整：

- `pnpm typecheck`
- unit tests
- PostgreSQL integration tests
- build
- current DB migration status
- migration/schema drift
- empty DB all migrations + idempotent Seed

Docker 继续严格遵守 `AGENTS.md`，禁止 destructive reset/clean/purge/delete volume；最多一次安全 restart。

完成后：

1. 普通 commit + push `main`，不 force push；
2. 更新根目录 `CODEX_REPORT.md`；
3. 报告逐项对应本任务 1–9，明确 runtime enforcement point 与测试；
4. 明确本地验证不等于独立 CI；
5. 明确 merchant initial delivery funding、severe-failure earned rider base、长期追偿等事项仍未决定；
6. 完成后停止，不自行进入下一阶段产品设计。
