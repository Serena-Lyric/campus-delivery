# CODEX_REPORT

## 1. 执行范围与提交

- 任务：`IMPLEMENTATION_PLAN.md` 中“商家履约风险、曝光策略与 24 小时骑手激励”。
- 起始提交：`0abb53ce85c505382eb7aae7d61f96b199968782`。
- 实现结束提交：`87d7cb4`（`feat: add merchant fulfillment risk controls`）。
- 工作分支：`main`。
- 实现提交已通过普通 `git push origin main` 推送；未使用 force push。

## 2. 完成内容

### 2.1 24 小时骑手激励窗口

- `BusinessConfig.ORDER_POLICY` 新增 `riderTipWindowSeconds`，Seed 演示值为 86400。
- `Order` 新增不可空 `tipDeadline`；订单创建时根据当时配置形成快照，后续配置修改不会追溯改变既有订单。
- `adjustRiderTip` 在服务端使用 `now >= tipDeadline` 拒绝新增或调整，错误码为 `RIDER_TIP_WINDOW_ENDED`。
- 接单前仍允许正向或负向调整未锁定激励；接单后只允许正向追加。
- 正常送达后，只要仍在 `tipDeadline` 前，仍可追加；追加金额同步增加已完成 assignment、Settlement 和 RiderSettlement，100% 归当前骑手。
- `CANCELLED`、`NO_RIDER_ACCEPTED`、`EXCEPTION` 终态即使仍在时间窗口内也拒绝调整。

### 2.2 补贴事实与曝光解耦

- 删除了 `addPlatformSubsidy` 调用 `exposureForUsage` 并直接更新 `Merchant.exposureState` 的路径。
- `exposureForUsage` 已从正常代码和测试中删除。
- `MerchantSubsidyAccount.riskScore` 通过正式 migration 改名为语义准确的 `subsidyUsageBps`。
- 平台补贴仍维护预算使用事实和 `subsidyUsageBps`，但不再产生曝光状态副作用。
- 既有补贴步长、间隔、单订单上限、商家预算占用限制和不可变历史保持不变。

### 2.3 商家履约事实指标

新增独立 `merchant-risk` 模块，按配置窗口从订单、DeliveryTask、DeliveryAssignment、OrderPricing 和 ExceptionEvent 按需计算：

- publishedOrderCount；
- deliveredOrderCount；
- noRiderAcceptedCount；
- observableTerminalOrderCount；
- observableCompletionRateBps / noRiderAcceptedRateBps；
- 平均、P50、P90 接单耗时；
- 平均接单到取餐、取餐到送达、首次入池到送达耗时；
- naturalClaimCount / subsidizedClaimCount；
- subsidyDependencyBps；
- subsidizedClaimConversionBps；
- platformSubsidyUsedMinor；
- completedOrderSubsidyMinor / 每完成订单补贴；
- 按 ExceptionEvent.type 分组的结构化异常事实。

统计层只描述可观察事实。完成率分母只使用 `DELIVERED` 与 `NO_RIDER_ACCEPTED` 终态；`CANCELLED`、`EXCEPTION` 和结构化异常不会被自动归为商家责任。

### 2.4 独立风险结论与曝光策略

- 新增 `MerchantTimeRisk`：`UNKNOWN / NORMAL / SLOW`。
- 新增 `MerchantCompletionRisk`：`UNKNOWN / NORMAL / ELEVATED / HIGH`。
- 时间风险使用已完成订单的总履约时间样本；完成风险使用可观察终态中的无人承接比例，两者独立计算。
- 新增 `TRIAL` exposure state，并将新 Merchant 的数据库默认值设为 `TRIAL`；现有商家不被 migration 强制改写，Seed 演示商家明确保持 `NORMAL`。
- 样本不足时风险为 `UNKNOWN`，曝光策略保持当前状态，不因少量订单定性。
- `MerchantExposurePolicy` 接收当前状态、timeRisk、completionRisk、补贴依赖/救援事实、结构化异常事实、样本量和可选管理员强制状态。
- SLOW 不参与自动降曝光；曝光进入阈值与恢复阈值分离，恢复逐级进行，避免抖动。
- `HIDDEN / SUSPENDED` 不被普通自动评估解除；管理员可显式强制状态。
- 实际状态变化写入 `MerchantExposureDecision`，包含前后状态、timeRisk、completionRisk、策略版本、原因、指标快照、操作者和时间。
- 当前通过管理员 evaluate API 显式执行策略，不在后台自动批量改变商家曝光。

### 2.5 配置与角色隔离 API

在现有版本化 `BusinessConfig + BusinessConfigAudit` 中增加并校验：

- riderTipWindowSeconds；
- merchantRiskWindowOrderCount；
- merchantRiskMinimumSampleSize；
- slowFulfillmentThresholdSeconds；
- completionRiskElevatedThresholdBps / completionRiskHighThresholdBps；
- exposureReduced / Limited / SeverelyLimited 进入阈值；
- exposureNormal / Reduced / Limited 恢复阈值；
- subsidyDependencyThresholdBps / subsidyRescueThresholdBps。

校验包括最低样本不超过窗口、风险阈值顺序、曝光进入阈值顺序，以及恢复阈值必须低于对应进入阈值。

新增/更新 API：

- 用户目录 `/merchants` 和商家商品页仅返回简化 `timeRisk / completionRisk / sampleStatus`。
- 商家 `/merchant/fulfillment-risk` 返回自身履约事实摘要，不返回平台补贴金额、依赖阈值或内部曝光决策历史。
- 管理员 `/admin/merchants/:merchantId/fulfillment-risk` 返回完整指标、补贴事实和曝光审计。
- 管理员 `/admin/merchants/:merchantId/exposure/evaluate` 执行策略评估或显式强制状态。
- OpenAPI 版本更新为 0.4.0，集成测试验证上述路径已发布。

### 2.6 生命周期处理修正

- 后台 processor 现已实际调用 `expireUnclaimedDeliveryTasks`。此前该函数存在且有测试，但未加入定时 processor；现在 40 分钟无人承接终态会在启用后台任务时被扫描处理。

## 3. Migration

新增两个 migration，以避免 PostgreSQL 在同一事务中新增枚举值并立即使用该值的限制：

1. `20260924000100_merchant_fulfillment_risk`
   - 为 `MerchantExposureState` 增加 `TRIAL`。
2. `20260924000200_merchant_fulfillment_risk_models`
   - 新增 time/completion risk 枚举；
   - 新增 `Order.tipDeadline` 并按 `createdAt + 24 hours` 回填历史订单；
   - 将 `riskScore` 改名为 `subsidyUsageBps`；
   - 新增 `MerchantExposureDecision` 和约束/索引/外键；
   - 将现有 ORDER_POLICY payload 从旧 exposureThresholds 转换为新的版本化风险配置字段。

现有数据库第一次验证时暴露了枚举同事务使用限制；该 migration 整体回滚，没有部分数据变更。随后拆分为上述两个 migration，并在同一现有数据库上成功升级。

## 4. 审核重点逐项回答

1. **24 小时 tip window 是否服务端强制，送达后能否追加，超时是否拒绝？**
   - 是。服务端以订单快照 `tipDeadline` 强制；截止前 1ms 允许、截止时拒绝；正常送达后截止前仍可追加并进入骑手结算。
2. **是否彻底移除“补贴使用率直接更新 exposureState”的正常业务路径？**
   - 是。补贴 service 不再写 Merchant.exposureState；集成测试验证追加补贴后状态保持不变。
3. **原 riskScore 是否还存在误导语义；如何处理？**
   - 当前 schema 和业务代码中已不存在；migration 将其改名为 `subsidyUsageBps`，明确表示事实指标。
4. **Merchant fulfillment metrics 是否只记录事实，没有擅自完成责任归因？**
   - 是。异常按类型计数；不把 USER、地址、骑手、系统或其他 EXCEPTION 自动算作商家过错。
5. **timeRisk 与 completionRisk 是否真正独立？**
   - 是。分别使用已完成订单时长样本和可观察终态的无人承接比例；单元测试验证 SLOW 可与 completion NORMAL 并存。
6. **SLOW 是否可以保持 NORMAL 曝光？**
   - 是。曝光策略不使用 timeRisk 单独降级。
7. **样本不足的新商家是否得到 UNKNOWN/TRIAL？**
   - 是。新 Merchant 默认 TRIAL；样本不足返回 UNKNOWN，集成测试验证不会改变曝光。
8. **Exposure policy 是否有最低样本、进入/恢复滞后和审计？**
   - 是。最低样本来自版本化配置；进入/恢复阈值分离且逐级恢复；实际状态变化写入 MerchantExposureDecision。
9. **是否存在隐藏路径仍按 subsidy usage 自动降曝光？**
   - 未发现。全仓搜索仅在历史 migration、计划/任务文本和改名 migration 中出现旧 riskScore/exposureThresholds；运行时代码没有该联动。
10. **风险阈值是否全部来自版本化配置？**
    - 是。运行时从 ORDER_POLICY 读取；Seed/migration 数值明确是兼容和演示默认值，不作为长期产品规则。
11. **用户、商家、管理员风险信息是否符合隔离原则？**
    - 是。用户只看简化风险；商家看自身运营事实；管理员看完整指标、补贴事实和策略审计。
12. **migration、测试、typecheck、build、空库 migration/Seed 是否通过？**
    - 是，最终结果全部通过，详见下一节。
13. **Docker 异常是否按 AGENTS.md 区分？**
    - 本轮 Docker CLI 健康，无基础设施异常；未执行重启、Clean/Purge、Factory Reset、删除卷或其他破坏性恢复。

## 5. 验证结果

- Docker Desktop CLI：`running`。
- Docker Engine：ServerVersion `29.8.0`。
- 现有数据库 `prisma migrate deploy`：8 个 migration，全量 up to date。
- `pnpm typecheck`：通过。
- `pnpm test`：5 个测试文件、14 个单元测试通过。
- `pnpm test:integration`：1 个测试文件、27 个 PostgreSQL 集成测试通过。
- `pnpm build`：通过。
- OpenAPI：集成测试验证 3 个 merchant-risk 路径存在。
- 空库 migration：从零执行全部 8 个 migration 成功。
- 空库 `prisma migrate status`：Database schema is up to date。
- 空库 Seed：连续执行两次成功。
- Prisma migration/schema drift：`No difference detected.`
- 空库与 shadow 验证使用本轮新建的专用临时数据库，验证后仅删除这两个临时数据库；项目现有数据库和 Docker volume 未删除。

## 6. 已知问题与刻意未实现

- 未实现自动责任归因；`observableCompletionRateBps` 不等于商家责任完成率。
- 未实现单一综合商家评分、商品口味评价、AI 风险判断、自动处罚或骑手淘汰。
- 未自行定义“严重风险立即自动暂停”的算法；保留管理员强制 `HIDDEN / SUSPENDED` 能力。
- 曝光策略当前由管理员 evaluate API 显式执行，未增加后台自动批量评估，以免在责任归因和正式阈值未确认前自动扩大影响。
- 风险指标当前按配置窗口在线聚合，未引入数据仓库、定时快照或复杂 percentile 基础设施；已提供平均值及 claim latency P50/P90。
- Seed 中所有风险阈值、24 小时秒数和演示商家 NORMAL 状态都是演示/兼容配置，不是长期商业决策。
- 未实现完整管理员前端、真实支付/退款/提现、单账号多角色、微信登录或下一阶段功能。

## 7. 文档

- README 已更新当前阶段、配置、24 小时激励、履约风险、角色隔离、API 和测试覆盖。
- OpenAPI 元信息与路由已更新。

本轮完成后停止，未自行进入下一阶段。
