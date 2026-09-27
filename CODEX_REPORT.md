# CODEX_REPORT

## 1. 任务、提交与结论

- 任务：执行最新 `CODEX_TASK.md`，修复 `AUDIT_SECOND_PASS_2026-09-27.md` 确认的严重异常状态机、异常入口、订单池商家快照与文档漂移。
- 同步后的起始提交：`180d67c5d5fba6b0680ac6c9688a6e73ad23c757`（`docs: assign second-pass audit fixes`）。
- 实现结束提交：`2c458b6349a934bec497f54ce75491a9319a74d8`（`fix: close severe exception state gaps`）。
- 分支：`main`；实现与报告使用普通 push，不使用 force push。
- 开始时工作树干净；未 reset、discard、checkout-away 或覆盖既有未提交工作。

本轮任务 1–9 已完成对应 runtime、migration、test 与 truth-source 修补。商家初始配送金额、严重失败订单 rider base 是否 earned、平台垫付长期追偿等未决事项没有被修改或重新解释。

## 2. Implementation truthfulness

### Enforced behavior

- 通用 exception endpoint 和 service 都拒绝 `SEVERE_FOOD_DAMAGE / FOOD_LOST`；severe self-report 只能由责任骑手在 PICKED_UP 后通过 dedicated route 创建。
- Severe order 送达前检查该订单所有 severe cases；每一条都必须是 customer-confirmed `REMAKE_AND_CONTINUE` 才能放行。
- Admin `CONTINUE_FULFILLMENT` 不能解除 severe delivery block；非 severe case 仍可使用该普通结果。
- Remake reject 根据 handler 恢复为 IN_PROGRESS 或 OPEN，并清除陈旧 resolution metadata。
- Public admin resolve 不接受 `ESCALATED_OTHER`；真正升级必须走 audited `/escalate`。
- `WRONG_ADDRESS` 只记录 ExceptionEvent，不自动创建 ExceptionCase 或改变订单状态。
- Rider order-pool 返回订单创建时的 merchant name/pickup/destination snapshots 与稳定 ids。

### Data / telemetry available

- WRONG_ADDRESS 结构化事实继续保留；后续 DELIVERY_DISPUTE 可独立创建 admin case。
- Severe cases、participant proposal/response、handler、version 与 action audit 继续保留。
- `Order.pickupMerchantNameSnapshot` 保存创建时商家显示名称。

### Policy hook / placeholder

- `ESCALATED_OTHER` 数据库 enum 为历史兼容保留，但 public resolve 不可使用。
- Item/Exception classifier 仍只有 deterministic/manual safe fallback；真实 Jev 未激活。
- Pricing policy 的 merchant initial/category/region/foodType 等输入仍为 reserved/not active。

### Not implemented / intentionally unresolved

- 商家初始配送金额是真实商家成本、纯 reference 还是混合概念，以及 50→45 假设与 pre-claim 完整调价规则。
- 严重异常未正常送达时 rider base payout 是否 earned。
- 平台垫付后的长期追偿、future-income deduction、write-off、真实钱包/支付。
- 正式商品佣金、支付通道费、税费、真实 Jev、动态定价、5 单后自动升降容量。

## 3. 任务 1：关闭通用 severe report 绕过

### Runtime

- 通用 `/orders/:orderId/exceptions` OpenAPI schema 排除 severe damage/loss。
- `createExceptionEvent()` 同时在 service boundary 返回 `SEVERE_EXCEPTION_REQUIRES_DEDICATED_ROUTE`，防止非 HTTP 调用绕过。
- 新 `createSevereRiderExceptionEvent()` 在创建 event/case 的同一事务内验证：actor 是 rider、类型是 severe、当前 DeliveryTask 责任 rider 匹配、task 已 PICKED_UP。
- Dedicated `/rider/orders/:orderId/severe-exception` 使用该事务内集中校验，消除旧的“先查再另事务创建”窗口。

### Tests

- Customer 经通用 endpoint 提交 severe 被拒且不创建 event/case。
- 已 claim 但未 pickup 的 rider 经通用 endpoint 提交 FOOD_LOST 被拒且不创建事实。
- 责任 rider pickup 后走 dedicated route 成功创建 severe case。

## 4. 任务 2–3：封死 severe continue 与多 case 覆盖

### Runtime

- `resolveNonEconomicCase()` 对 severe + `CONTINUE_FULFILLMENT` 返回 `SEVERE_REMAKE_CONFIRMATION_REQUIRED`。
- `deliverTask()` 查询订单全部 severe cases，不再只取最新一条。
- 每个 severe case 的唯一放行组合为：`status=RESOLVED` 且 `resolutionType=REMAKE_AND_CONTINUE`。
- `CONTINUE_FULFILLMENT`、RESPONSIBILITY_UNDETERMINED、OPEN、WAITING、IN_PROGRESS、ESCALATED 等都不能让 severe case 放行。

### Tests

- Operator claim severe case 后尝试 CONTINUE 被拒，deliver 仍被阻止；rider proposal + customer accept 后可 deliver。
- 较早 severe case 仍 OPEN、较新 case 已 REMAKE_AND_CONTINUE 时 deliver 仍被阻止；两条均取得 customer acceptance 后才可 deliver。
- `MINOR_DAMAGE_OR_DELAY` 的普通 CONTINUE_FULFILLMENT 仍能 resolve 并继续 deliver，未误伤非 severe 流程。

## 5. 任务 4：remake reject handler/state invariant

### Runtime

- Rider propose remake 进入 WAITING 时清理旧 `resolutionType/resolutionNote/resolvedAt`。
- Customer reject 时：
  - 有 handler → 回 IN_PROGRESS，保留原 handler/claimedAt；
  - 无 handler → 回 OPEN，并保证 handler/claimedAt 为 null；
  - 两条路径都清理 resolution metadata，ESCALATED guard 保持不变。

### Tests

- Operator claim → WAITING_FOR_INFORMATION → rider propose → customer reject：case 回 IN_PROGRESS、handler 不变、旧 WAITING metadata 清空，原 operator 可继续合法 resolve。
- 无 handler proposal → reject：case 回干净 OPEN 状态，随后普通 operator 可按新 version 重新 claim。

## 6. 任务 5：禁止 ESCALATED_OTHER 伪升级

### Runtime

- Public `/admin/exception-cases/:caseId/resolve` schema 排除 `ESCALATED_OTHER` 与 participant-only `REMAKE_AND_CONTINUE`。
- Service 仍有 `USE_ESCALATION_ACTION` defense-in-depth，防止内部调用把 ESCALATED_OTHER 当终态。
- 真正升级继续使用 `/escalate`，写 `status=ESCALATED`、version 与 action audit，随后由 Super Admin takeover/reassign。

### Test

- OPERATOR 的 ESCALATED_OTHER public resolve 返回稳定 validation rejection，case 保持 IN_PROGRESS/version 不变；随后 `/escalate` 正常进入 ESCALATED。

## 7. 任务 6：恢复不可漂移的取餐商家名称

### Schema/runtime

- `Order` 新增非空 `pickupMerchantNameSnapshot`。
- `createOrder()` 与 Seed 在订单创建时快照 `Merchant.name`。
- Rider DTO pickup 返回：
  - stable `merchantId`；
  - snapshot `merchantName`；
  - snapshot `locationName` / `region`。
- Destination 继续返回 stable `locationId` + snapshot label/region；未重新引入 live Merchant/CampusLocation name。

### Migration

- 新增 `20260927000300_order_pickup_merchant_snapshot`，不修改旧 migration。
- 对 pre-production 历史订单用当前 `Merchant.name` 做 best-effort backfill；无法匹配时写 `LEGACY_UNKNOWN` 后设 NOT NULL。
- 该 backfill 只是历史缺失快照的兼容近似，不能证明订单创建时真实店名，也不是生产审计迁移范式。

### Test

- 创建订单后同时修改 Merchant.name、pickup CampusLocation.name 与 destination CampusLocation.name；rider pool 仍返回原商家/取餐点/目的地 snapshots 和稳定 ids，且不含三个 live 新名称。

## 8. 任务 7：WRONG_ADDRESS 不自动进入 admin pool

### Runtime

- `createExceptionEventInternal()` 对 WRONG_ADDRESS 创建 ExceptionEvent、可绑定 evidence，但跳过 `openExceptionCase()`。
- WRONG_ADDRESS 不进入 stopsDelivery、退款、处罚或商家风险归因路径，也不改变订单状态。
- 后续真实投诉仍可通过 DELIVERY_DISPUTE 创建独立 ExceptionCase。

### Test

- WRONG_ADDRESS 上报后 event 存在、case 数量为 0、订单仍 READY_FOR_RIDER。
- 随后的 DELIVERY_DISPUTE 成功创建一条 admin case，原订单状态不被地址事实自动改写。

## 9. 任务 8：产品与角色文档同步

- `PRODUCT_DECISIONS.md`：暂停/冷却只阻止新 claim，不取消、不回池、不改变已持订单；WRONG_ADDRESS 明确为用户责任且不作为商家责任信号。
- `ROLE_RESPONSIBILITIES.md`：骑手章节明确已持订单继续原履约/异常流程，并从待补充列表删除该已决边界。
- README 同步暂停/冷却语义、WRONG_ADDRESS 事实入口、severe customer-confirmed remake、merchant snapshot 与 migration 限定。
- `EXCEPTION_HANDLING.md` 明确 severe continue、WRONG_ADDRESS admin pool 与 audited escalation 边界。
- `ORDER_POOL_DECISIONS.md` / `IMPLEMENTATION_PLAN.md` 明确 merchant name、pickup、destination 使用订单快照并保留稳定 ids。

## 10. 任务 9：上一轮安全边界回归

全量 PostgreSQL integration 继续通过以下既有行为：

- default commission=0；
- compensation release 保留 platform advance/outstanding，不 write-off；
- non-zero rider self-reported payment 被拒；
- terminal/ESCALATED guards 与 Super Admin A→B reassignment；
- capacity 1→2→5、history backfill、global/override cap；
- daily no-fault cancellation cap；
- merchant rescue 与 user tip 100% pass-through、platform subsidy accounting；
- item/exception classifier fallback，无真实 Jev dependency；
- role-facing DTO funding isolation。

## 11. Requirement-to-code checklist

| Task | Runtime enforcement point | Verification |
|---|---|---|
| 1 severe entry | general/dedicated schemas + `createExceptionEvent` / `createSevereRiderExceptionEvent` | customer/rider negative + dedicated positive integration |
| 2 severe continue | `resolveNonEconomicCase`, `deliverTask` | admin continue rejected + customer remake accepted |
| 3 all severe cases | `deliverTask` all-case query | older open + newer resolved regression |
| 4 reject invariant | `proposeRemake`, `respondToRemake` | handler/no-handler flows + metadata assertions |
| 5 fake escalation | public resolve schema + service guard | public reject + actual `/escalate` success |
| 6 merchant snapshot | Order schema/create/DTO + migration | three-name rename regression |
| 7 wrong address | `createExceptionEventInternal` case creation branch | fact/no-case/status + later dispute |
| 8 docs | root truth/role/README/topic docs | cross-document text audit |
| 9 regressions | unchanged runtime plus full suites | 28 unit + 70 PostgreSQL integration tests |

## 12. Validation results

### Docker preflight

- `docker desktop status`: running。
- `docker info` ServerVersion: `29.8.0`。
- 未重启 Docker；未执行 factory reset、clean/purge、删除 volume 或用户数据目录。

### Targeted first

- Targeted state-machine unit：2 files / 6 tests 通过。
- Targeted PostgreSQL integration：exception-flow + pricing-capacity，2 files / 43 tests 通过。
- Public resolve schema 调整后再次单跑 exception-flow：33 tests 通过。

### Full validation

- `pnpm typecheck`：通过。
- `pnpm test`：10 files / 28 tests 通过。
- `pnpm test:integration`：3 files / 70 tests 通过，包含 migrate deploy + Seed。
- `pnpm build`：通过。
- Current DB：16 migrations，schema up to date；`pickupMerchantNameSnapshot IS NULL` 数量为 0。
- Migration/schema drift：`No difference detected.`
- Empty DB：全部 16 migrations 顺序应用成功。
- Empty DB Seed：连续两次成功。
- Empty DB post-check：16 migrations finished、snapshot null count=0、active `platformCommissionBps=0`。
- OpenAPI/角色边界：general severe 与 public ESCALATED_OTHER 已从相应 request schema 排除；dedicated severe、admin escalation、participant、资金隔离路径由 PostgreSQL integration 验证。
- 临时 shadow/empty verification databases 已按明确名称删除；项目数据库与 Docker volume 未删除。

上述为本地验证结果，不等于独立 CI 验证；本报告不声称实现提交已有独立 GitHub Actions status。

## 13. Intentional omissions / unresolved

- 没有决定或修改 merchant initial delivery funding；当前 reference-only runtime 仍是 provisional。
- 没有决定 severe failure 未正常送达时 rider base payout 是否 earned。
- 没有新增追偿、future-income deduction、write-off、钱包或外部支付。
- 没有改变正式佣金、支付通道费、税费、真实 Jev、动态定价或 5 单后容量规则。
- 没有删除历史兼容 enum/legacy 字段，也没有进入下一阶段产品设计。
