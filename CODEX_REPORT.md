# CODEX_REPORT

## Commit 范围

- 本轮起始 commit：6a039b4
- 本轮结束代码 commit：待代码提交后回填
- 最终报告提交：本文件定稿所在 commit
- 分支：main
- 远程：origin/main

## 任务结论

已完成 IMPLEMENTATION_PLAN.md 中“下一轮：市场报价、接单时限与策略纠偏”的后端范围。没有修改单账号单角色模型，没有加入评分、自动判责、自动处罚、自动派单、路线规划或 AI 规则。

## 修改概览

- 商家订单级配送报价、版本历史和改价冷却
- 用户骑手激励独立账本
- 骑手接单瞬间原子价格快照
- 固定 firstPublishedAt、claimDeadline 和最终提醒时间
- NO_RIDER_ACCEPTED 终态及退款记录边界
- 商家备餐/可取自报信号与真实 pickup 解耦
- 平台增量补贴及三个策略接口
- 自然接单与补贴后接单样本隔离
- 角色隔离价格视图
- 管理员业务配置版本和审计
- 国内校园默认时区改为 Asia/Shanghai
- README、OpenAPI、Seed、migration 和测试更新

## 审核重点逐项回答

### 1. 商家报价是否有版本历史和冷却

是。

MerchantDeliveryQuote 不可变记录每次报价的版本、旧金额、新金额、操作者、原因和时间。OrderPricing 保存当前报价、当前版本和最后改价时间。

merchantRepriceCooldownSeconds 来自版本化 BusinessConfig，Seed 演示值为 15 秒。订单发布时把冷却秒数和策略版本写入 DeliveryTask，管理员后续修改配置不会追溯改变已有订单的改价权利。

### 2. 骑手接单瞬间价格是否原子冻结

是。

claimTask 在事务内依次锁定 Rider、Order 和 DeliveryTask，重新读取 OrderPricing，并在更新任务和订单状态的同一事务中创建 DeliveryAssignment。

DeliveryAssignment 冻结：

- merchantQuoteMinorAtClaim
- customerTipMinorAtClaim
- platformSubsidyMinorAtClaim
- riderPayoutMinorAtClaim
- quoteVersionAtClaim
- claimSampleType
- claimLatencySeconds

改价、补贴、用户激励和接单使用一致的行锁顺序，测试覆盖并发改价与接单。

### 3. 用户激励是否与商家报价、平台补贴分账

是。

OrderPricing 分别保存：

- merchantDeliveryContributionMinor
- customerRiderTipMinor
- platformSubsidyMinor

RiderTipEvent 独立保存每次用户激励变化。MerchantDeliveryQuote 和 SubsidyRecord 分别保存商家报价与平台补贴历史。管理员价格视图可查看全部来源。

### 4. 接单后新增用户激励是否 100% 归当前骑手

是。

接单后只允许正向追加。追加金额增加 DeliveryAssignment.postClaimTipMinor、OrderPricing.riderPayoutMinor、已完成 Settlement.riderPayableMinor 和 RiderSettlement.amountMinor。

平台收入不因用户追加激励增加。集成测试验证追加 25 分时骑手应付增加 25 分，平台收入保持不变。

### 5. 是否取消正常主动 abandon 回池

是。

公开 abandon 路由和服务已移除，CLAIMED → READY_FOR_RIDER 状态回退也已从状态机删除。对旧路径请求返回 404。

DeliveryAssignmentStatus.ABANDONED 和旧 OrderEvent 枚举只为历史 migration/数据兼容保留，不存在正常业务写入路径。

### 6. 40 分钟到期是否形成明确结果

是。

商家确认时直接创建 DeliveryTask，并保存固定的 firstPublishedAt、claimDeadline、finalUserWarningAt 和策略版本。Seed 演示 orderClaimWindowSeconds 为 2400 秒。

后台 expireUnclaimedDeliveryTasks 把仍为 OPEN 且到期的任务和订单原子更新为 NO_RIDER_ACCEPTED，记录系统事件，并写入 customerRefundMinor、customerRiderTipRefundMinor 和 RiderTipEvent.NO_RIDER_REFUND。

没有任何正常回池路径会刷新截止时间。

### 7. 商家 ready 是否与真实交接解耦

是。

商家确认订单后立即进入 READY_FOR_RIDER 并出现在骑手池。/merchant/orders/:orderId/ready 只更新 merchantPreparationStatus 为 READY_FOR_PICKUP 并记录自报事件，不创建任务、不触发补贴、不代表真实交接。

骑手 pickup 仍是商家到骑手责任交接的重要事实节点。

### 8. 普通订单照片是否仍被错误强制

否。

deliveryEvidenceRequired 默认为 false。普通非验证码订单可以不提交照片直接完成。

以下情况仍强制证据：

- deliveryEvidenceRequired 明确为 true
- 用户失联且使用允许无人接触投递的方式
- HANDOFF_CODE 模式要求交付码

Evidence 保持可选事实工具，没有照片不自动代表骑手有责。

### 9. targetRiderPayout 自动补贴是否移除

是。

PolicyConfig、Seed、订单确认和商家 ready 流程均不再包含 targetRiderPayout 或差额补足函数。

商家确认只建立商家报价，平台补贴初始为 0。商家 ready 不产生补贴。

### 10. 平台补贴是否逐步追加且可追溯

是。

管理员通过 /admin/orders/:orderId/platform-subsidies 发起受控增量。每次 SubsidyRecord 保存：

- previousPlatformSubsidyMinor
- addedMinor
- newPlatformSubsidyMinor
- occurredAt / createdAt
- policyVersion
- trigger

订单接单后不能继续追加平台补贴。

### 11. 补贴约束是否全部由服务端执行

是。

服务端执行：

- platformSubsidyStepMinor
- platformSubsidyMaxStepMinor
- platformSubsidyMaxPerOrderMinor
- platformSubsidyMinIntervalSeconds
- merchantSubsidyBudgetMaxUsageBpsPerOrder
- 商家剩余风险预算
- firstPublishedAt / claimDeadline
- 已接单状态检查

测试验证单次上限、累计上限、最短间隔和预算占用。

### 12. 是否存在一次吃完商家补贴预算的路径

正常服务路径不存在。

BudgetSubsidyEligibilityPolicy 同时限制单订单预算比例，并至少保留 1 个最小货币单位的商家剩余预算；CappedSubsidyIncrementPolicy 继续限制单次步长和单订单累计金额。

数据库记录仍可由具备数据库写权限的运维人员直接修改，这不属于业务 API 路径。

### 13. 自然接单与补贴后样本是否隔离

是。

DeliveryAssignment.claimSampleType 明确区分 NATURAL 和 SUBSIDIZED。

claimTask 根据接单瞬间 platformSubsidyMinor 是否为 0 写入类型。NaturalClaimTimingPolicy 的商家基线查询只读取 NATURAL 样本，补贴后接单不会污染自然接单速度。

同时记录 claimLatencySeconds 和接单时商家报价，后续可计算市场指标。

### 14. 三个补贴策略边界是否独立可替换

是。

独立接口和默认实现：

- SubsidyEligibilityPolicy / BudgetSubsidyEligibilityPolicy
- SubsidyTimingPolicy / NaturalClaimTimingPolicy
- SubsidyIncrementPolicy / CappedSubsidyIncrementPolicy

addPlatformSubsidy 通过 SubsidyPolicies 注入这三个策略，不依赖复杂评分算法。

资格上下文已提供商家发布订单数、完成订单数、完成率、当前报价和自然成交报价平均值；第一版只执行已确认的预算规则，没有擅自增加阈值。

### 15. 补贴后商家降价是否自动补差

不会。

商家改价只重新计算当前总收益，平台补贴金额保持不变。事件 metadata 记录 platformSubsidyAlreadyActive 和 merchantQuoteLowered，供后续资格策略使用。

没有任何目标总价或自动补差逻辑。

### 16. Migration、测试、typecheck、build

全部通过，详见后文。

## 角色价格视图

- 用户：商品金额、用户配送费、用户骑手激励、激励退款和用户退款。
- 商家：自己的订单级配送报价、版本和改价历史。
- 骑手：当前保证总收益、备餐信号、发布时间和接单截止时间。
- 管理员：完整 OrderPricing、报价历史、激励历史、补贴历史、Assignment 快照和任务信息。

骑手订单池不暴露资金来源拆分，只提供 payoutMinor 总收益。

## 管理员配置与审计

新增后端 API：

- GET /admin/business-configs/:key
- PUT /admin/business-configs/:key

更新会创建新的 BusinessConfig 版本、停用旧版本，并写 BusinessConfigAudit：操作者、前后版本、前后 payload、原因和时间。

订单发布时快照：

- orderClaimWindowSeconds → claimDeadline
- finalUserWarningSecondsBeforeClaimDeadline → finalUserWarningAt
- merchantRepriceCooldownSeconds
- riderSettlementPendingSeconds
- marketPolicyVersion

未实现完整管理前端和一键回滚接口。

## 新增与修改 API

- PATCH /merchant/orders/:orderId/delivery-quote
- POST /orders/:orderId/rider-tip-adjustments
- GET /orders/:orderId/pricing
- POST /admin/orders/:orderId/platform-subsidies
- GET /admin/business-configs/:key
- PUT /admin/business-configs/:key
- POST /merchant/orders/:orderId/confirm 现在直接发布骑手池
- POST /merchant/orders/:orderId/ready 现在只更新自报备餐信号
- 移除 POST /delivery-tasks/:taskId/abandon

OpenAPI 版本更新为 0.3.0。

## Migration

本轮新增并保留以下互不重复的 migration：

1. 20260923000100_market_pricing_claim_deadline
   - 报价历史、用户激励、补贴历史结构
   - DeliveryAssignment 接单价格快照
   - NO_RIDER_ACCEPTED
   - 管理员配置审计
2. 20260923000200_market_policy_snapshots
   - claim window 相关策略版本、报价冷却和最终提醒快照
3. 20260923000300_tip_cancellation_refund
   - 冷静期取消的用户激励退款事件类型
4. 20260923000400_settlement_policy_snapshot
   - 骑手待结算期快照

它们建立在已有两个 migration 之上，没有重复生成同一 schema 变化。

## 测试结果

- TypeScript typecheck：通过
- 单元测试：13/13 通过
- PostgreSQL 集成测试：20/20 通过
- Build：通过
- 服务启动与 /health：通过
- OpenAPI 0.3.0 必需路径：通过
- 当前数据库 migration status：6 个 migration，已全部应用
- 当前数据库 schema drift：无
- 空数据库从零 migration：6/6 通过
- 空数据库 Seed：连续执行两次通过
- 空数据库演示订单：8
- Seed 报价历史：6
- Seed 补贴历史：1

主要集成覆盖：

- 商家确认即发布和 ready 信号
- 报价历史、冷却、接单并发快照和接单后锁定
- 用户激励接单前增减、接单后只增和 100% 归骑手
- 固定 40 分钟窗口、NO_RIDER_ACCEPTED 和退款边界
- 增量补贴、间隔、步长、累计上限和预算比例
- 自然/补贴样本隔离
- 管理员配置版本和审计
- 角色价格视图
- 普通订单无照片完成与失联强制 Evidence
- 原有订单状态机、验证码、并发持单、结算和时间线

## 已知问题

- finalUserWarningAt 已形成快照，但尚无通知通道或前端提醒。
- 平台补贴目前由管理员/API 显式触发，没有实现复杂自动补贴调度。
- 管理员配置没有完整 UI 和一键回滚 API。
- 退款仅记录金额边界，没有真实支付退款。
- 商家默认报价仍来自 Merchant.deliveryContributionMinor；时段级或组合默认值仍未决定。
- 四位短码、MockMediaStorage、开发认证等既有阶段限制仍然存在。
- 风险商家提示和“通常较慢”阈值未实现，因为具体统计窗口和阈值未确认。
- DeliveryAssignmentStatus.ABANDONED 和 RIDER_ABANDONED 枚举为历史兼容保留，正常业务没有写入路径。

## 刻意未实现

- 单账号多角色
- 自动派单、导航和路线规划
- 用户、商家或骑手评分
- 自动判责、自动处罚和 AI 规则
- 复杂动态补贴算法
- 完整管理员前端
- 真实支付、退款和提现
- 接单后激励的异常自动退款
- 真实媒体存储和微信小程序现场拍照
- 微信登录、手机号登录和强制实名

## 产品负责人仍需决定

- 商家默认配送报价来源
- 补贴正式步长、间隔、单订单上限和预算比例
- 40 分钟窗口内更细的提醒与补贴顺序
- 接单后激励的异常退款边界
- 平台抽成规则
- 用户配送费规则
- 风险商家提示阈值和统计窗口
- 骑手额度升级、处罚与淘汰规则
- 用户失联、错误地址和争议判责规则
- 管理员配置回滚方式
- 真实支付、媒体和登录方案
