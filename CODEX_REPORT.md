# CODEX_REPORT

## 1. 任务、提交与结论

- 任务：执行根目录 `CODEX_TASK.md`，只修复 `AUDIT_HANDOFF_2026-09-27.md` 已确认可修复的代码、测试、migration 与文档问题。
- 同步后的起始提交：`98dfbfd04f99e33dd3bd06ca6bb957f322c01b7d`（`docs: assign audited safety and consistency fixes`）。
- 实现结束提交：`9b648de3845355ee383ae0fb477a6207d5884969`（`fix: close audited safety and consistency gaps`）。
- 分支：`main`；实现提交与本报告提交使用普通 push，不使用 force push。
- 工作树开始时干净；未 reset、discard、checkout-away 或覆盖既有未提交工作。

本轮 `CODEX_TASK.md` 第 1–12 项均已完成对应的 runtime/test/documentation 修补。商家初始配送金额真实结算语义仍待 W/真实运营经验验证；本轮没有把当前 reference-only runtime 升级为产品事实，也没有进入定价算法、商家结算模型或下一阶段功能。

## 2. Implementation truthfulness

### Enforced behavior

- 正常默认配置 `platformCommissionBps=0`；默认订单不扣商品佣金。
- compensation reservation release 只解冻 reservation，释放金额继续形成 platform advance/outstanding，义务不因 release 自动结清。
- public rider compensation API 拒绝非零、无可验证资金来源的 `voluntaryPaymentMinor`。
- rider/customer remake participant actions 受 ExceptionCase 状态机约束，不能越过 ESCALATED。
- ESCALATED case 只能 takeover/reassign 给 SUPER_ADMIN，但发起人可以指定另一位 SUPER_ADMIN。
- Item classifier 在订单写事务外执行；写事务重新校验商品事实，变化时拒绝创建。
- Exception classifier 抛错时 case 仍以 MANUAL_FALLBACK 创建。
- rider order-pool 只返回稳定 id 与订单地点快照，不混入可变 live 名称。

### Data / telemetry available

- Exception/item classifier 的 source、version、confidence 与 typed result。
- Compensation reservation、platform advance、outstanding、allocation 与 release audit。
- Rider `firstNormalDeliveredAt`、capacity stage 与事件。
- Pricing inputs snapshot 继续保存 merchant/category/region/foodType 等事实。

### Policy hook / placeholder

- 商品 commission 字段、配置和计算 plumbing 仍存在，但默认值为 0；正式费率未决定。
- Item/Exception classifier adapter 已有安全边界，但真实 Jev endpoint/credential/network adapter 未激活。
- Pricing policy 仍只实际使用 global defaults、merchant override 与 quantity；merchant initial amount、category、region、foodType 等输入仍为 reserved/not active。

### Not implemented / intentionally unresolved

- 商家初始配送金额是纯 reference、商家真实成本还是混合概念，以及是否从商品款扣除、如何支付、pre-claim 是否可降低。
- 正式商品佣金、支付通道费、税费与完整平台贡献口径。
- 平台垫付后的长期追偿、未来收入自动抵扣、write-off、钱包或外部支付。
- 严重异常未正常送达时 rider base payout 是否 earned；本轮没有修改当前相关路径。
- 真实 Jev、真实退款/支付/提现、成熟动态定价、5 单后自动升级与异常自动降容量。

## 3. 第 1 项：未确认商品佣金默认归零

### Runtime

- `demoPolicy.platformCommissionBps` 从 500 调整为 0。
- Seed order pricing 的 `platformCommissionMinor` 改为 0，`merchantSettlementMinor` 恢复为完整商品小计。
- 新 migration `20260927000200_audit_handoff_safety_fixes` 将当前 active `ORDER_POLICY.platformCommissionBps` 中性化为 0；不修改旧 migration 文件。
- Commission 字段/配置能力保留，明确只是未来 policy hook。

### Tests

- 默认两商品订单断言 `platformCommissionMinor=0`、`merchantSettlementMinor=2000`。
- 完成订单断言 `merchantPayableMinor=2000`，平台收入只含当前配送贡献 100，不凭空产生 100 商品 commission revenue。
- 空库连续 Seed 后直接查询 active commission 为 0。

## 4. 第 2 项：reservation release 不再隐式核销

### Runtime

- `releaseCompensationReservations()` 仍幂等、version/status guarded、事务化并审计。
- 释放 settlement reservation 后：
  - reservation bucket 清零；
  - `platformAdvancedMinor += releasedMinor`；
  - `outstandingMinor += releasedMinor`；
  - obligation 保持 `PARTIALLY_FUNDED`；
  - `resolvedAt` 保持 null。
- release 不再把 obligation 标为 `RESOLVED`，也不再将 outstanding 清零；未新增 write-off 或追偿规则。

### Tests

- 精确覆盖已有 outstanding 1570 + 释放 reservation 750 → platform advance/outstanding 都为 2320。
- 覆盖本单与其他未提现 settlement reservation 全部释放且 settlement `reservedMinor=0`。
- 两个相同 idempotency key 的并发 release 都返回成功，但只生成一个 `RESERVATION_RELEASED` action，金额不重复增加。

## 5. 第 3 项：禁止无资金支撑的 voluntary payment

### Runtime

- `voluntaryPaymentMinor > 0` 在进入经济事务前返回 400 `VOLUNTARY_PAYMENT_UNFUNDED`。
- 0/省略该字段仍表示骑手选择原价赔付业务动作；退款继续由可验证 settlement reservation + platform temporary advance 支撑。
- OpenAPI 字段说明明确：真实 rider payment source 上线前暂时只允许 0。

### Tests

- non-zero 请求返回稳定错误码；不创建 obligation/allocation、不改变 case 状态，也不能减少 platform advance/outstanding。
- 正常省略字段的赔付、并发幂等与 reservation 测试继续通过；没有 `RIDER_VOLUNTARY_PAYMENT` allocation。

## 6. 第 4–5 项：ExceptionCase participant transitions 与 ESCALATED takeover

### Runtime

- 状态机新增 `RIDER_PROPOSE_REMAKE`、`CUSTOMER_ACCEPT_REMAKE`、`CUSTOMER_REJECT_REMAKE`。
- propose 只允许 OPEN/IN_PROGRESS/WAITING；customer response 只允许 WAITING。
- ESCALATED 后 rider proposal、customer accept/reject 都返回 `CASE_STATE_CONFLICT`，不会修改 proposal 或 case。
- ESCALATED takeover target 必须具有 `AdminProfile.level=SUPER_ADMIN`；不再要求 target 等于发起 actor。

### Tests

- ESCALATED → rider propose 被拒，case 保持 ESCALATED，proposal 不创建。
- pending remake → takeover/administrative escalate → customer accept 与 reject 均被拒，proposal 保持 PENDING，case 保持 ESCALATED。
- 正常 proposal/accept 继续完成 REMAKE_AND_CONTINUE；正常 reject 回 OPEN。
- Super Admin A 可将 ESCALATED case 交给 Super Admin B；以 OPERATOR 为 target 被拒；`TAKEN_OVER` action 记录 actor/next handler/reason。

## 7. 第 6–7 项：truth-source 与 production migration 约束

- `PRODUCT_DECISIONS.md`、`IMPLEMENTATION_PLAN.md`、`DELIVERY_PRICING_DECISIONS.md`、`ROLE_RESPONSIBILITIES.md`、`EXCEPTION_HANDLING.md`、README 已同步：
  - 商家初始配送金额真实资金语义仍未确认；
  - 当前 reference-only 行为是 provisional runtime，不是产品事实；
  - merchant rescue 新增出资第一版 100% 给 rider；tip 100% 给 rider；platform subsidy 独立；
  - 普通固定地址/位置节点正常履约无需联系/等待；地址错误属于用户责任，额外转送自愿协商；
  - 只有特殊本人交接/强制交付码场景的失联边界仍未决定；
  - non-zero voluntary payment 是支付能力未实现前的安全限制，不是未来支付方式决定。
- `AGENTS.md` 明确：真实生产后不得用普通 migration 静默原地重写已 FINALIZED 财务事实或已生效历史配置；应使用版本化 correction/event/明确迁移策略保留审计历史。
- 旧 `20260926000400_capacity_pool_pricing` 明确标记为 **pre-production semantic rewrite**，不是未来生产财务 migration 范式。本轮未修改该历史 migration，也没有为 demo 历史构造复杂反迁移。

## 8. 第 8 项：rider capacity history backfill

### Migration

`20260927000200_audit_handoff_safety_fixes` 仅在 `Rider.firstNormalDeliveredAt IS NULL` 时回填最早可证明的正常完成时间。可靠条件为同一 assignment/task/order 同时满足：

- `DeliveryAssignment.status = COMPLETED`；
- `DeliveryTask.status = COMPLETED`；
- `DeliveryTask.deliveredAt IS NOT NULL`；
- `Order.status = DELIVERED`。

CANCELLED、EXCEPTION、ABANDONED、无 deliveredAt 或状态不一致的记录不参与回填；已有非 null 事实不被覆盖。

### Test

- Integration test 创建真实 completed assignment + completed task + delivered order，清空 rider facts 后执行 migration SQL；有历史 rider 回填并在下一校园自然日解析为 STANDARD/5，无历史 rider 仍为 null/TUTORIAL。

## 9. 第 9–10 项：Jev 安全基础设施与 operator routing

### Exception classifier

- 新增 `classifyExceptionSafely()`；adapter throw/timeout-like error 时回到 `ManualFallbackClassifier`。
- case 保存 fallback 的真实 `source=MANUAL_FALLBACK`、`version=1`、`confidence=0`，而不是错误记录失败 adapter 的来源。
- deterministic priority 仍保留事实排序，但 `routeSuggestion` 默认 `OPERATOR_POOL`；严重餐损/丢失/配送争议名称本身不再建议超管。
- suggestion 只保存，不自动 claim/escalate/执行资金动作。

### Item classifier

- 产品事实先只读加载并在写事务外分类；remote-like adapter 不会在订单写事务/锁内等待。
- 写事务重新查询并比较 merchant/category/name/category name/price/availability；分类期间事实变化时返回 `PRODUCT_FACTS_CHANGED`，不会拼接旧分类与新商品快照。
- classifier throw 继续回 UNKNOWN/MANUAL_FALLBACK，不阻塞创建；classification 不影响 money/capacity/liability/penalty/eligibility/exposure。

### Tests

- Unit 与 PostgreSQL integration 都覆盖 exception classifier throw 后 case 成功创建及 fallback metadata。
- 可控 item fake classifier 在分类期间修改商品名；订单事务检测变化、拒绝创建且不残留订单，无长 sleep。
- 真实 Jev 仍为 **hook only / not active**。

## 10. 第 11 项：rider order-pool 快照一致性

- Rider DTO 不再同时返回 snapshot label 与 live merchant/location name。
- pickup 返回稳定 `merchantId` + `pickupLocationNameSnapshot/pickupRegionSnapshot`。
- destination 返回稳定 `locationId` + `destinationLabelSnapshot/destinationRegionSnapshot`。
- 创建订单后修改 Merchant、pickup CampusLocation、destination CampusLocation 名称，rider pool 仍只显示创建时权威履约文本；回归测试同时断言三个 live 新名称均不存在。
- Customer/internal funding 等敏感字段负向测试继续通过。

## 11. 第 12 项：deterministic item keyword priority

- CAKE_DESSERT 关键词在泛化饮品关键词“奶”之前匹配。
- 单元测试证明“奶油蛋糕” → `CAKE_DESSERT` + `CRUSH_RISK`。
- 该 fallback 仍是低风险启发式；8000 confidence 不是已校准准确率，也未宣称完整 NLP/高准确率。

## 12. Requirement-to-code checklist

| Task | Runtime enforcement point | Verification |
|---|---|---|
| 1 commission=0 | `seed.ts`, active-config migration, `createOrder()` existing calculation receives 0 | create + delivered settlement integration, empty DB query |
| 2 release semantics | `releaseCompensationReservations()` | exact funding identity + concurrent idempotency integration |
| 3 voluntary funding | `refundAndCloseExceptionCase()` pre-transaction guard | stable 400/no ledger fact integration |
| 4 participant transitions | state machine + `proposeRemake()` / `respondToRemake()` | escalated proposal/accept/reject + normal flows |
| 5 super-admin reassignment | `takeoverExceptionCase()` target level guard | A→B success / OPERATOR reject |
| 6 truth docs | root decision/role/README reconciliation | cross-document text audit |
| 7 migration constraint | `AGENTS.md`, README | documented pre-production limitation |
| 8 capacity backfill | new migration SQL | migration-SQL integration test |
| 9 Jev safety | exception safe wrapper; order preclassification/revalidation | throw fallback + mutating fake integration |
| 10 operator route | deterministic exception classifier | unit + stored integration result |
| 11 snapshot DTO | `delivery/service.ts` explicit select/presenter | rename regression + negative DTO fields |
| 12 cake priority | deterministic item classifier | unit regression |

## 13. Validation results

### Docker preflight

- `docker desktop status`: running。
- `docker info` ServerVersion: `29.8.0`。
- 本轮未重启 Docker；未执行 factory reset、clean/purge、删除 volume 或用户数据目录。

### Targeted tests first

- Targeted unit：3 files / 8 tests 通过。
- Targeted PostgreSQL integration：3 files / 63 tests 通过；此前先成功应用新 migration 并 Seed。

### Full validation

- `pnpm typecheck`：通过。
- `pnpm test`：10 files / 28 tests 通过。
- `pnpm test:integration`：3 files / 63 tests 通过；包含 migrate deploy + Seed。
- `pnpm build`：通过。
- Current DB `prisma migrate status`：15 migrations，schema up to date。
- Migration/schema drift：`No difference detected.`
- Empty DB：从空库顺序应用全部 15 migrations 成功。
- Empty DB Seed：连续两次成功。
- Empty DB post-check：15 个 migration 为 finished；active `platformCommissionBps=0`。
- OpenAPI/权限：既有 docs-path 检查继续通过；OPERATOR/SUPER_ADMIN、rider/customer participant 与资金隔离路径由 PostgreSQL integration 覆盖。
- 临时 shadow/empty verification databases 在验证后按明确名称删除；项目数据库与 Docker volume 未删除。

以上是本地验证结果，不等于独立 CI 验证；当前实现提交没有在本报告中声称存在独立 GitHub Actions run/status。

## 14. Final omissions

- 没有决定或改变商家初始配送费真实结算方式；“50 元商品、5 元配送、商家结算 45”仍只是待 W 验证的问题示例。
- 没有新增 commission 比例、钱包、外部支付、自动追偿、future-income deduction 或 write-off。
- 没有修补需要产品决定的“严重异常未正常送达时 rider base payout 是否 earned”。
- 没有接真实 Jev、没有新增动态定价算法、没有修改 5 单后的升级/降级规则。
- 没有自行进入下一阶段。
