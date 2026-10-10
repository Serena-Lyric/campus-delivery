# 第四轮配送定价实现设计（2026-10-11）

依据 PRODUCT_DECISIONS.md 第6节 2026-10-10 确认及 CODEX_TASK.md 的 A/B/C 授权执行。
IMPLEMENTATION_PLAN.md 与 AUDIT_FOLLOWUP.md 中基础报价资金语义待确认的旧限制，由上述更高优先级决策取代；不修改历史迁移，也不扩展严重异常赔付模型。

## A：显式启用、独立策略

沿用 ORDER_POLICY 历史定额模式。新增 DELIVERY_PRICING_POLICY 版本化配置，缺省模式为 LEGACY_ORDER_POLICY；管理员通过现有配置接口、expectedVersion（未配置为0）和非空理由显式启用 REFERENCE_BPS。
此模式只按 B 计算基础价格，不叠加旧定额、商家 override 或数量费。customer=B+floor(B×markupBps/10000)，rider=B-floor(B×deductionBps/10000)。两侧0..10000bps，整数算术，无最低收益或最低价差。比例必填，无20%默认。FLOOR_ADJUSTMENTS 为可替换的版本化工程舍入；长期政策仍待确认。
maxMerchantBaseMinor 为管理员指定安全输入上限，最多1073741823分，保证100%上浮仍能存入 PostgreSQL Int；这不是推荐商业报价。订单 JSON 存 B、两率、舍入、各增减额、基础价差、策略版本和输入，不回写历史订单。旧 ORDER_POLICY 版本仍单独保留。配置写入与订单读用共享/排他事务 advisory lock 串行化。

## B：店铺未来报价、结账重确认

新增 merchant 自有报价 GET/PUT，不接受他店ID，expectedVersion/CAS、报价上限、非空理由和独立审计。商家报价读写与订单快照共享/排他 Merchant 行锁；配置锁总是先于 Merchant 锁。
预览接口只返回用户承担价格和不透明报价标识，提交时重读事实并比较。新模式必须携带预览确认；旧模式保留直接下单兼容，但提供标识时仍校验。标识覆盖商家版本、双策略版本、商品版本/价格/数量、目的地和交付方式；任一变化拒绝并要求重新预览确认，不静默加价。
订单创建仅锁定开发内账报价，状态仍 CREATED，不制造支付成功。旧 delivery-quote 接口继续作为真实救单增加通道，不能编辑本单基础价。成功提醒：仅对后续订单生效，已付款订单不变。

## C：回归与交付

验证资金增量不二次抽成，历史/claim 快照不漂移，完整角色DTO无敏感字段泄漏，报价编辑/下单/配置并发，原40分钟窗口、短码和交接争议、易损证据、取消冷却、学生资格、屏蔽、冻结退款与补贴回归。
每阶段独立 generate/typecheck/unit/PostgreSQL integration/build、提交和push。数据库升级/空库迁移及Seed使用隔离库；应用数据库升级前保留备份与账务指纹。真实支付、商家48小时提现、Root/L1/L2、代买、钱包不开发。

## A 阶段核对

- A1 旧定额不叠加：pricing/policy.ts 显式分支；单元测试与 PostgreSQL 新旧订单测试覆盖。
- A2 独立BPS/边界/审计：pricing/config.ts 校验、policy.ts BigInt计算、admin/config-service.ts expectedVersion及事务锁；单元边界及并发首次配置测试覆盖。无正式费率默认。
- A3 历史兼容：配置缺省旧模式；新数据使用现有JSON快照，不需要数据库迁移；测试证明切换/回滚不改既有OrderPricing/Settlement。
- db:generate、typecheck、build通过；unit 48/48；PostgreSQL integration 141/141；当前库23条迁移已应用，migration→当前库diff无漂移。第一次diff因未创建隔离shadow库失败，创建后重跑通过。
- A交付时B/C尚未开发；新模式阶段A尚未提供用户预览确认，阶段B补齐。

## B 阶段核对

- B1 自有报价：pricing/merchant-quote.ts 与 GET/PUT /merchant/base-delivery-quote；Merchant版本从0开始，CAS、行锁、限额、理由与独立审计。并发改价只一成功，跨店字段明确拒绝。
- B2 旧救单路径：原delivery-quote仍由repriceOrder执行增量出资；已claim明确409。本单基础价没有写接口。
- B3 重确认/创建快照：orders/quote.ts 共用价格计算和事务读锁；新模式必需expectedQuoteToken，旧模式选填但提供就严格核对。测试覆盖报价、策略、商品、数量变化，分类期间改价优先/订单快照优先两个交错顺序，旧订单及claim/settlement不漂移；订单仍CREATED。
- 新增20261011000100_merchant_base_delivery_quote，仅加版本列和审计表，无账务/历史配置UPDATE。旧库副本和应用当前库升级后六类账务/配置表指纹一致；空库24条全迁移通过，current status与drift通过。
- Seed首次检测到历史承接/待结算updatedAt漂移后修复为新场景才创建关联记录；连续两次Seed后OrderPricing/Settlement/DeliveryAssignment/RiderSettlement/BusinessConfig/BusinessConfigAudit指纹均不变。Seed不改已有商家B/版本，不启用或覆盖新模式，不回滚既有ORDER_POLICY。
- B最终db:generate/typecheck/build通过；unit 48/48；全量PostgreSQL integration 146/146（Seed修复后重新执行）。针对跨店额外字段的初次负向测试失败后，增加preValidation明确拒绝，复验通过。
