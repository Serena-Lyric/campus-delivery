# AUDIT_HANDOFF_2026-09-27

> 本文件记录对 `d0edaf1031ccdcc5f3835ae0dbff5e8b37a90de7`（`feat: add capacity and split delivery pricing`）及随后 `CODEX_REPORT.md` 的独立代码审核。
> **本轮审核未通过，因此不要删除 `CODEX_REPORT.md`，也不要把报告中的“全部完成”视为验收结论。**
> 本文件不创造产品规则；发现文档冲突时仍以 `PRODUCT_DECISIONS.md` 的已确认内容为最高依据，同时必须注意本文指出的“主产品文档尚未同步的新决策”。

## 0. 为什么多次中断后总是“只差测试/报告”不能直接相信

从 Git 历史看，任务起点 `04f167e...` 到实现提交 `d0edaf1...` 只有一个大型实现 commit：约 32 个文件、3 个 migration、大量新增代码一次性提交。更合理的解释是 Codex 在多次中断之间持续保留工作树修改，最后集中提交；Git 历史不能证明每次中断时真的已经“只差测试/报告”。

因此后续审核继续以运行时代码、migration、测试覆盖和文档一致性为准，不以 Codex 的阶段性口头描述为依据。

## 1. 已实际确认修复/实现的部分

以下不是只存在字段或报告描述，而是在 runtime 路径中确认存在：

- 单日未取餐无责取消达到配置上限后，第 3 次等额外免费取消会被拒绝；已持订单不会因此自动取消。
- 核心 ExceptionCase admin 操作已有显式状态 guard，RESOLVED/CLOSED 不再能被常规 release/transfer/takeover/escalate/resolve/refund 重新打开。
- admin refund 已真正使用 expectedVersion/status/idempotency 保护；rider voluntary compensation 限制在严重餐损/丢失类型。
- 骑手容量主路径存在：未完成首单=1，首单正常 DELIVERED 后同校园日=2，下一校园自然日=5；global cap 与个人 override 取较小值；claim 事务锁 Rider 防止并发绕过最后槽位。
- 当前全局第一版 Seed cap=10；降低个人/global cap 不破坏已有 held orders，只阻止新 claim。
- Rider order-pool 已有显式 DTO，能返回保证收益、取餐点/区域、目的地快照/区域、粗分类和数量，不直接泄露用户价格/平台价差等资金细节。
- 物品分类失败会回退 UNKNOWN，不阻塞下单，也不参与钱、责任、容量或处罚。
- 当前价格 runtime 已拆分 rider base / merchant rescue / tip / subsidy / guarantee / platform delivery contribution；merchant rescue 增量 100% 进入 rider guarantee。
- 当前真实 Jev 未接入，报告对此表述基本诚实。

这些实现仍可能有下面列出的边界/迁移问题，不等于整轮验收通过。

## 2. P0：未确认的 5% 商品佣金正在真实运行

### 事实

`createOrder()` 按 `platformCommissionBps` 计算商品佣金，并从 `merchantSettlementMinor` 中扣除；送达结算时又把该 commission 加入 `platformRevenueMinor`。

Seed `demoPolicy.platformCommissionBps = 500`，即 5%。Seed 场景中商品小计 1500 minor，`platformCommissionMinor=75`，`merchantSettlementMinor=1425`。

### 为什么是设计偏离

`PRODUCT_DECISIONS.md` 明确把“平台抽成规则”列为未决定。Seed 数值不能自动升级为商业规则，但当前 5% 不是纯展示字段，而会改变真实 runtime 结算。

### 下一轮要求

- 在平台商品佣金正式确认前，不得把非零 demo commission 当业务默认。
- 可以保留 commission 字段/能力供未来使用，但当前正常业务默认应保持中性（优先 0）或明确隔离为只用于专门测试的 fixture。
- README / report 必须明确区分“字段存在”与“收费规则已确认”。
- 不要顺手决定正式佣金比例。

## 3. P0：`release-compensation` 实际做成了平台最终兜底/债务核销

### 事实

`releaseCompensationReservations()` 当前在解除 rider settlement reservation 后：

- 把解除金额增加到 `PLATFORM_ADVANCE` allocation；
- `platformAdvancedMinor += releasedMinor`；
- 把 `outstandingMinor` 直接设为 0；
- 把 obligation 标记为 `RESOLVED`。

普通管理员只要是当前 handler，也可调用该 route。

### 为什么是设计偏离

产品只确认：用户退款不能等待骑手补足，平台可暂时垫付；**平台垫付后的长期追偿、未来收入抵扣、何时视为真正结清都尚未决定。**

“解除冻结”不应静默等价于“平台永久承担并把骑手未结事实清零”。当前实现实际上替产品决定了债务核销规则。

### 下一轮要求

- 把“释放某笔 rider reservation”和“平台最终承担/核销 rider obligation”拆成不同业务语义。
- 释放 reservation 后，若 rider liability 仍存在，应继续保留真实 outstanding/未结事实，除非存在明确已确认的结清来源或以后专门设计的 write-off 动作。
- 如果未来需要平台核销，应是显式高风险动作、权限和审计，不应藏在 `release-compensation` 中。
- 在普通管理员资金权限尚未最终细化前，不要让普通管理员通过“release”间接完成平台永久核销。

## 4. P0/P1：骑手 `voluntaryPaymentMinor` 目前可以“声明已付款”，但没有真实资金来源

### 事实

rider voluntary compensation API 接受 `voluntaryPaymentMinor`，service 直接把它从待覆盖退款金额中减去，并创建 `RIDER_VOLUNTARY_PAYMENT` allocation；但当前没有真实 wallet debit、支付网关或可提现余额划转确认。

### 风险

一个 rider 可以提交一个数值，使 obligation 看起来已被其主动支付，从而减少 `platformAdvancedMinor/outstandingMinor`，但系统没有证明这笔钱真的存在或已转移。

### 下一轮要求

在真实付款能力上线前，不能把“骑手输入金额”直接记作已到账 funding。可选安全方向由后续设计/实现决定，例如：

- 从真实可验证的未提现/可提现资金 bucket 原子划转；或
- 建立 `PENDING_VOLUNTARY_PAYMENT`，只有支付确认后计入 funded；或
- v1 暂不允许非零 voluntaryPaymentMinor，只允许平台记录 rider 选择赔付意愿，再走已存在的 reservation/platform advance。

不要由 Codex自行选择新的长期钱包规则。

## 5. P0/P1：ExceptionCase 状态机仍可被 remake participant path 绕过

### 事实

统一 `state-machine.ts` 覆盖 admin claim/release/transfer/takeover/escalate/resolve/refund 与 rider compensate，但：

- `proposeRemake()` 没有使用统一 guard，只阻止 RESOLVED/CLOSED；因此 **ESCALATED** case 仍可被 rider 发起 remake，状态改成 `WAITING_FOR_PARTICIPANT`。
- 如果已有 pending remake，管理员随后将 case 升级为 ESCALATED，用户稍后 `respondToRemake()` 仍可把 case 从 ESCALATED 改成 RESOLVED（接受）或 OPEN（拒绝）。

### 下一轮要求

- participant-originated transitions 也必须进入统一/等价状态机约束。
- ESCALATED 后普通 rider/customer 流程不得直接覆写状态；应由 super-admin 接管/明确恢复到允许 participant action 的状态后才能继续。
- 增加针对 `ESCALATED -> proposeRemake/respondToRemake` 的回归测试。

## 6. P1：ESCALATED takeover 不能直接重新分给另一位 Super Admin

当前 `takeoverExceptionCase()` 在 case=ESCALATED 时要求 `nextHandlerAdminId === actor.id`，因此只能由发起 takeover 的 super-admin 自己接手，不能直接交给另一位 super-admin。

产品规则是 Super Admin 可以接管、释放、重新分配卡住的案件，并未限制只能自领。若未来只有一个超管则暂时无影响，但代码不应把组织结构假设写死。

下一轮可改为：ESCALATED 只能交给具有 SUPER_ADMIN level 的 target；是否允许后续再转 operator 由状态/权限规则明确决定。

## 7. P1：最高优先级产品文档与新价格实现不同步

`PRODUCT_DECISIONS.md` 仍存在旧表述：商家主导“配送报价”、未接单前自由改报价、接单时冻结商家报价等；而当前 code/README/ROLE 已换成“base/reference + platform pricing + merchant rescue”的模型。

更重要的是，最新产品讨论又指出：**商家初始配送费真实资金语义尚未验证**。例如“蛋糕 50、配送费 5”可能实际是平台只给商家结算 45，而不是商家另行转账 5；该场景需要 W/商家实际经验验证，目前只是猜想。

### 当前文档处理

`DELIVERY_PRICING_DECISIONS.md` 已于本次审核改为明确 provisional：

- 不再宣称 `merchantBaseDeliveryPrice` 必然只是纯参考、绝不从商家结算扣；
- 也不宣称一定从商品款扣；
- 保留“最终价差”“救单追加 100% 给骑手”“红包 100% 给骑手”等已经确认的边界；
- 列出待 W 验证问题。

### 后续必须做

在 W 真实场景确认后，再统一更新 `PRODUCT_DECISIONS.md`、`ROLE_RESPONSIBILITIES.md`、README 和 runtime。未确认前不要继续扩大当前 base/reference 假设。

## 8. P1：migration 修改了历史已结算财务事实和历史配置版本

`20260926000400_capacity_pool_pricing` 为 demo/开发兼容直接：

- 把旧 merchant/order `merchantDeliveryContributionMinor` 重解释为 base/reference 并清零旧字段；
- 修改历史 `OrderPricing.merchantSettlementMinor`；
- 修改已经 FINALIZED 的 `Settlement.merchantPayableMinor`；
- 对所有 `ORDER_POLICY` BusinessConfig 行原地加/改 payload，包括 inactive 的历史版本。

当前项目尚未生产时这可以作为一次开发期 schema 语义重写，但**不能把这种方式当作以后生产财务迁移范式**。真实资金/已终结 settlement / 历史配置版本原则上应通过保留旧事实、版本化迁移、correction/event 等方式处理，不应静默重写历史。

下一轮文档/AGENTS 应明确这一约束；若尚无真实生产数据，不必为了 demo 数据再做复杂反迁移，但报告必须说清楚它是 pre-production semantic rewrite。

## 9. P1/P2：已有骑手没有 capacity history backfill

migration 新增 `Rider.firstNormalDeliveredAt`，但没有从既有 DELIVERED assignment/order 回填。因此升级前已经完成过配送的 rider 也会被 runtime 当成 TUTORIAL=1，直到再完成一单。

如果当前只有开发 Seed 数据，影响有限；若存在真实/需保留的 rider 历史，需从历史正常完成事实回填或显式人工迁移。

## 10. P1：真实 Jev 接入前还有两个基础设施缺口

### 10.1 Item classifier 在数据库事务内部 await

`createOrder()` 的 Prisma transaction 内逐商品 `await classifier.classify()`。当前 deterministic classifier 是本地调用所以问题不大；未来若直接替换成真实 Jev HTTP 请求，会把网络延迟/故障放进数据库事务，长期占用连接/锁。

真实 Jev 接入前应把远程分类移出关键 DB transaction，或采用预分类/缓存/异步 enrich/严格超时 fallback 等方案。

### 10.2 Exception classifier 没有 safe fallback wrapper

`openExceptionCase()` 直接 `await classifier.classify()`；当前 deterministic 不会失败，但未来真实 Jev 失败可能让“创建异常 case”本身失败。必须保证 AI 不可用时异常主链路仍能 deterministic/manual fallback。

## 11. P2：exception classifier 的 routeSuggestion 语义偏离管理员分工

当前 deterministic classifier 对 `SEVERE_FOOD_DAMAGE / FOOD_LOST / DELIVERY_DISPUTE` 一律建议 `SUPER_ADMIN_REVIEW`。

它目前只是保存的 suggestion，并没有真的自动路由，所以尚未造成权限错误；但与已确认原则冲突：**普通管理员负责大多数需要人工判断的日常异常，只有复杂度、证据冲突、资金风险、权限或规则例外超出能力时才升级超管。**

后续建议不要仅按异常类型默认“上超管”；route suggestion 应更偏 shared/operator pool，只有确定性高风险条件才建议 super-admin。

## 12. P2：订单池“全部使用快照”报告表述过头

当前 Rider DTO 中：

- pickup locationName/region 是 Order snapshot；
- destination label/region 是 Order snapshot；
- 但 pickup merchant `{id,name}` 仍来自当前 Merchant；
- destination.location `{id,name,type}` 仍来自当前 CampusLocation。

因此商家/地点改名后，响应可能同时出现历史 snapshot 与当前 live name。应明确哪一个是履约权威快照，不要在报告里笼统声称“基础资料后改不会漂移”。

## 13. P2：deterministic item classifier 质量问题（低风险，符合容错定位）

规则先匹配饮品关键词中的“奶”，再匹配蛋糕，因此“奶油蛋糕”会被判成 DRINK。该错误不会改变钱、责任、容量或订单状态，符合我们选择该场景作为 Jev 低风险试验田的理由。

后续可以通过调整关键词优先级/真实 Jev/人工修正评估改善，但不要把安全 fallback 测试误写成“分类准确率已验证”。

## 14. README 已决/未决状态错误

README 末尾仍把以下列为“尚未决定”：

- `错误地址责任规则` —— **已决定**：地址错误属于用户责任；骑手按原预留地址正确送达即完成原订单履约；额外转送双方自愿协商。
- 泛化的 `用户失联等待时间` —— 应收窄为：大多数固定地址/位置节点订单不要求联系或等待；仅必须本人交接、强制交付码等特殊模式的等待与最终处理仍未决定。

README 的 pricing 章节还把“reference price 不从商家结算扣”写得像正式业务规则；现在应视为当前实现假设，待 W 验证商家真实配送费结算方式。

## 15. 下一轮执行优先级建议

在继续扩产品功能前，优先按以下顺序：

1. 解决未确认 5% commission 正在运行的问题；
2. 修正 compensation release/write-off 语义；
3. 修正 voluntary payment 无真实资金支撑；
4. 补齐 remake participant transitions 的状态机保护；
5. 修正文档 truth source（尤其 PRODUCT_DECISIONS / ROLE / README 的配送资金语义）；
6. 对开发期 migration 的历史重写做明确 pre-production 限定；
7. 处理 rider capacity backfill（若有需保留历史数据）；
8. 在真实 Jev 接入前修 AI transaction/fallback 问题；
9. 再做定价算法、商家结算细化和下一阶段产品设计。

## 16. 验收状态

- `CODEX_REPORT.md`：**保留，尚未验收删除。**
- `d0edaf1...`：主功能大量真实存在，但存在上述高风险语义偏差，不能标记本轮完全通过。
- 下一对话应先读取本文件、`DELIVERY_PRICING_DECISIONS.md`、`PRODUCT_DECISIONS.md`、`EXCEPTION_HANDLING.md` 和 `CODEX_REPORT.md`，再决定修补任务。
