# CODEX_REPORT — 第四轮双侧配送定价与商家未来报价

日期：2026-10-11（Asia/Singapore）。只执行 CODEX_TASK.md 第四轮 A/B/C；实现及验证完成，阶段提交已普通推送 main，报告提交后停止。

## 1. 结果、启用状态与提交

已实现B参与双侧基础定价、两侧独立整数BPS、自有未来报价CAS与审计、用户旧报价重确认，以及创建/claim快照保护。商家救单、用户红包与平台补贴继续独立记账，追加部分100%增加骑手收益，不重算基础价差。

**默认仍为旧定额模式。** 应用当前库没有DELIVERY_PRICING_POLICY配置。新模式需旧SUPER_ADMIN明确启用并填写两侧比例；该身份临时代行一级运营配置权限，不是Root。没有替运营确定正式比例，没有将fixture的20%启用到应用库。POST创建仍为CREATED及开发内账报价合同，不等于真实付款。

| 范围 | SHA | 结果 |
| --- | --- | --- |
| 同步前本地 | 1c20b2c | 工作区干净，fetch后fast-forward 7个提交 |
| 本轮起点 | 3feccdad4961d3ad7d2190339fa51257a264fd15 | 最新任务与产品决策 |
| A | 43743f64436df03ca9638081e0cd9674fede8c85 | 显式双侧模式、配置、历史兼容；独立验证/commit/push |
| B | d8300090bdd6fd7cf12bad2d7d97008efa8075bb | 未来报价、增量迁移、审计、结账重确认、Seed保护；独立验证/commit/push |
| C／实现终点 | 2c80477f0ff537f0881014d490283c0b538f31a2 | 完整资金链、隔离、边界、快照及回归；独立验证/commit/push |

报告随后独立文档提交/push。本轮无reset、丢弃工作、历史migration修改或force-push；上轮报告已归档于CODEX_REPORT_2026-10-10_RIDER_ELIGIBILITY.md。

## 2. 开发前模型、旧数据风险与决策对照

旧pricing/policy真正使用ORDER_POLICY全局定额、merchant override和总数量；B仅为reservedInputs。直接在旧价格上叠比例会重复收费，因此采用独立DELIVERY_PRICING_POLICY，未配置时继续旧模式，新模式不叠旧定额/override/数量费。原delivery-quote已经是商家应结款抵扣的救单，继续保持该语义。

PRODUCT_DECISIONS.md第6节2026-10-10确认已取代旧计划、审计中基础资金语义待确认的限制，已在IMPLEMENTATION_PLAN.md与AUDIT_FOLLOWUP.md置顶明确对照，保留历史记录。没有借此扩展异常分责资金模型，也没有宣布整个旧实施计划完成。

A使用现有JSON快照，无新SQL；B只新增报价版本与独立审计。旧OrderPricing、历史配置、已FINALIZED结算和已得骑手收入不重算。旧20260926000400_capacity_pool_pricing开发期重解释未修改，不作为本次迁移或未来生产财务模板。

发现旧Seed会覆盖演示B、策略、价格、承接及待结算事实，已保护本轮相关数据：保留既有B/版本及ORDER_POLICY，既有演示订单及关联事实只在首次场景创建时写入。Seed仍维护其他演示资料，不是生产运维或真实支付入口。

## 3. 要求到运行时和验证清单

| 要求 | 执行点 | 验证 |
| --- | --- | --- |
| A1 禁止旧价格再叠收费 | pricing/policy.ts显式旧/新分支 | 单元及新旧订单测试证明新模式只用B与两率 |
| A2 独立BPS、整数/上限、审计 | pricing/config.ts校验，policy.ts BigInt，admin/config-service.ts CAS/事务锁/BusinessConfigAudit | 一侧变化不影响另一侧；非法BPS、0/微小/最大B、首次并发配置一成一败 |
| A3 显式启用、历史兼容与输入快照 | 缺省旧模式版本0；新策略版本存JSON，ORDER_POLICY版本仍独立 | 启用/回退不重算旧价格/Settlement；Seed不启用新配置 |
| B1 商家自有未来B | pricing/merchant-quote.ts，GET/PUT /merchant/base-delivery-quote | CAS/行锁/上限/理由及旧新值、操作者、时间审计；越权拒绝、跨店字段拒绝、并发编辑一成一败 |
| B2 原救单兼容与安全 | repriceOrder及原PATCH delivery-quote | 只增、冷却、合法商家应结款上限、版本/锁/历史；已claim明确409，原窗口/用户价不变 |
| B3 重确认及并发创建快照 | orders/quote.ts共用读锁/计算，createOrder核对expectedQuoteToken | B/策略/商品/数量变化要求重确认；改价在分类期间先完成则旧创建失败；订单先持锁则保留旧价，新单用新价 |
| C资金/快照/角色隔离 | rescue/tip/subsidy、claim来源复制、显式DTO | 精确资金链、预算占用、后claim红包、完整序列化负向检查、legacy FINALIZED和既得收入保留 |
| C原机制回归与交付 | 既有履约、资格、异常及资金路径 | 40分钟、短码、交接争议、核心易损mock证据、取消冷却、学生gate、个人屏蔽、退款冻结和补贴回归 |

## 4. 计算、配置与实际生效输入

新配置必须明确包含mode=REFERENCE_BPS、customerMarkupBps、riderDeductionBps、rounding=FLOOR_ADJUSTMENTS及maxMerchantBaseMinor。通过现有管理员PUT配置接口提交非空reason与expectedVersion（首次0）；OPERATOR不能写。回退payload为mode=LEGACY_ORDER_POLICY，也版本化/审计，仅对新单生效。

- userBase = B + floor(B×customerMarkupBps/10000)。
- riderBase = B − floor(B×riderDeductionBps/10000)。
- baseSpread = userBase − riderBase；不叠加旧模式定额、override或数量费。
- 两率各自0..10000，无费率默认、无暗加最低价/最低收益/最低价差。B=0→0/0；B=1、两率2000bps→1/1。
- BigInt精确计算，两侧增减额分别向下取整。FLOOR_ADJUSTMENTS是明确可测试的工程舍入版本；长期政策待定，其他舍入版本尚未实现，不能声称已有任意舍入算法切换。
- maxMerchantBaseMinor为管理员指定安全输入上限，最大1073741823分，保证100%上浮仍可存PostgreSQL Int。旧模式报价编辑使用100000分工程上限，不是商业推荐价；新模式限额可配置，旧fallback更改需代码更新。
- 写账前校验基础价、checkout总额、红包/保证收益、rescue及补贴预算的整数范围，溢出返回4xx且事务不产生价格/event/budget漂移。

新模式金额决策真正使用B、两率、舍入和配置限额。商家ID、类别、区域、AI建议foodType、总数量仅为data/telemetry，全部**reserved/not yet active**，不是多因素智能价格。旧模式仍使用商家override与数量，B及区域/分类仍reserved。

内部订单JSON记录B、两率、各增减额、基础价差、舍入、上限、配送策略版本、ORDER_POLICY版本、商家报价版本、输入与用户确认标识；claim原子复制JSON及全部资金来源。后续修改店铺B或比例不改本单基础价；后claim红包单独增加postClaimTip。

## 5. 预览、锁价、权限及支付事实

POST /orders/price-preview仅供CUSTOMER，返回用户自己的商品行/合计、基础配送费、总额和opaque quoteToken，不创建订单/支付，不暴露B、两率、骑手基础价或平台价差。

新模式POST /orders必须带expectedQuoteToken，遗漏409 QUOTE_CONFIRMATION_REQUIRED；当前事实与标识不符409 CHECKOUT_QUOTE_CHANGED，要求重新预览并由用户确认，不静默加价。旧模式保留不带token直接创建兼容；一旦提供token仍严格核对，包括新模式回退旧模式的旧标识。旧客户端路径不宣称已有预览确认。

标识覆盖B/报价版本、两种策略版本、商品版本/价格/名称/数量/履约类型、取餐及目的地快照、交付方式和实际用户金额，商品行稳定排序。它是乐观报价摘要，**不是付款凭证**；报价有效期、支付nonce及真正支付时并发细节未实现。

配置→Merchant→catalog→locations锁顺序统一。配置写入排他advisory锁、checkout共享锁；商家改B排他Merchant行锁，预览/创建共享行锁，持续至订单快照插入事务结束。

商家编辑返回“仅对后续订单生效，已付款订单不变”。merchantId/orderId等额外编辑字段在preValidation明确拒绝，避免Fastify默认去除字段后伪成功。本单无基础改价写接口，原救单在已claim时明确失败。未claim救单不改变原用户基础费或40分钟窗口。

创建仍是CREATED及开发内账合同；无PAID、真实付款回调、外部冻结或商家48小时真实提现。本轮沿用旧SUPER_ADMIN/OPERATOR及开发x-user-id认证，未实现正式Root/L1/L2、生产登录或完整控制台UI。

## 6. 资金来源及精确回归

| 概念 | 运行时使用 | 真实支付边界 |
| --- | --- | --- |
| B | 纯参考，参与基础计算，不扣商家商品款 | 不是资金来源 |
| 用户基础费 | 创建合同金额，后续B不回写 | 没有实际收款确认 |
| 骑手基础报酬 | 锁定报价；正常送达按原模型形成收入 | 报价不等于已赚得或真实到账 |
| merchant rescue | 从本单合法merchantSettlementMinor抵扣，超过可扣应结款拒绝，100%增骑手 | 有本单内账扣减；未验证外部商品款实收，不称为真实渠道付款 |
| customer tip | 独立金额/event，100%增骑手，后claim不可撤回 | 现有开发内账，没有实收证明或新增支付渠道 |
| platform subsidy | 实际增加subsidyUsedMinor占用受限内部预算，等额降贡献 | 内部预算消耗，不是银行/微信付款 |

guaranteed = riderBase + rescue + tip + subsidy；deliveryContribution = customerFee − riderBase − subsidy（未计支付成本）。商品佣金platformCommissionBps独立、Seed/default为0，非零计算hook不代表收费已批准。

隔离fixture证明：B250、双侧2000bps→user300/rider200/baseSpread100；商品2000、rescue100→merchant1900/rider300；tip100→rider400；subsidy50→rider450/contribution50，预算usedMinor实际增加50。claim冻结300/200/100/100/50/450/50及原JSON。以后改B/比例，本单不变；后claim tip100仅令保证收益550、postClaimTip100，贡献仍50。原firstPublishedAt/claimDeadline保持、40分钟不刷新。

这证明内账计算与约束，不证明真实收款或提现。既有异常退款/赔付只回归，未声称已符合尚未实现的完整分责结算规则。

## 7. 实际测试、迁移和基础设施

| 检查 | A | B | C最终 |
| --- | --- | --- | --- |
| pnpm db:generate | 通过 | 通过 | 通过 |
| pnpm typecheck | 类型修正后通过 | 通过 | 通过 |
| pnpm test | 16文件48/48 | 16文件48/48 | 16文件48/48 |
| pnpm test:integration | 6文件141/141 | 6文件146/146 | 6文件151/151 |
| pnpm build | 通过 | 通过 | 通过 |
| migration/status/drift | 无新增，原23条status/diff正常 | 当前库/旧库副本升级、空库24条全迁移通过 | deploy无pending，24条status正常，diff无漂移 |
| Seed | 隔离integration Seed通过 | 首次Seed、连续两次及六表指纹稳定，保留已配置B/策略测试通过 | 全量integration重新执行migration+Seed通过 |
| OpenAPI/权限 | 管理员配置权限回归 | 新报价/预览、旧救单保持 | 新路径和完整DTO负向测试通过 |

开发期间失败已修复：A可选pricingConfig的TS类型错误；初次drift因shadow库尚不存在，创建后通过；B额外跨店字段被Fastify删除后返回200，增加明确拒绝后通过；连续Seed发现历史承接和待结算updatedAt漂移，限制关联事实为新场景才创建后两次复验一致。最终无失败或被基础设施阻塞的检查。

Docker初检Desktop未运行、Linux engine管道缺失，只做一次docker desktop restart；CLI恢复29.8.0，既有PostgreSQL服务启动并healthy。没有factory reset、purge、volume删除或应用数据库reset。所有测试使用本轮隔离库，未让deleteMany清理应用库。

唯一新增migration：20261011000100_merchant_base_delivery_quote。仅添加Merchant.baseDeliveryQuoteVersion（旧库初始0）与MerchantBaseDeliveryQuoteAudit；没有伪造操作审计，没有UPDATE价格、结算或历史配置。

应用升级前容器备份保留于 `/tmp/campus_pricing_round4_before.dump`；副本升级和应用自身升级后，六表指纹全部保持：

| 表 | 记录数 | 升级前后MD5 |
| --- | ---: | --- |
| OrderPricing | 2 | 45c3e7d9486c317f3fddbf35ddbaf3da |
| Settlement | 2 | 085cf607e55cf18e9456727a29cedaea |
| DeliveryAssignment | 0 | d41d8cd98f00b204e9800998ecf8427e |
| RiderSettlement | 0 | d41d8cd98f00b204e9800998ecf8427e |
| BusinessConfig | 2 | e979a3f79b374855cc2a8e44de3b2e38 |
| BusinessConfigAudit | 1 | aba90bf63c9779d06e070b60d8adad52 |

当前库无历史claim/骑手收入样本，零记录指纹不证明全部财务场景；额外集成测试完成legacy订单至FINALIZED及生成骑手收入，证明后续B/模式变更不回写。空库Seed有8个价格/结算、5个承接、1个骑手待结算样本，两次Seed六表指纹均不变。当前应用库新配送策略配置0、报价修改审计0、旧商家报价版本0，没有虚构管理员启用或商家操作。

验证后已仅删除本轮创建的六个隔离库：campus_pricing_round4_test_20261011、shadow_20261011、upgrade_20261011、empty_20261011、seedfirst_20261011、seedcheck_20261011（后五名同campus_pricing_round4_前缀）。保留升级前dump及Seed首轮 `/tmp/campus_pricing_round4_seedfirst.dump`，临时指纹脚本未提交。

**独立CI未验证。** GitHub API核对A/B/C提交Actions run各0；C check-runs 0、combined status条目0（pending不是通过）。仓库无跟踪的GitHub Actions workflow。本报告绿色结果均为本地执行，不能称为独立CI通过。

## 8. 生效分类、未实现内容与待决事项

- **enforced behavior**：显式启用后B驱动双侧计算、独立比例、版本审计、自有报价CAS、预览重确认、创建/claim快照、合法救单抵扣、全额增量、原窗口、金额边界和角色隔离；默认旧模式，新模式尚未在应用库启用。
- **data/telemetry available**：类别/区域/数量、AI建议和来源、B/比例/输入/基础价差/版本、激励事件；新模式类别/区域/数量/AI均reserved、不影响金额。
- **policy hook / placeholder**：商品佣金计算保留但默认0；Jev为既有低风险hook，不决定钱/责任/资格；完整差异化矩阵、动态定价和其他舍入版本没有实现。
- **not implemented**：真实支付/退款网关、钱包、支付机构冻结、商家有效完成后连续48小时可提现与真实提现、正式Root/L1/L2、代买、生产认证、真实媒体、完整前端/控制台。易损照片回归仅证明现有mock reference验证，不能称真实相机/媒体已接入。
- 待确定：两侧正式比例、长期舍入、商业最低价/封顶、差异化规则、支付成本、真实支付时并发处理、quote有效期。未用fixture或工程限额代替商业决策。
- 没有顺带重构严重异常分责/商家提现/代买；既有退款资金模型其他未实现规则仍须独立任务，不能从回归通过推定后续全部产品规则已落地。

实现与验证完成，A/B/C已推送；本报告提交推送后停止，不启动下一轮。
