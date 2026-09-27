# CODEX_REPORT

## 1. 任务、提交与结论

- 任务：执行最新 `CODEX_TASK.md`，修复 `AUDIT_THIRD_PASS_2026-09-27.md` 确认的 severe 并发、DELIVERY_DISPUTE 资金生命周期、remake reject 审计语义与角色文档问题。
- 同步后的起始提交：`c89a3197e837b92d8a581de904e95f7c73d75c1d`（`docs: assign third-pass exception lifecycle fixes`）。
- 实现结束提交：`7b5183ed0efceec67d1cd65ba430eb372fcafcd6`（`fix: close exception concurrency and dispute lifecycle gaps`）。
- 分支：`main`；实现与报告使用普通 push，不使用 force push。
- 开始时工作树干净；未 reset、discard、checkout-away 或覆盖既有未提交工作。

最新任务 1–4 均已完成 runtime/test/documentation 修补。任务明确禁止的异常 outcome 模型、商家初始配送资金、严重失败骑手收益和长期追偿等事项没有被自行设计或修改。

## 2. Implementation truthfulness

### Enforced behavior

- Dedicated severe report 与 normal deliver 按同一 `Order → DeliveryTask` 行锁顺序串行化，不会产生 DELIVERED/COMPLETED + unresolved severe case。
- ExceptionCase terminal resolution、linked ExceptionEvent resolution 与 DELIVERY_DISPUTE hold recovery 在同一业务事务内完成。
- 同订单存在其他 unresolved DELIVERY_DISPUTE 时不提前解 hold；只处理 `holdReason=DELIVERY_DISPUTE`。
- Dispute hold 恢复尊重 `pendingUntil`，保留 `reservedMinor`，并由 settlement sweep 幂等 reconciliation。
- Customer remake reject 使用独立 `REMAKE_REJECTED` action；admin release 继续独占 `RELEASED`。

### Data / telemetry available

- ExceptionCase/ExceptionEvent terminal 时间保持一致；WAITING/ESCALATED/reject 不写 event resolvedAt。
- RiderSettlement 的 PENDING/AVAILABLE/HELD、heldAt/holdReason、reservedMinor 继续提供可审计资金状态。
- `REMAKE_REJECTED` metadata 保存 proposal id 与 resulting case status。

### Policy hook / placeholder

- Item/Exception classifier 仍只有 deterministic/manual fallback；真实 Jev 未激活。
- Pricing policy 的 merchant initial/category/region/foodType 等输入仍为 reserved/not active。

### Not implemented / intentionally unresolved

- Severe case 中“责任判断结果”和“订单操作结果”是否拆成两个字段/状态轴。
- stopsDelivery exception 的完整 CONTINUE_FULFILLMENT order/task/assignment 恢复流程。
- 商家初始配送金额是真实成本、reference 还是混合概念。
- Severe failure 未正常送达时 rider base payout 是否 earned。
- 平台垫付长期追偿、future-income deduction、write-off、真实钱包/支付。
- 正式佣金、通道费、税费、真实 Jev、动态定价、5 单后自动升降容量。

## 3. 任务 1：序列化 severe report 与 deliver

### Runtime enforcement

- `createSevereRiderExceptionEvent()` 的事务先按 `Order → DeliveryTask` 顺序执行 `FOR UPDATE`，与 `deliverTask()` 完全一致。
- 取得锁后重新加载 order/task，再验证当前责任 rider 与 `PICKED_UP`；之后才创建 ExceptionEvent/ExceptionCase，并持锁至提交。
- 若 report 先持锁，deliver 等待后能看到 blocking severe case 并返回 `SEVERE_EXCEPTION_UNRESOLVED`。
- 若 deliver 先持锁并完成，report 等待后重新看到 task 已非 PICKED_UP，返回 `SEVERE_EXCEPTION_STAGE_INVALID`。
- 未使用反向锁序或仅二次普通 read。

### Controlled concurrency test

- 使用 fake classifier barrier 控制“report 先进入临界区”，并发 deliver 被真实数据库行锁阻塞；report 提交后 deliver 失败，order 保持 PICKED_UP、case OPEN。
- 使用 delivery lock barrier 控制“deliver 先进入临界区”，并发 report 等待；deliver 提交后 report 失败，order/task 为 DELIVERED/COMPLETED 且无 severe case。
- Barrier 使用 promise/setImmediate 协调，不依赖随机时序或长 sleep。

## 4. 任务 2：DELIVERY_DISPUTE 资金生命周期

### Linked event terminal resolution

新增共享 `resolveLinkedExceptionEvent()`，在原业务事务内由以下 terminal 路径调用：

- `resolveNonEconomicCase()` 的非 WAITING terminal 分支；
- customer accepted remake 的 RESOLVED 分支；
- `refundAndCloseExceptionCase()` 的 REFUND_AND_CLOSE 分支。

WAITING_FOR_PARTICIPANT、OPEN、IN_PROGRESS、ESCALATED、customer reject、release/transfer/takeover 不设置 linked event `resolvedAt`。

### Dispute hold recovery

- Terminal DELIVERY_DISPUTE 先设置 linked event resolvedAt，再锁定该订单 RiderSettlement。
- 锁内重新统计同订单 unresolved DELIVERY_DISPUTE；只在数量为 0 时恢复。
- 仅匹配 `status=HELD AND holdReason=DELIVERY_DISPUTE`：
  - `pendingUntil > now` → PENDING；
  - `pendingUntil <= now` → AVAILABLE；
  - 清理 heldAt/holdReason；
  - `reservedMinor` 原样保留。
- COMPENSATION_OBLIGATION 和其他 hold reason 不自动解除。
- 多 dispute terminal resolution 通过 settlement row lock 串行化；最后一个 resolved transaction 才能恢复资金状态。

### Sweep reconciliation

- `releaseAvailableRiderSettlements()` 同时扫描到期 PENDING 与 `HELD + DELIVERY_DISPUTE`。
- 对 dispute-only HELD settlement，在 row lock 内重新核对 unresolved events，幂等恢复 PENDING/AVAILABLE。
- 已恢复记录不会重复计数；未知/compensation hold 不受影响。

### PostgreSQL tests

1. AVAILABLE → dispute → HELD → terminal resolve → AVAILABLE。
2. PENDING → dispute → terminal resolve → PENDING → 到期 sweep → AVAILABLE。
3. 两个 dispute：解决一个仍 HELD，全部解决才 AVAILABLE。
4. dispute + `reservedMinor=50`：恢复 AVAILABLE 后 reservation 仍为 50，rider DTO withdrawable 继续扣除 50。
5. WAITING 和 ESCALATED：event unresolved，settlement 继续 HELD。
6. 模拟历史 case/event 已 resolved 但 settlement 仍 dispute-held：sweep 首次修复、再次运行返回 0。
7. `holdReason=COMPENSATION_OBLIGATION`：sweep 不触碰。
8. Customer accepted remake 与 refund-and-close 路径均断言 linked event resolvedAt 已写入。

## 5. 任务 3：remake reject 审计语义

### Runtime/migration

- Prisma enum 新增 `ExceptionCaseActionType.REMAKE_REJECTED`。
- 新增 migration `20260927000400_exception_lifecycle_fixes`；未修改已执行 migration。
- Customer reject 无论回 IN_PROGRESS 还是 OPEN，均写 `REMAKE_REJECTED`，metadata 包含 proposalId 与 resultingCaseStatus。
- `/admin/.../release` 仍使用 `RELEASED`，不与 participant rejection 混义。

### Tests

- Handler-preserving reject：存在 REMAKE_REJECTED(resulting=IN_PROGRESS)，不存在 RELEASED。
- No-handler reject：action 顺序包含 REMAKE_REJECTED(resulting=OPEN)。
- 既有 admin transfer/takeover/release 测试继续证明真正 release 仍记录 RELEASED。

## 6. 任务 4：普通管理员角色文档

- `ROLE_RESPONSIBILITIES.md` 已改为：普通管理员可处理和核对补餐继续流程；对于严重餐损/丢失，不能替代用户确认继续等待，只有用户明确接受 proposal 后才形成 `REMAKE_AND_CONTINUE`。
- `EXCEPTION_HANDLING.md` 同步避免“管理员确认补餐继续”的歧义，并记录 severe 并发锁与 dispute hold 生命周期。
- README 同步 severe serialization、REMAKE_REJECTED audit 与 dispute settlement recovery。

## 7. 第二遍安全边界回归

全量 PostgreSQL integration 继续通过：

- general endpoint/service 不能创建 severe self-report；dedicated severe 要求责任 rider + PICKED_UP；
- severe admin CONTINUE 被拒；delivery 检查全部 severe cases；customer accepted remake 才放行；
- remake reject handler/state invariant；ESCALATED_OTHER 被拒且真实升级走 `/escalate`；
- WRONG_ADDRESS 只记事实；merchant/pickup/destination snapshots 不漂移；
- default commission=0；compensation release 不 write-off；non-zero self-reported payment 被拒；
- pause/cooldown 只阻止新 claim；capacity、pricing、rescue、tip、subsidy、classifier、role isolation 回归通过。

## 8. Requirement-to-code checklist

| Task | Runtime enforcement point | Verification |
|---|---|---|
| 1 severe concurrency | `createExceptionEventInternal` Order→Task locks; `deliverTask` same locks | two controlled concurrent interleavings |
| 2 linked event | `resolveLinkedExceptionEvent` called by three terminal paths | terminal and non-terminal resolvedAt assertions |
| 2 dispute recovery | settlement row lock + unresolved-dispute query | available/pending/multiple/reservation tests |
| 2 reconciliation | `releaseAvailableRiderSettlements` HELD branch | idempotent legacy repair + other-hold negative |
| 3 audit action | REMAKE_REJECTED enum/service/migration | handler/no-handler action assertions; admin RELEASED regression |
| 4 role docs | ROLE/EXCEPTION_HANDLING/README | text audit |

## 9. Validation results

### Docker preflight

- `docker desktop status`: running。
- `docker info` ServerVersion: `29.8.0`。
- 未重启 Docker；未执行 factory reset、clean/purge、删除 volume 或用户数据目录。

### Targeted first

- Targeted state-machine unit：1 file / 3 tests 通过。
- Targeted PostgreSQL integration：exception-flow + order-flow，2 files / 67 tests 通过。
- 定向测试包含两种可控并发时序及完整 dispute lifecycle/reconciliation。

### Full validation

- `pnpm typecheck`：通过。
- `pnpm test`：10 files / 28 tests 通过。
- `pnpm test:integration`：3 files / 77 tests 通过，包含 migrate deploy + Seed。
- `pnpm build`：通过。
- Current DB：17 migrations，schema up to date。
- Migration/schema drift：`No difference detected.`
- Empty DB：全部 17 migrations 顺序应用成功。
- Empty DB Seed：连续两次成功。
- Empty DB post-check：17 migrations finished、`REMAKE_REJECTED` enum 存在、active `platformCommissionBps=0`。
- 临时 shadow/empty verification databases 已按明确名称删除；项目数据库与 Docker volume 未删除。

上述为本地验证结果，不等于独立 CI 验证；本报告不声称实现提交已有独立 GitHub Actions status。

## 10. Intentional omissions / unresolved

- Severe + RESPONSIBILITY_UNDETERMINED 的“责任结论 vs 订单操作结果”单轴冲突仍未设计；本轮没有拆字段、重开 terminal case 或新增 outcome。
- stopsDelivery exception 的 CONTINUE_FULFILLMENT 尚无完整恢复 order/task/assignment 规则；本轮没有恢复状态机。
- Merchant initial delivery funding、50→45 假设和 pre-claim 完整调价仍待 W/真实运营验证。
- Severe failure rider base 是否 earned、平台垫付长期追偿/write-off、正式佣金/通道费/税费仍未决定。
- 未接真实 Jev、未新增动态定价或 5 单后容量规则，也未进入下一阶段。
