# CODEX_REPORT

## 1. 范围、提交与结论

- 执行任务：`IMPLEMENTATION_PLAN.md` 中“审核修正 + 骑手容错 + 异常订单池 + 管理员分权”。
- 起始提交：`6f7e689a720b7c7bd73247870c4273dd6047dff1`。
- 实现提交：`a6655b1`（`feat: add rider exception operations`）。
- 分支：`main`。
- 实现提交已使用普通 `git push origin main` 推送；未 force push，未 reset/discard/覆盖既有工作。

本轮计划内后端范围已完成。真实支付/Jev 网络调用/自动判责等明确排除项未实现，详见第 8 节。

## 2. 实现真实性分类

### Enforced behavior（运行时已执行）

- TRIAL catalog stable-hash 灰度、显式 100% override、HIDDEN/SUSPENDED 隐藏。
- exposure policy 的 completion/no-rider 与 subsidy dependency + rescue health 分支。
- 独立 recovery window/minimum sample。
- customer/merchant/rider 显式 DTO 与角色权限隔离。
- 取餐前有限无责取消、原 deadline 保留、日内 warning、两条 7 天冷却路径、新 claim 限制、SUPER_ADMIN override。
- 严重餐损/丢失 report、补餐 proposal、用户接受/拒绝、未解决前禁止正常送达。
- ExceptionCase 共享池、CAS 原子领取、release/transfer/takeover/escalate/resolve 审计。
- refund-and-close、部分 settlement reservation、主动支付事实、平台垫付/outstanding、幂等退款和幂等 reservation release。
- OPERATOR / SUPER_ADMIN 权限检查。

### Data / telemetry available（记录事实，但不自动归责）

- `timeRisk`、结构化 `exceptionCounts`、claim latency、subsidy dependency/rescue、platform subsidy consumption。
- cancellation/warning/restriction 历史。
- classifier source/version/result/confidence。
- compensation obligation、allocation、reservation、platform advance 与 outstanding。

### Policy hook / placeholder

- `ExceptionClassifier` typed adapter、deterministic fallback、manual fallback 已就绪。
- 没有真实 Jev 网络调用；分类只建议 category/priority/route，不能执行资金、责任或处罚动作。
- exposure policy 由 SUPER_ADMIN evaluate API 执行；本轮没有新增后台定时批量评估器。

### Not implemented

- 自动判责、自动处罚、AI 判责。
- 真实退款/支付/提现。
- 平台垫付后的未来收入自动抵扣、无限负余额、线下追偿或自动停单。
- 自动分派异常、复杂 SLA/班组、完整后台 UI。
- 普通业务账号多角色。

## 3. Migration

新增正式 migration：

1. `20260926000100_audit_gap_fixes`
   - Merchant `trialExposureOverrideBps`；
   - TRIAL/recovery 配置兼容回填。
2. `20260926000200_rider_exceptions_admin`
   - ADMIN level、骑手取消/限制/审计；
   - ExceptionCase/action/remake；
   - Compensation obligation/allocation 与 `RiderSettlement.reservedMinor`；
   - 数据库 check、unique、partial unique、index、FK；
   - 已存在 ADMIN 安全 backfill 为 SUPER_ADMIN，未来 AdminProfile 默认 OPERATOR；
   - 骑手取消/冷却配置兼容回填。
3. `20260926000300_compensation_release_audit`
   - AdminProfileAudit target FK 完整性。

开发验证中曾发现 `003` 与已应用 `002` 的枚举内容重复；该失败事务整体回滚。随后恢复 `002` 与当前库已应用内容一致，让 `003` 只承载真实增量。最终当前库和空库 migration 均成功，drift 为零。

## 4. 19 项审核清单

### 1. 上轮 6 个审核缺口

1. **TRIAL 灰度**：`catalog/visibility.ts` 使用稳定 hash，catalog 路由真实过滤；单元与 PostgreSQL 集成测试覆盖稳定性、用户差异、override、HIDDEN。
2. **多因素 exposure**：`MerchantExposurePolicy` 同时使用 completion/no-rider 和 subsidy dependency + terminal rescue；单元测试证明补贴健康度可推动 REDUCED。
3. **独立恢复窗口**：新增 recovery window/min sample 配置；policy 只使用独立 recovery terminal population 恢复；单元测试证明样本不足不能恢复。
4. **rescue 口径**：更名为 `subsidizedClaimRescueRateBps`，只使用已到终态的补贴接单样本；集成测试加入多个进行中补贴单后仍保持正确分母。
5. **catalog/raw ORM 泄漏**：catalog、order、delivery task、pricing mutation、settlement、exception view 均改为显式 select/DTO；负向测试检查敏感字段不存在。
6. **rolling population 分离**：terminal、claim、terminal subsidized、published、exception、recovery 各自独立查询；进行中订单不再挤掉终态样本。

### 2. TRIAL 是否真实改变可见性

是。CUSTOMER 目录通过 `SHA-256(merchantId:customerId)` 前 32 bit 对 10000 取模，与 `merchantTrialExposureBps`/merchant override 比较。同一用户稳定，不同用户可不同；Seed 商家显式 override 10000。HIDDEN/SUSPENDED 在查询层始终排除。

stable hash 是第一版 provisional 工程策略，不是永久产品规则；以后可以替换为区域、宿舍或订单样本策略。

### 3. Exposure policy 实际使用与 reserved 输入

实际使用：

- current exposure state；
- entry terminal sample count；
- no-rider rate；
- completionRisk；
- subsidyDependencyBps；
- terminal subsidized rescue rate；
- recovery terminal sample count/no-rider rate；
- recovery subsidy dependency/rescue；
- forcedState。

`timeRisk` 真实用于用户风险提示，但在 exposure 状态迁移中 reserved，不因 SLOW 单独降级。`exceptionCounts` 是管理员事实/telemetry，在责任归因未确认前不参与自动降级。

### 4. Rescue metric 口径

- denominator：窗口内 `claimSampleType=SUBSIDIZED` 且订单已经进入 `DELIVERED` 或 `NO_RIDER_ACCEPTED` 的接单样本数。
- numerator：上述 denominator 中最终 `DELIVERED` 的数量。
- 进行中 CLAIMED/PICKED_UP/READY 等记录不进入 numerator 或 denominator。
- 没有可判断终态补贴样本时返回 `null`，不伪装为 0% 救援率。

### 5. Recovery sample/window

配置：`merchantExposureRecoveryWindowOrderCount` 和 `merchantExposureRecoveryMinimumSampleSize`。恢复查询只取最近 recovery-window 个可判断终态；样本不足、恢复 no-rider 未达阈值或恢复样本补贴健康度差时，当前降级状态保持不变。恢复逐级进行，不能靠一两单直接恢复 NORMAL。

### 6. Customer catalog 泄漏

customer-safe DTO 不返回：

- ownerId；
- deliveryContributionMinor；
- maxConcurrentOrders；
- trialExposureOverrideBps；
- exposureState；
- pickupVerificationMode；
- subsidyAccount；
- order customerId/merchantId；
- platformSubsidyMinor；
- merchantDeliveryContributionMinor；
- event operatorId/metadata。

集成测试 `returns customer-safe catalog and order DTOs without merchant internals` 对完整序列化 body 做负向断言。

### 7. Pre-pickup cancel 与原 deadline

事务锁定 Rider、Order、DeliveryTask；仅当前 rider、CLAIMED、未 pickup、ACTIVE assignment 可执行。只修改 assignment 结束状态、task 当前 rider/claimedAt 和 order pool status；不更新 firstPublishedAt、claimDeadline、finalUserWarningAt、价格、补贴或 tip。

如果释放时原 deadline 已到，事务内立即调用固定 deadline 失败逻辑，进入 NO_RIDER_ACCEPTED。两种行为均有集成测试。

### 8. 日内、7 天、warning/cooldown 与时区

- `campusDay()` 使用配置时区，当前默认 Asia/Shanghai；测试覆盖 UTC 15:59/16:01 的跨校园自然日。
- 每次取消写不可变 RiderCancellationEvent：campusDay、dailyCount、rollingCount、warningIssued。
- 当日第 1 次只记录；第 2 次 warning + 到下一校园日零点的 SAME_DAY pause。
- rolling window 由配置天数计算：第 2 个 warning 触发 warning cooldown；warning 未达到第 2 次但累计取消达到阈值时触发 cancellation cooldown，不补记 warning。
- 所有阈值/时长来自 BusinessConfig。

### 9. Pause/cooldown 对已持订单

限制检查只存在于 `claimTask` 的新 claim 路径。创建限制不更新或结束其他 CLAIMED/PICKED_UP task。集成测试先保留一个已持 task，再触发暂停，证明已持 task 仍为 CLAIMED，而新 claim 返回 409。

### 10. Compensation obligation 与资金来源

`CompensationObligation` 保存 required/current-order/other-unwithdrawn/voluntary/platform-advance/refund/outstanding/status/actor/reason；`CompensationAllocation` 逐笔关联 obligation 和可选 RiderSettlement。

`RiderSettlement.reservedMinor` 支持部分冻结。事务按固定 id 顺序锁定该 rider 的 settlement，使用 `amountMinor - reservedMinor` 计算可用额，并逐笔 reservation；数据库约束保证 reserved 在 `[0, amount]`，并发两笔 obligation 的集成测试证明总 reservation 不超过总余额。

### 11. Refund-and-close 组成与 RiderTip 独立

customer refund = `itemSubtotalMinor + customerDeliveryFeeMinor`，不包含 `customerRiderTipMinor`、商家出资或平台补贴。第一版为内部退款事实，不调用支付网关。

退款事务只写 `customerRefundMinor`/`exceptionCompensationMinor`，不会清零、撤销或重算 RiderTip。集成测试在 tip=30 时执行 refund-and-close，随后仍为 30。

### 12. Platform advance/outstanding

自愿支付与可 reservation 的本单/其他未提现资金不足时：

- 差额写 `platformAdvancedMinor`；
- 同额写 `outstandingMinor` 表示未结事实；
- 用户退款事实立即完成，不等待 rider 补足。

未实现未来收入自动抵扣、自动停单、无限负余额或长期追偿。管理员幂等 release reservation 后，平台承担被释放部分并清零 rider outstanding。

### 13. Exactly-one-active-handler

ExceptionCase 只有一个 `currentHandlerAdminId`。claim 使用 `updateMany where id + version + handler IS NULL + status OPEN` 的原子 CAS；成功后 version 自增。两管理员并发领取测试结果固定为一个 200、一个 409。

### 14. 高风险动作幂等/版本保护

- claim/release/transfer/takeover/escalate/non-economic resolve：version/CAS + transaction。
- refund/freeze/close：case row lock + unique case obligation + unique idempotencyKey + transaction。
- settlement reservation：row lock + reservedMinor + allocation unique/index/DB checks。
- release reservation：case row lock + unique nullable releaseIdempotencyKey + releasedAt + transaction。
- 并发重复 refund、并发不同 obligation 争抢余额、重复 release 均有集成测试。

### 15. `/admin/**` 权限矩阵

| Endpoint | OPERATOR | SUPER_ADMIN |
|---|---:|---:|
| GET/PUT `/admin/business-configs/:key` | 禁止 | 允许 |
| POST `/admin/orders/:orderId/platform-subsidies` | 禁止 | 允许 |
| GET `/admin/merchants/:merchantId/fulfillment-risk` | 禁止 | 允许 |
| POST `/admin/merchants/:merchantId/exposure/evaluate` | 禁止 | 允许 |
| PUT `/admin/users/:userId/admin-profile` | 禁止 | 允许 |
| GET/POST `/admin/riders/:riderId/restrictions` | 禁止 | 允许 |
| PATCH `/admin/rider-restrictions/:restrictionId` | 禁止 | 允许 |
| POST `/admin/orders/:orderId/exception` | 允许 | 允许 |
| GET `/admin/exception-cases[/:caseId]` | 允许 | 允许 |
| POST case `/claim` | 允许 | 允许 |
| POST case `/release` | 自己处理的 case | 允许接管范围 |
| POST case `/transfer` | 自己处理的 case | 允许 |
| POST case `/escalate` | 自己处理的 case | 允许 |
| POST case `/resolve` | 自己处理的标准结果 | 允许 |
| POST case `/release-compensation` | 自己处理的 case | 允许 |
| POST case `/takeover` | 禁止 | 允许 |

Generic order/pricing/timeline admin access仅 SUPER_ADMIN；OPERATOR 通过 case detail 获得处理该异常所需的显式 DTO、时间线、证据和订单级资金事实。

### 16. 普通管理员是否能真正处理

能。OPERATOR 可自行领取、查看 detail、请求材料、作出 responsibility-undetermined/continue/wait 等人工判断、执行系统计算金额的 refund-and-close、释放 reservation、转交或升级。测试覆盖 OPERATOR 直接完成人工“证据不足”结论及标准退款，不要求所有案件升级 SUPER_ADMIN。

### 17. Jev/AI 状态

**adapter/hook ready, not active**。

当前运行的是 deterministic classifier；manual fallback 可用。没有外部 Jev 请求、凭据或公网测试。classifier result 与最终 resolution 分字段保存。AI/分类器没有资金、责任、处罚或限制执行权限。

### 18. 验证结果

- Docker Desktop：首次检查未运行；按 AGENTS.md 仅执行一次安全 `docker desktop start`，之后 `running`。
- Docker Engine：ServerVersion `29.8.0`。
- destructive Docker recovery：未执行；未删除项目 volume/data。
- current DB migrate/status：11 migrations，up to date。
- typecheck：通过。
- unit tests：6 files / 18 tests 通过。
- PostgreSQL integration：2 files / 44 tests 通过。
- build：通过。
- OpenAPI：新 exception/rider/admin paths 在集成测试中存在，权限测试通过。
- empty DB：从零执行全部 11 migrations 成功。
- empty DB Seed：连续两次成功。
- migration/schema drift：`No difference detected.`
- 临时 verify/shadow 数据库仅为本轮创建，验证后删除；项目数据库和 Docker volume 未删除。

### 19. 已知问题与刻意未实现

- stable-hash TRIAL 只是 provisional 第一版，不是永久产品规则。
- exposure evaluate 不是后台自动批处理；由 SUPER_ADMIN 显式触发。
- timeRisk 和 exceptionCounts 不参与 exposure 自动降级，前者只作用户提示，后者等待责任归因规则。
- minor damage/delay 若双方私下协商一致无需建 case；只有主动调用异常 API 才记录正式 case。
- voluntary payment、customer refund、platform advance 当前都是内部账务事实，没有真实 wallet/payment gateway。
- 平台垫付后的追偿、未来收入抵扣和恢复接单规则未实现。
- Admin 第一版只有 level，没有更细 capability/二次审批。
- 没有真实 Jev、自动下派、SLA、完整 UI、真实媒体存储或微信登录。
- 未定义严重餐损/丢失固定责任比例或商家分摊。

## 5. 测试覆盖与主要文件

- 审核缺口策略：`merchant-risk/*`、`catalog/visibility.ts`、`catalog-visibility.test.ts`、`policies.test.ts`。
- 角色 DTO：catalog/order/delivery/pricing/settlement/exception services 与 `exception-flow.test.ts` 负向断言。
- 骑手取消/限制：`riders/restrictions.ts`、`riders/routes.ts`。
- 异常池：`exception-cases/service.ts`、`exception-cases/routes.ts`。
- 赔付：`compensation/service.ts`。
- 分类：`exceptions/classifier.ts`。
- 端到端安全测试：`tests/integration/exception-flow.test.ts`。

本轮完成后停止，未进入微信登录、真实支付、自动下派或下一阶段设计。
