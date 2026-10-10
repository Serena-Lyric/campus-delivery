# AUDIT_FOLLOWUP

> 2026-10-11 对照：第1、2、6节关于初始报价资金语义和继续定价改造的旧阻塞，已由 PRODUCT_DECISIONS.md 第6节 2026-10-10 确认明确取代：B 不出资、双侧比例独立、救单独立、创建报价快照不等于付款。其余历史审计内容保留；尤其不把旧财务迁移作为生产模板，也不在本轮扩展异常分责资金模型。

> 本文件记录代码审核后确认的待修正项与仍需业务验证的冲突。它不创造新的产品规则；修复时仍以 `PRODUCT_DECISIONS.md` 和用户后续明确确认的最新决策为准。
> 2026-09-27 审核对象：实现提交 `d0edaf1031ccdcc5f3835ae0dbff5e8b37a90de7`，报告提交 `ae406cf62831edeb7f776324a0dec2e25181d9f8`。
> **历史审计阅读范围（2026-10-11维护）**：正文“当前代码 / 本轮 / CODEX_REPORT.md”均指上述审核时点；原报告保留在Git提交ae406cf中，不指根目录现已更新的第五轮报告。第10、11节中依赖旧基础报价未决语义的文档修订/开发门槛，与第1、2、6节同样受主产品第6节新确认约束，不能重新打开B是否出资。商品佣金已确认可配置、默认0%；首期分开支付暂定且未实现，统一商品款收取及48小时冷却为未来目标。
> 本次只加时点与替代说明，保留所有审计发现；**不宣布整份审计缺口已修复**。受影响任务仍须核对当前运行时和测试。报价验证见 [第四轮报告](CODEX_REPORT_2026-10-11_DUAL_SIDE_PRICING.md)，财务边界见 [第五轮报告](CODEX_REPORT.md)，这些本地记录不构成独立CI复核。

## 0. 本轮审核结论

上一轮 3 个安全补丁已经从运行时代码和测试源码层面得到支持：

- 单日未取餐无责取消额度现在会真正封顶；达到配置上限后，暂停前已经持有的其他订单也不能继续使用同一无责取消入口。
- `ExceptionCase` 已加入显式状态迁移 guard，`RESOLVED/CLOSED` 不再能经 release/transfer/takeover/escalate 回到工作状态；`ESCALATED` 也不再允许普通管理员直接继续退款/解决。
- refund-and-close 已实际使用 `expectedVersion`、合法状态与幂等保护；严重餐损/丢失的 rider voluntary compensation 也受状态/version 限制。

骑手容量 `1 → 2 → 5`、全局上限 10、单 rider SUPER_ADMIN override、claim 并发锁，以及订单池最低决策 DTO 的主体方向也与已确认设计一致。

但是本轮**不能判定为完全通过**。以下问题仍需修正或产品确认。在这些问题收口前，不应删除 `CODEX_REPORT.md`，也不应把本轮配送定价/赔付资金模型视为最终产品规则。

另：当前 GitHub commit `d0edaf1` 没有可见 GitHub Actions workflow run / combined status。`CODEX_REPORT.md` 中 typecheck、unit、PostgreSQL integration、build、migration、Seed 等结果属于 Codex 本地执行自报，不是本次审核者通过独立 CI 再验证的结果。不能把“报告写通过”与“独立验证通过”混为一谈。

## 1. P0：初始商家配送费的资金语义重新打开，等待 W 实际经验验证

当前代码和 `DELIVERY_PRICING_DECISIONS.md` 把 `merchantBaseDeliveryPriceMinor` 固定解释成**纯参考价，不是商家真实出资**；订单创建时也不会因此减少 merchant settlement。

但 2026-09-27 用户补充了一个重要现实假设，需要向 W 验证：

> 商家编辑商品/订单，例如蛋糕商品 50 元、配送费 5 元；平台可能直接从商品结算中扣除这 5 元，只向商家结算 45 元，而不是要求商家之后另行转账或支付 5 元。

该描述目前只是待验证假设，**不得直接升级为产品决策**。在 W/真实运营流程确认前：

- 不得再声称“商家初始配送价一定只是 reference、不是真实出资”；
- 也不得反向声称“商家初始配送费一定从商品结算扣除”；
- 当前 runtime 的 reference-only 语义只能视为**临时实现选择**；
- 后续设计必须明确：初始 merchant delivery amount 的资金来源、商品结算扣减方式、用户是否另付配送费、骑手基础收益与平台最终价差如何共同结算。

已确认且不因本问题改变的只有：

- 平台真正关注最终价差/单笔贡献，而不是固定 `+1/-1`；
- customer delivery fee、rider base payout 可以不同；
- 商家为了救单而**新增**的追加资金，第一版 100% 传给骑手；
- 用户红包 100% 给骑手；
- 平台补贴会消耗平台贡献/风险预算；
- 具体长期定价算法仍待真实数据。

在上述初始资金语义验证前，**暂停继续重构基础 pricing ledger 和历史 migration**。

## 2. P0：最高优先级产品文档与当前 pricing 实现存在冲突

`PRODUCT_DECISIONS.md` 旧章节仍写着：

- 配送收益主要决策权尽量交给商家；
- 商家在接单前可以修改自己愿意承担的配送报价；
- 骑手接单时锁定商家报价。

而本轮 runtime 已改为：

- 初始 `merchantBaseDeliveryPriceMinor` 只记录，不参与当前 customer fee / rider base 计算；
- 初始 customer fee / rider base 主要来自全局配置、SUPER_ADMIN merchant override 和 quantity；
- 原 `/delivery-quote` 被迁移为 `merchantRescueContribution`，只允许增加，不能下降。

这不是单纯命名差异，而是**定价权与资金语义变化**。问题来源是上一轮把专题文档中的新想法直接交给 Codex 实现，却没有先把冲突完整并回最高优先级 `PRODUCT_DECISIONS.md`。

后续规则：

- 专题设计文档不能覆盖 `PRODUCT_DECISIONS.md`；
- 若专题讨论改变旧产品决策，必须先明确“旧规则被哪条新规则取代/重新打开”，再允许实现；
- 当前 pricing 相关冲突在 W 验证前保持 unresolved，不让 Codex自行选择一边。

## 3. P0：`voluntaryPaymentMinor` 当前只是账面数字，没有真实资金来源

`refundAndCloseExceptionCase()` 当前允许 rider 提交 `voluntaryPaymentMinor`，随后：

- 直接从 remaining compensation 中扣除；
- 创建 `RIDER_VOLUNTARY_PAYMENT` allocation；
- 但没有从任何 rider withdrawable balance / RiderSettlement 中 reserve、扣减或形成已确认外部付款凭据。

结果是：系统可以记录“骑手主动支付 100”，并据此少冻结/少垫付 100，但没有任何对应资金真正被占用或确认收到。

这与已确认的“骑手可主动从可提现余额支付/划转，资金来源必须可审计”不完整一致。

修复前必须先明确实现语义：

- 如果代表平台内可提现余额支付，应真实关联并扣减/冻结对应可提现资金；
- 如果未来允许线下/外部付款，则必须由可信支付/人工确认事实支撑，不能仅由 rider 自报金额就视为已到账；
- 在真实钱包/支付能力不存在时，可暂时只记录“rider proposes voluntary payment”，但不能计入已 funded 金额。

## 4. P1：严重异常退款会给未正常送达订单制造完整 rider income，再立即拿去冻结

正常流程中 `RiderSettlement` 在 DELIVERED 后创建；但 refund-and-close 若发现本异常订单尚无 RiderSettlement，会新建一笔：

- amount = claim 时保证收益 + post-claim tip；
- status = HELD；
- 随后把它当作 `CURRENT_ORDER_SETTLEMENT` 赔付来源之一。

这隐含了一个尚未明确的产品规则：**严重餐损/丢失导致未正常送达时，骑手是否仍然先完整赚得本单保证配送收入？**

当前产品只确认“如果本单骑手收入仍处于未结算/未提现状态，可以用于赔付”，没有确认所有失败严重异常都自动产生完整配送收入。

因此后续必须决定：

- 什么情况下本单 rider payout 视为已 earned；
- 严重失败时是 0、部分、完整还是由管理员判断；
- tip 是否仍按独立规则保留，不等于 base payout 必然完整赚得。

在该决策前，不能把当前自动创建 full settlement 当作最终业务规则。

## 5. P1：历史 migration 把旧 merchant contribution 全部重解释成 reference，并回补 merchant settlement

`20260926000400_capacity_pool_pricing` 将旧 `merchantDeliveryContributionMinor`：

- 复制到 `merchantBaseDeliveryPriceMinor`；
- 把旧 real contribution 置 0；
- 把对应金额加回 `merchantSettlementMinor`；
- 对已 FINALIZED settlement 也加回 merchant payable。

旧 runtime 原本明确把该字段当真实 merchant contribution 使用。因此这个 migration 实际上是在**追溯重解释历史资金语义**。

如果仓库目前只有 demo/seed 数据，现实影响有限；但在任何真实资金数据进入前必须重新审视 migration 策略。尤其在第 1 节的“商家初始配送费是否真实从商品结算扣除”尚未验证前，不得把这条历史重解释视为最终正确迁移。

## 6. P1：merchant pre-claim 调价能力被收窄为“rescue 只能增加”

旧产品决策允许商家在骑手接单前修改自己的配送报价，且此前还专门讨论过“商家降低报价后平台不能自动补回”的边界。

本轮 `/merchant/orders/:orderId/delivery-quote` 被迁移成 rescue contribution 后，只允许 `newMinor > current`，不能降低。

用户最近确认的是“**商家救单新增部分第一版 100% 给骑手**”，并没有明确确认“从此商家所有 pre-claim 配送资金都只能增加、不能降低”。

因此需要在新的商家资金模型确认后重新决定：

- 初始配送金额是否允许商家在 claim 前上下调整；
- rescue contribution 是否应作为只增的独立通道；
- 两者是否并存。

在此之前，不把当前“只增 rescue”视为完整替代旧产品规则。

## 7. P2：订单池 DTO 的“快照”报告表述过度

订单池返回了 `destinationLabelSnapshot` / `destinationRegionSnapshot` 与 pickup location snapshot，这是正确方向；但 DTO 同时还返回 live `destinationLocation { id, name, type }` 与 live merchant name。

因此 `CODEX_REPORT.md` 中“取餐/目的地使用 Order 快照，基础资料后改不会漂移历史订单”表述过强。当前只能说**关键 label/region 有快照**，并非所有可见地点信息都不可漂移。

后续可二选一：

- DTO 只展示已经快照的字段；或
- 补齐必要的 location/type/merchant display snapshot。

无需因为这个问题阻塞当前产品讨论。

## 8. P2：deterministic item classifier 适合作 fallback，但当前 telemetry 不能当成可靠模型准确率

当前关键词顺序先判断饮品，且饮品关键词包含单字符 `奶`。因此类似“奶油蛋糕”会在蛋糕规则之前命中 DRINK。所有关键词命中又统一给出 `confidenceBps=8000`，该数值没有校准依据。

这不构成高风险业务错误，因为分类不会影响钱、责任、额度、接单资格或曝光；但如果目的是借该场景大量评测 Jev/分类效果，则：

- deterministic fallback 的结果必须与真实 Jev 结果分开统计；
- fallback confidence 不应被解释成概率准确率；
- 可以后续调整规则顺序/词表，但不要为了 fallback 过度工程化。

## 9. P2：遗留字段仍可能造成未来语义混淆

Schema 仍保留：

- `Merchant.deliveryContributionMinor`；
- `OrderPricing.merchantDeliveryContributionMinor`；
- legacy quote/version/history 字段；
- `Rider.currentConcurrentOrderLimit`。

报告称其中部分为 legacy compatibility，但新 runtime 已改用新的 pricing/capacity 字段。后续如果确认不再需要，应通过清晰 migration/兼容期逐步淘汰，避免后来的实现者误用旧字段；当前不要为“清理漂亮”贸然删除历史字段。

## 10. 文档漂移

当前 README 末尾仍把以下内容写成“尚未决定”：

- `错误地址责任规则` —— 已过期。现在已确认：地址错误属于用户侧责任；骑手按原预留地址正确送达即完成原订单履约；额外转送双方自行协商。
- `用户失联等待时间` —— 表述过宽。普通固定地址/校园位置节点配送不要求用户保持在线或等待；真正未决的是必须本人交接/强制交付码等特殊模式下的失联处理。

README 的 pricing 描述也把“merchant base/reference 一定不是商家真实出资”写成既定事实；鉴于第 1 节已经重新打开该问题，应改成“当前 runtime 的临时实现语义，真实商家结算方式待 W 验证”。

`ROLE_RESPONSIBILITIES.md` 商家章节也存在同样的 reference-only 绝对表述，需要在文档同步时降级为未决。

## 11. 下一轮实现门槛

在再次让 Codex 修改 pricing/merchant settlement 之前，至少完成：

1. 向 W 验证真实商家配送费的结算方式；重点确认“商品 50 + 商家设配送费 5”时，平台/现有业务实际如何向商家、用户、骑手结算。
2. 据此明确 initial merchant delivery amount 是 reference、真实商家出资、还是两者并存的两个概念。
3. 决定严重异常未正常送达时 rider base payout 是否 earned。
4. 明确 rider voluntary payment 的真实资金来源语义。

上述问题未确认前，允许继续讨论产品，但**不要让 Codex继续重构这些账务路径**。
