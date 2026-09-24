# IMPLEMENTATION_PLAN

> 本文件记录下一轮 Codex 的实现计划与第一版工程默认值。
> `PRODUCT_DECISIONS.md` 是产品规则最高依据；本文件不得创造未确认的产品规则。
> Seed、测试夹具和第一版阈值都只是演示/工程默认值，不能自动升级为正式商业参数。

## 下一轮：商家履约风险、曝光策略与 24 小时骑手激励

### 目标

在保持上一轮市场报价、增量补贴、40 分钟接单窗口和结算模型不变的前提下：

1. 落实订单创建后 24 小时骑手激励窗口；
2. 移除“补贴使用率直接决定商家曝光”的过度简化；
3. 建立可审计的商家履约事实指标；
4. 将用户时间风险提示与订单完成风险提示分离；
5. 建立可配置、带最低样本量和滞后的商家曝光状态策略基础；
6. 不在本轮擅自完成订单失败责任归因。

### 1. 24 小时骑手激励窗口

- 用户骑手激励操作窗口从 Order.createdAt 开始计算 24 小时。
- 24 小时内：
  - 骑手接单前允许正向追加和减少/撤回未锁定激励；
  - 骑手接单后只允许正向追加；
  - 正常送达后只要仍在 24 小时内，仍允许继续追加，作为事后打赏。
- 超过 24 小时后，任何新增/调整 RiderTip 都必须由服务端拒绝。
- 时间判断必须在服务端执行，不依赖前端隐藏按钮。
- 将 tip window 时长设计为 BusinessConfig 参数，例如 `riderTipWindowSeconds`，第一版 Seed 演示值为 86400。
- 订单创建时是否需要快照该时长由实现选择，但必须保证管理员修改配置不会意外追溯改变已经明确承诺给用户的交易条件；优先考虑在订单上保存 tipDeadline。
- 接单后异常退款规则仍未决定，本轮不得自行补自动退款逻辑。
- 补充边界测试：刚好截止前、截止时、送达后追加、接单前负向调整、接单后负向调整、NO_RIDER_ACCEPTED/CANCELLED/EXCEPTION 等终态。

### 2. 移除“补贴使用率直接改变曝光状态”

当前 `addPlatformSubsidy` 会通过 `exposureForUsage(...)` 根据 MerchantSubsidyAccount 的使用率直接更新 Merchant.exposureState。该行为与最新产品设计不一致。

本轮要求：

- 平台补贴写入仍更新商家补贴预算使用事实，但不得因为“补贴额度用了多少”直接修改 Merchant.exposureState。
- `riskScore` 如果实质上只是 subsidy usage BPS，不得继续把它表达成“风险评分”；可以迁移为语义准确的字段/统计值，或者停止把它用于风险结论。
- 保留补贴使用率作为事实指标。
- 旧 `exposureForUsage` 如果仍用于其他兼容路径，必须明确隔离；不能继续作为商家曝光决策的主入口。
- 不要因为本轮重构而改变已确认的补贴步长、预算和价格承诺规则。

### 3. 商家履约事实统计

建立独立、可测试的 MerchantFulfillmentMetrics / MerchantPerformanceSnapshot（名称可调整）计算层，不把统计逻辑散落在路由中。

至少支持：

- publishedOrderCount
- deliveredOrderCount
- noRiderAcceptedCount
- observableCompletionRateBps
- average / percentile-ready claim latency（首次入池→接单）
- average claim-to-pickup seconds
- average pickup-to-delivery seconds
- average total fulfillment seconds
- naturalClaimCount
- subsidizedClaimCount
- subsidyDependencyBps
- subsidizedClaimConversion / rescue related facts
- platformSubsidyUsedMinor
- completedOrderSubsidyMinor 或可用于计算“每完成订单补贴消耗”的数据
- structured exception counts，按 ExceptionEvent.type 分组或保留可扩展结构

注意：

- 统计层描述事实，不自动声称责任。
- 当前“observableCompletionRate”只是平台观察到的最终完成情况，不等于“商家责任完成率”。
- USER/地址错误/骑手/系统等异常尚未完成归因，不得自动算入商家过错。
- 如果某项数据当前模型无法可靠计算，保留 null / insufficient-data，不要编造。
- 对 claim latency 等分布，优先设计可扩展的聚合/查询接口；不要为了本轮引入复杂数据仓库。

### 4. 用户风险提示：时间风险与完成风险分离

建立两个独立的、后端可返回的商家风险结论：

- timeRisk：例如 UNKNOWN / NORMAL / SLOW
- completionRisk：例如 UNKNOWN / NORMAL / ELEVATED / HIGH

具体枚举名称可以调整，但语义必须分离。

规则：

- 样本不足时返回 UNKNOWN/INSUFFICIENT_DATA，不得用少量订单强行判断。
- SLOW 可以与正常曝光状态并存；不能因为“慢但能完成”自动降曝光。
- completionRisk 才可作为曝光策略的重要输入之一。
- 本轮不要求确定正式阈值；阈值、样本量、统计窗口全部进入 BusinessConfig。
- Seed 可以提供明确标注为 DEMO 的保守值供测试。
- Catalog/merchant detail API 应能返回用户真正需要的风险提示结果或结构化字段，使未来小程序能在进入风险商家前弹窗。
- 不向用户暴露内部补贴金额、复杂评分或责任归因细节。

### 5. 商家曝光状态策略

建立独立 MerchantExposurePolicy / MerchantFulfillmentPolicy，不允许继续由补贴 service 直接决定 exposureState。

策略输入至少包括：

- 当前 exposureState；
- 是否为 TRIAL/样本不足；
- completionRisk；
- timeRisk（只作事实输入，不能单独把“慢”当失败）；
- 补贴依赖/救援事实；
- 结构化异常事实；
- 管理员强制状态（如果现有模型没有，可预留接口，不必本轮做 UI）。

策略要求：

- 支持 TRIAL / NORMAL / REDUCED / LIMITED / SEVERELY_LIMITED / HIDDEN / SUSPENDED 或与现有枚举等价的状态。
- 时间风险 SLOW 本身不得直接把 NORMAL 商家降级。
- 使用最低样本量。
- 使用进入阈值和恢复阈值分离的 hysteresis，避免单笔订单导致状态来回抖动。
- 普通策略变更要记录原因、前后状态、策略版本、指标快照/摘要和时间，便于审计。
- 严重风险立即暂停的具体条件尚未决定；本轮只保留接口/管理员能力，不自行定义“严重风险”算法。
- 因订单责任归因未定，本轮自动降级不得把所有未完成订单视作商家责任。

### 6. TRIAL / 冷启动语义

- 新商家样本不足时保持 TRIAL/观察期语义。
- W 推荐的种子商家可以通过配置/管理员标记获得大范围初始曝光，但不获得永久豁免。
- 不因为前几单中的单次失败直接进入 HIGH 风险。
- 达到最低样本量后才进入正式风险分类。
- 本轮若现有 Merchant.exposureState 没有 TRIAL，可通过独立 verification/market state 或兼容枚举实现；优先最小迁移，不要为了命名重写全表。

### 7. 管理员配置

在现有版本化 BusinessConfig + Audit 基础上扩展，而不是新造第二套配置系统。

至少预留/实现：

- riderTipWindowSeconds（第一版 demo 86400）
- merchantRiskWindowOrderCount / 或等价统计窗口
- merchantRiskMinimumSampleSize
- slowFulfillmentThresholdSeconds 或更合适的时间风险阈值结构
- completionRiskElevatedThresholdBps
- completionRiskHighThresholdBps
- exposure downgrade / recovery thresholds
- recovery minimum sample/window
- subsidyDependency threshold(s)
- subsidyRescue threshold(s)

要求：

- 数值为管理员可调，代码不得散落魔法数字。
- 配置 schema 要校验阈值顺序和合理范围。
- 不要求本轮做完整管理员前端。

### 8. API / 查询

至少提供：

- 管理员查询商家履约指标与当前风险/曝光决策详情；
- 用户/目录查询得到简化的 timeRisk、completionRisk 和必要提示信息；
- 商家自身可查看与自己相关的履约事实摘要，但不要暴露平台内部补贴来源/策略细节；
- 风险决策结果必须与角色价格视图保持既有隔离原则。

### 9. 不做

- 不做商品评分/口味评价。
- 不做单一综合“商家分数”。
- 不做 AI 风险判断。
- 不做自动责任归因。
- 不做骑手处罚/淘汰。
- 不做完整管理前端。
- 不做真实支付退款/提现。
- 不修改单账号单角色模型。
- 不改变上一轮已经确认的订单报价、补贴、接单与结算结构，除非为本轮兼容所必需。

### 10. Docker / 验证

严格遵守根目录 `AGENTS.md`：

- Docker/PostgreSQL 测试前先做 CLI 健康检查；
- Docker 不可用最多安全重启一次；
- 不得自动 Clean/Purge data、Factory Reset、删除 Docker 数据或卷；
- 基础设施失败必须与代码失败分开报告。

完成后运行：

- typecheck；
- unit tests；
- PostgreSQL integration tests；
- build；
- migration status / drift；
- 从空库完整 migration；
- Seed 至少连续执行两次；
- 必要的 OpenAPI 路径检查。

### 11. 审核重点

`CODEX_REPORT.md` 必须逐项回答：

1. 24 小时 tip window 是否由服务端强制，送达后 24 小时内是否仍可追加，超时是否拒绝。
2. 是否彻底移除了“补贴使用率直接更新 exposureState”的正常业务路径。
3. 原 riskScore 是否还存在误导语义；如何处理。
4. Merchant fulfillment metrics 是否只记录事实、没有擅自完成责任归因。
5. timeRisk 与 completionRisk 是否真正独立。
6. SLOW 是否可以保持 NORMAL 曝光。
7. 样本不足的新商家是否得到 UNKNOWN/TRIAL，而不是被少量订单直接定性。
8. Exposure policy 是否拥有最低样本量、进入/恢复滞后和审计记录。
9. 是否存在任何隐藏路径仍按 subsidy usage 自动降曝光。
10. 风险阈值是否全部来自版本化配置而非散落硬编码。
11. 用户、商家、管理员三个角色看到的风险信息是否符合既有隔离原则。
12. migration、测试、typecheck、build、空库 migration/Seed 是否全部通过。
13. Docker 若发生异常，是否按 AGENTS.md 正确区分为基础设施问题。

完成后停止，不自行进入骑手异常退出、支付或微信登录等下一阶段。


## 审核后待修正

以下项目经代码审核确认仍未完整实现，下一轮开发前必须先修正，不得视为本阶段已完成：

1. **TRIAL 只有状态语义，没有真正灰度曝光**
   - 当前目录对 TRIAL 与 NORMAL 基本同等返回。
   - 后续需要实现实际曝光差异/灰度范围，或明确由管理员/配置控制的种子商家豁免。

2. **曝光策略仍然近似单因素**
   - MerchantExposurePolicy 虽然接收 subsidyDependencyBps、subsidizedClaimConversionBps、exceptionCounts、timeRisk 等输入，但当前实际状态迁移只依赖 noRiderAcceptedRateBps（除 forcedState / sample guard 外）。
   - 后续必须明确哪些已确认的补贴健康度事实真正参与曝光决策；未启用的输入不得在报告中描述为已生效策略。

3. **恢复机制缺少独立 recovery sample/window**
   - 当前仅实现进入/恢复阈值分离的 hysteresis。
   - IMPLEMENTATION_PLAN 曾要求 recovery minimum sample/window，尚未独立实现。
   - 后续需要补充恢复样本/窗口约束，避免短期低失败率立即恢复。

4. **补贴救援率分母包含进行中订单**
   - 当前 subsidizedClaimConversionBps = 已送达的补贴接单 / 全部补贴接单。
   - 尚未终态的进行中订单会被隐式计入分母并压低实时“救援率”。
   - 后续应明确 numerator/denominator，仅用适合的终态样本，或重命名为不误导的指标。

5. **用户商品接口存在角色数据泄漏**
   - `GET /merchants/:merchantId/products` 当前展开完整 Merchant ORM 记录。
   - 用户可能看到 `deliveryContributionMinor`、`maxConcurrentOrders`、`exposureState`、`ownerId` 等内部字段。
   - 这违反三方价格视图隔离；下一轮必须改为显式 customer-safe DTO/select，并增加敏感字段“不应出现”的负向测试。
   - 同时复查所有 customer-facing catalog/order API，避免类似 raw ORM spread。

6. **滚动窗口对进行中订单的处理需重新确认**
   - 当前先取最近 N 个 published DeliveryTask，再从中计算 terminal 风险指标。
   - 大量新进行中订单可能挤掉较老但有效的终态样本，导致 sampleStatus/风险结论暂时退回 UNKNOWN。
   - 后续应为 terminal completion/time metrics 与 live claim/subsidy metrics 使用合适的独立样本集合，或明确记录并接受该行为。

以上属于实现/统计边界修正，不改变已确认产品方向。
