# IMPLEMENTATION_PLAN

> 当前实现阶段：修复 2026-09-27 独立审核已确认的问题。配送定价拆分中的商家初始配送金额资金语义已重新打开，当前 reference-only runtime 仅为 provisional 实现，不得视为最终产品规则。
> 最高原则仍以 `PRODUCT_DECISIONS.md` 为准；本轮同时读取 `AUDIT_FOLLOWUP.md`、`RIDER_CAPACITY_DECISIONS.md`、`ORDER_POOL_DECISIONS.md`、`DELIVERY_PRICING_DECISIONS.md`。这些主题文档记录了用户刚确认的当前实现边界；若与旧代码/Seed/旧测试冲突，不得静默保留旧行为。
> 本轮只做后端数据模型、策略、API、迁移、审计、测试与必要文档；不设计完整 UI，不接真实支付/提现，不做路线规划，不做成熟动态定价算法。

## 0. 先完成上一轮审核补丁

严格执行 `AUDIT_FOLLOWUP.md`：

1. 每日未取餐无责取消真正封顶；达到配置上限后，暂停前已持有的第 3 个订单也不能继续使用同一无责取消入口。
2. ExceptionCase 建立显式合法状态迁移；RESOLVED/CLOSED 终态不能被 release/transfer/takeover/escalate 重新打开。
3. ESCALATED 后 OPERATOR 不得继续普通 resolve/refund；SUPER_ADMIN 合法接管后才继续。
4. refund-and-close 必须真实使用 expectedVersion + status precondition + transaction + idempotency；不能仅依赖幂等 key。
5. rider voluntary compensation 不能覆盖已 RESOLVED/CLOSED / REMAKE_AND_CONTINUE case，只能在已确认严重餐损/丢失流程的合法状态执行。
6. 增加全部回归/陈旧页面/并发测试。

这一阶段完成前不要继续叠新业务。

---

## 1. 骑手并发持单额度

依据 `RIDER_CAPACITY_DECISIONS.md`。

### 1.1 第一版容量规则

- 平台全局绝对并发上限：Seed 第一版 10，必须进入版本化 BusinessConfig / Super Admin 控制面，不得长期硬编码。
- 每个骑手拥有个人并发额度；Super Admin 可针对具体骑手人工设置 override，并记录审计。
- 有效可持单上限：`min(personalCapacity, globalAbsoluteCapacity)`。
- 调低个人或全局额度时，不取消/回池现有订单，只阻止新的 claim，直到 active held count 低于有效额度。

### 1.2 新骑手教程爬坡

建立可解释、可审计的第一版阶段：

- 尚未正常完成首单：个人额度 1；骑手端可读为“新手教程阶段”。
- 首单正常 DELIVERED 后，同一校园自然日额度变为 2，并产生可读取的额度变化通知/事件。
- 首单正常完成后的下一校园自然日开始，默认额度变为 5，并产生额度变化通知/事件。
- 校园自然日使用配置时区，不按 UTC 生硬切换。
- 5 以后不自动升级；6～10 只通过 Super Admin 人工 override。
- 当前不设计自动降额度算法，也不把异常、赔付、评分自行接入额度。

建议保存 `firstNormalDeliveredAt` / capacity stage facts 或等价结构，避免靠临时计算造成不可解释状态。工程实现可按现有 schema 选择更合理方式，但必须能审计阶段与 override。

### 1.3 接单时原子校验

claim transaction 内必须校验当前 active held orders 与有效额度，避免并发两次 claim 同时越过上限。至少有并发测试证明两个请求竞争最后一个容量槽位时只能一个成功。

---

## 2. 骑手订单池最低决策信息

依据 `ORDER_POOL_DECISIONS.md`。不做 UI，只保证 rider-facing DTO/API 有足够事实。

每个可接订单至少提供：

1. 当前接单可锁定的 `riderGuaranteedPayout`；
2. 取餐商家 + 可执行取餐点/区域（能够表达东门/西门等 CampusLocation/区域事实，不要求地图）；
3. 目的地校园位置/地址快照（不能只假设宿舍，要能支持教学/办公等）；
4. 物品粗分类；
5. 简单数量/大致携带量（至少总件数；如果现有商品单位能安全表达杯/袋可保留，但不虚构精确重量/体积）。

要求：

- rider DTO 显式 select/DTO，不泄漏用户、商家或平台内部敏感资金字段。
- 平台不据此自动做路线规划、拼单推荐、跨一期/二期禁止接单。
- 商家名称、取餐点、目的地与关键价格使用订单快照，避免基础资料后改造成历史订单履约事实漂移；DTO 同时保留稳定 merchant/location id。

---

## 3. Jev / AI 物品粗分类试验场

这是低风险辅助分类，不是高风险策略。

### 3.1 数据语义

保留并区分：

- 原始商品名；
- 商家原始分类；
- AI/Jev 建议 `foodType`；
- 可选 `handlingTags`；
- source/model/version；
- confidence；
- 人工修正/最终展示值（如实现）。

第一版 foodType 可采用有限枚举，例如 DRINK / RICE_MEAL / NOODLE / SOUP / CAKE_DESSERT / OTHER / UNKNOWN；名称可调整，但不要做复杂物流 taxonomy。

### 3.2 安全边界

- 分类失败、超时、低置信度时回退商家分类或 UNKNOWN/OTHER。
- AI 不可阻塞下单、入池、接单或配送。
- AI 分类不得直接改变用户价格、骑手收益、容量、责任、处罚、异常处理或商家曝光。
- 不能覆盖原始商品/商家事实。
- 记录足够 telemetry，后续可统计分类结果、fallback、人工修正与误分类。

### 3.3 Jev 集成层级

- 建立 typed classifier adapter + deterministic/manual fallback。
- 如果仓库当前没有安全可用的 Jev endpoint/凭据配置，本轮不要硬编码密钥、不要让测试依赖公网；报告写 `adapter/hook ready, not active`。
- 如果已有安全配置，可接真实 adapter，但必须保证不可用时业务无损 fallback。

---

## 4. 配送价格模型语义拆分

严格依据 `DELIVERY_PRICING_DECISIONS.md`。这是本轮最大账务变更，先迁移语义再实现策略。

### 4.1 拆开参考价与真实出资

当前 `merchantDeliveryContributionMinor` 同时被当作商家报价/真实出资，必须拆分。至少具备等价字段/概念：

- merchant base/reference delivery price；
- customer base delivery fee；
- rider base payout；
- merchant rescue contribution（真实商家追加资金）；
- customer rider tip；
- platform subsidy；
- rider guaranteed payout；
- platform delivery contribution/spread。

当前 runtime 暂不把 merchant base/reference price 从 merchant settlement 中等额扣除，以避免在资金语义未确认时扩大旧假设；这不是最终产品结论。真实结算方式待 W/运营验证后再设计和迁移。

### 4.2 第一版资金公式

不计尚未建模的支付通道成本时：

`riderGuaranteedPayout = riderBasePayout + merchantRescueContribution + customerRiderTip + platformSubsidy`

`deliveryPlatformContribution = customerDeliveryFee - riderBasePayout - platformSubsidy`

该公式是当前 provisional runtime 口径；如果商家初始配送金额后续被确认为真实资金来源，必须重新核对平台贡献公式。

- 商家 rescue 增量 100% 传给骑手；同时从商家真实结算/资金来源中记账。
- 用户 tip 100% 传给骑手。
- platform subsidy 100% 增加 rider payout，同时减少平台贡献/预算。
- baseline 定价不得通过隐藏公式主动产生负基础价差；若平台需要让利到负贡献，使用已有受预算约束的 platform subsidy。

### 4.3 初始定价策略

不要实现“智能最优价格”。建立一个明确的 `DeliveryPricingPolicy` / equivalent，可根据配置产生：

- `customerDeliveryFee`；
- `riderBasePayout`；
- reason/policy version/inputs snapshot。

允许输入：merchant base price、merchant/category、pickup region、destination region、foodType、quantity facts。

第一版规则必须：

- 全部参数可配置/可替换；
- 支持 Super Admin 对商家相关参数人工调整；
- Seed 仅提供演示数据，不声称是正式价格；
- 不强制固定抽成百分比或固定每单利润；
- 保留规则命中与计算输入，便于以后用真实数据替换策略。

如果当前 schema/业务还无法安全支持完整矩阵，可先实现层级化规则（global default → merchant override → category/region/item-type adjustment）并清楚报告未实现的组合维度；不要伪装完整算法。

### 4.4 商家救单加价

把现有 merchant reprice 流程迁移为“merchant rescue contribution”或语义等价行为：

- 只在未 claim 时增加真实商家出资；
- 第一版只允许增加/或按照已确认规则安全调整未锁定部分；不能使已承诺给 rider 的金额下降；
- rescue 增量 100% 增加 rider guaranteed payout；
- 保留原 claim deadline，不因加价刷新；
- 保留冷却、version、并发锁和完整历史；
- 接单瞬间原子快照全部资金来源与 rider guaranteed payout。

若旧 API 名称必须为兼容保留，可内部迁移语义并在 OpenAPI 标明；不要让旧字段名继续造成账务混淆。

### 4.5 Migration / compatibility

- 正式 Prisma migration，不修改历史 migration。
- 当前数据库升级与空库重建都必须成功。
- 明确旧 `merchantDeliveryContributionMinor` 数据如何迁移；当前 demo/seed 可按 provisional reference/rescue 语义重建，但不能把这种开发期重解释当成已确认的真实资金历史或未来生产迁移范式。
- 所有钱继续使用 integer minor units。
- 接单/订单创建时价格策略版本与关键输入要可追溯。

---

## 5. 管理员与角色边界

Super Admin：

- 可修改全局 rider capacity、单 rider capacity override；
- 可修改 delivery pricing policy/config、merchant pricing override；
- 所有修改审计 actor/reason/before/after/effective time/version。

Operator：

- 不获得全局/商家定价策略写权限；
- 不获得骑手容量跨订单 override 权限；
- 仍按当前异常处理权限工作。

Rider：

- 只能看到接单决策所需的 guaranteed payout 和业务事实；不要求拆分平台价差、merchant rescue、platform subsidy。
- 可查看自己的当前有效容量、阶段、override/限制摘要和容量升级通知。

Merchant：

- 可看到自己的当前 provisional base/reference 和 rescue contribution/history；初始金额真实结算语义仍待确认；
- 不默认看到用户 tip/platform subsidy；
- rescue 真实资金必须明确，不得与 reference price 混淆。

Customer：

- 看到自己承担的 customerDeliveryFee 和自己的 rider tip；
- 不暴露 rider base payout、platform spread、merchant rescue 等后台资金。

---

## 6. 明确不做

- 不做路线规划、地图导航、自动拼单。
- 不做成熟动态定价/机器学习定价。
- 不让 Jev/AI 决定钱、责任、处罚、容量或接单资格。
- 不决定平台商品佣金最终比例、支付通道费、税费。
- 不做 5 单之后自动升额度或异常自动降额度。
- 不做真实支付、提现、退款网关。
- 不修改普通业务账号单角色模型。
- 不做完整前端 UI。

---

## 7. 必测场景

至少覆盖：

1. `AUDIT_FOLLOWUP.md` 全部回归；
2. 新 rider 未完成首单只能持 1 单；并发抢第 2 单失败；
3. 首单正常 DELIVERED 后同日变 2，产生通知/事件；
4. 下一校园自然日变 5；
5. Super Admin rider override 与 global cap 取 min；审计完整；
6. 降低上限不破坏已持订单，只阻止新 claim；
7. 两个并发 claim 竞争最后一个容量槽只成功一个；
8. rider order-pool DTO 含 guaranteed payout / pickup / destination / foodType / quantity，但不泄漏平台/用户敏感字段；
9. classifier failure/UNKNOWN 不阻塞订单；原始商品信息保留；
10. Jev/AI 输出不能改变钱/容量/责任；
11. 当前 provisional runtime 不把 base/reference 从商家结算中扣除，且测试不得把该实现提升为最终产品规则；
12. 初始 customer fee 与 rider base payout 可不同，并正确形成 spread；
13. merchant rescue +X 后 rider guaranteed payout 精确 +X，平台 spread 不因该增量扩大；
14. tip +X 后 rider payout +X，平台 spread 不扩大；
15. subsidy +X 后 rider payout +X、platform contribution -X；
16. claim 时所有价格来源原子快照，之后不能向下撤销已承诺收益；
17. rescue reprice 不刷新 firstPublishedAt/claimDeadline；
18. customer / merchant / rider DTO 资金隔离负向测试；
19. pricing config 与 rider capacity config 只有 SUPER_ADMIN 可写。

---

## 8. 验证与报告

完成后严格按 `AGENTS.md`：

- typecheck；
- unit tests；
- PostgreSQL integration tests；
- build；
- current DB migration/status/drift；
- current DB migrate；
- empty DB full migrate；
- Seed 连续至少两次；
- OpenAPI 路径与角色权限检查；
- Docker 失败最多一次安全 restart，禁止 destructive reset/clean/purge/delete volumes。

生成新的根目录 `CODEX_REPORT.md`，逐项说明：

- audit follow-up 3 类缺口的 runtime 修复点与测试；
- rider capacity 的真实阶段计算、并发保护、override 与通知；
- order-pool rider DTO；
- item classifier/Jev 是 active 还是 hook only；
- 旧 pricing 语义如何迁移；
- 每个资金字段真实资金来源；
- merchant rescue 100% pass-through 的 runtime 证明；
- platform contribution 的真实计算口径；
- 哪些 pricing inputs 已实际生效、哪些仍 reserved；
- migration/Seed/权限/测试结果；
- intentional omissions / unresolved product decisions。

完成并 push `main` 后停止，不自行开始下一阶段。
