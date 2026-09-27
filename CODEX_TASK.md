# CODEX_TASK

## 当前任务：修复 2026-09-27 独立审核发现的可确定问题

上一轮实现提交：`d0edaf1031ccdcc5f3835ae0dbff5e8b37a90de7`。
上一轮报告提交：`ae406cf62831edeb7f776324a0dec2e25181d9f8`。
独立审核：`AUDIT_HANDOFF_2026-09-27.md`。

本轮不是继续扩展新业务，而是修复已经能依据现有产品规则确定的实现/文档偏差。开始前必须完整阅读并遵守：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `AUDIT_HANDOFF_2026-09-27.md`
4. `AUDIT_FOLLOWUP.md`
5. `DELIVERY_PRICING_DECISIONS.md`
6. `RIDER_CAPACITY_DECISIONS.md`
7. `ORDER_POOL_DECISIONS.md`
8. `ROLE_RESPONSIBILITIES.md`
9. `EXCEPTION_HANDLING.md`
10. `OPERATIONS_CONTEXT.md`
11. 当前 `CODEX_REPORT.md`

如文档之间存在冲突，不要自行选一个方便实现的版本：先以 `PRODUCT_DECISIONS.md` 的明确已确认规则为最高依据，并结合 `AUDIT_HANDOFF_2026-09-27.md` 中指出的“文档自身已落后/该事项其实仍未决定”进行最小修正。Seed、旧代码和上一轮报告都不是产品真相来源。

---

## 0. 本轮明确禁止决定的事项

以下依赖 W/真实运营经验或尚未完成产品讨论，本轮 **不得实现成新的长期规则**：

- 商家初始配送金额究竟是纯 pricing reference，还是商家真实承担的配送成本；
- 若商家真实承担初始配送费，是从商品结算中扣、另行支付、用户分担还是混合模式；
- “蛋糕 50 元、配送费 5 元 → 商家结算 45 元”目前只是待验证假设，不得据此改账务；
- 商家初始配送价在 pre-claim 阶段是否可降低/如何调整；
- 正式平台商品佣金比例；
- 支付通道费、税费等最终收入成本口径；
- 平台垫付后的长期追偿、未来收入自动抵扣、何时真正 write-off；
- 长期钱包/外部支付方案；
- 5 单之后自动升级与异常自动降容量规则；
- 正式动态定价算法。

本轮对 pricing 的要求仅是：**不要继续执行未确认规则，不要扩大当前 provisional 假设。**

---

## 1. P0：停止未确认的 5% 商品佣金作为默认业务规则

### 当前问题

`demoPolicy.platformCommissionBps = 500`，而 `createOrder()` / settlement runtime 会真实计算并从 merchant payable 扣除，再计入 platform revenue。产品层的“平台商品佣金/抽成”仍未决定。

### 必须修复

- 保留 commission 字段/能力可以，但当前默认业务配置必须中性：`platformCommissionBps = 0`。
- 不得把任何新的非零比例替代 5%。
- 若测试需要验证未来 commission plumbing，可在**专门测试 fixture/局部显式配置**中设置非零值，且测试名/注释必须说明只是技术能力测试，不是产品默认。
- 更新 Seed、相关 expected values、README/report，使“字段/能力存在”和“收费规则已确认”明确区分。
- 增加/调整测试证明：默认创建/完成订单不会因为未确认的商品佣金减少 merchant payable，也不会凭空产生商品 commission revenue。

### 禁止

- 不要借此决定未来抽成比例。
- 不要把配送价差、merchant rescue、用户 tip 混入商品佣金。

---

## 2. P0：修正 compensation reservation release，不得隐式核销 rider obligation

### 当前问题

`releaseCompensationReservations()` 当前解除 rider settlement reservation 后，会把释放金额追加到 `PLATFORM_ADVANCE`，同时把 `outstandingMinor` 直接置 0，并把 obligation 标 `RESOLVED`。这把“解冻资金”错误等同于“平台永久承担/骑手债务核销”。

### 已确认边界

- 用户退款不能等待骑手资金补足；平台可以暂时垫付。
- 平台垫付后的长期追偿/未来收入抵扣/write-off **尚未决定**。
- reservation release、obligation settlement、platform write-off 必须是不同语义。

### 必须修复

- `release-compensation` 只能表达“解除该 reservation”。
- 如果退款已经发生而释放了原本准备覆盖责任的 rider funds，资金缺口应继续被准确记录为平台暂时垫付/未结事实；**不能把 outstanding 清零，不能仅因 release 就标 RESOLVED。**
- 保持资金恒等关系可审计：释放 rider reservation 后，如平台事实上继续垫着该部分，应相应增加 platform-advanced/outstanding 的真实金额，而 obligation 维持未结状态。
- 不新增自动追偿、自动 future-income deduction 或 write-off 规则。
- release action 必须继续幂等、version/status guarded、可审计。
- 为“已有 outstanding + release 一部分 reservation”“release 全部 reservation”“重复 release idempotency”增加精确金额测试。

如现有 CompensationStatus 枚举无法准确表达“用户已退款但平台仍有未结垫付”，允许做最小 schema/状态修正，但不要创造长期追偿规则。

---

## 3. P0：禁止 `voluntaryPaymentMinor` 作为无真实资金支撑的已付款事实

### 当前问题

骑手可在 API 中直接提交 `voluntaryPaymentMinor`，runtime 立即把它作为 `RIDER_VOLUNTARY_PAYMENT` funded allocation，从待覆盖金额中减去；但当前没有 wallet debit、外部支付确认或可验证资金划转。

### 本轮安全处理

在真实资金通道/钱包方案确定前，**暂时禁止客户端声明一个非零金额并把它当成已到账 funding。**

允许的最小实现方向：

- 保留“骑手选择原价赔付/愿意承担”的业务动作；
- 现阶段 `voluntaryPaymentMinor` 若非 0，应被明确拒绝（4xx + 稳定错误码），或从 public API 暂时移除；
- 退款仍按已确认规则及时进行，实际可验证来源继续来自 rider settlement reservation + platform temporary advance；
- 不建立虚拟钱包、负余额、外部支付模拟成功、未来收入自动抵扣。

测试必须证明：骑手不能仅靠提交任意数字减少 platform advance/outstanding 或伪造 `RIDER_VOLUNTARY_PAYMENT` allocation。

文档要明确：这是**在真实支付能力未实现前的安全限制**，不是对未来支付方式的永久决定。

---

## 4. P0：统一 ExceptionCase participant transitions，禁止绕过 ESCALATED

### 当前问题

admin action 已有状态 guard，但 `proposeRemake()` / `respondToRemake()` 没有完整进入同一/等价状态机：

- ESCALATED case 仍可能被 rider proposal 改成 `WAITING_FOR_PARTICIPANT`；
- pending remake 在 case 后续被升级后，customer response 仍可能把 ESCALATED 改成 RESOLVED/OPEN。

### 必须修复

- 所有会改变 `ExceptionCase.status/resolutionType` 的 participant-originated action 都必须经过统一或等价的 transition guard。
- ESCALATED 后 rider/customer 普通流程不能直接覆写 case 状态。
- 若要恢复 participant interaction，必须先由 Super Admin 通过明确、有审计的 takeover/reopen/合法状态转换回可处理状态；不要让 participant request 隐式降级 ESCALATED。
- 保持 REMAKE_AND_CONTINUE 必须由用户明确确认的规则。

必须增加至少以下回归测试：

1. ESCALATED → rider propose remake 被拒；
2. pending remake → admin escalate → customer accept 被拒且 case 仍 ESCALATED；
3. pending remake → admin escalate → customer reject 被拒且 case 仍 ESCALATED；
4. 正常未升级的 proposal/accept/reject 流程仍可工作。

---

## 5. P1：ESCALATED case 可由 Super Admin 重新分配给另一位 Super Admin

当前代码在 ESCALATED 时要求 `nextHandlerAdminId === actor.id`，错误地写死“只能超管自领”。

修复为：

- ESCALATED case 的 takeover/reassign target 必须是 **SUPER_ADMIN level**；
- 发起操作的 Super Admin 可以指定另一位 Super Admin；
- 不能直接把 ESCALATED case 分给普通 OPERATOR；
- 所有前后 handler 和原因继续审计。

补测试：Super Admin A 可把 ESCALATED case 交给 Super Admin B；分给 OPERATOR 被拒。

---

## 6. P1：同步 truth-source 文档，但保持商家初始配送费为“未验证”

更新 `PRODUCT_DECISIONS.md`、`ROLE_RESPONSIBILITIES.md`、README 中已知落后内容，只做**状态校正**，不要替产品做新决定。

### 必须纠正

- README 不得再把“错误地址责任规则”列为未决定：已经确认地址错属于用户责任，骑手按原预留地址正确送达即完成原订单履约；额外转送双方自愿协商。
- “用户失联等待时间”要收窄：普通固定地址/位置节点订单正常情况下无需联系/等待；仅本人交接、强制交付码等特殊模式仍待确定。
- pricing 文档不得把 `merchantBaseDeliveryPrice` “必然不从 merchant settlement 扣”写成正式产品结论；这是当前 provisional runtime 假设。
- `PRODUCT_DECISIONS.md` 中旧的“商家自由修改基础配送报价/接单冻结该报价”等表述要与最新已确认边界对齐：
  - 已确认最终价差是平台需要控制的关键；
  - 用户 fee、rider base、merchant 初始配送金额不要求相同；
  - **商家初始配送金额真实资金语义仍待 W/真实运营验证**；
  - 已确认的 merchant rescue 追加是独立真实出资，第一版增量 100% 给 rider；
  - user tip 100% 给 rider；
  - platform subsidy 独立并消耗平台贡献/风险预算。
- 不要把“50 元蛋糕、5 元配送、商家结算 45”升级为产品规则，只能保留为待验证示例/问题。

### 文档 precedence

修完后必须自查 `PRODUCT_DECISIONS.md` → `IMPLEMENTATION_PLAN.md` / 专题 decision docs → `ROLE_RESPONSIBILITIES.md` / README 不互相打架。

---

## 7. P1：明确 migration 的 pre-production 限定，禁止把历史重写当长期范式

`20260926000400_capacity_pool_pricing` 已经重写 demo/开发期历史 settlement 与历史 BusinessConfig payload。本项目目前尚未进入真实生产账务，因此本轮 **不要为了 demo 历史做复杂反迁移**。

但必须：

- 在 `AGENTS.md`（或最合适的工程约束文档）明确：真实生产后，已 FINALIZED 财务事实、已生效历史配置版本不得通过普通 migration 静默原地改写；应使用版本化/correction/event/明确迁移策略保留审计历史。
- 在 README/CODEX_REPORT 对这次 migration 说明为 **pre-production semantic rewrite**，不是未来生产财务 migration 模板。
- 不修改现有 migration 文件来伪造已执行历史；如确需修 schema/data，新增 migration。

---

## 8. P1/P2：修复已有骑手 capacity history backfill

产品规则是“**新注册骑手**”经历 1 → 首单正常完成后同日 2 → 次日 5；不能把升级前已经正常完成过订单的既有骑手误判成新手。

### 必须修复

- 用新增 migration / 明确一次性数据迁移，从可靠的历史正常完成事实回填 `Rider.firstNormalDeliveredAt`，取该 rider 最早可确认的正常完成时间。
- 仅使用真实可证明的完成事实；不要把 CANCELLED/EXCEPTION/ABANDONED 等当成首单完成。
- 对没有任何正常完成历史的 rider 保持 null/TUTORIAL。
- 不修改旧 migration 文件。
- 增加 migration-level 或 integration-level 回归证明：已有历史 DELIVERED rider 升级后不是 TUTORIAL；无历史 rider 仍为 1。

如果当前 schema 中最可靠来源是 completed `DeliveryAssignment` + delivered order/task，请采用明确且可审计的 SQL 条件，并在报告里写清楚。

---

## 9. P1：为真实 Jev 接入补安全基础设施，但不接真实 Jev

### 9.1 Exception classifier 必须 fail-safe

- 为 `openExceptionCase()` 的 classifier 增加安全 wrapper/fallback。
- classifier throw/timeout-like error 时，异常 case 主链路仍必须创建成功，并使用 deterministic/manual fallback；AI 不可用不能阻塞用户/骑手上报异常。
- 保存 source/version/confidence，能区分正常 classifier 与 fallback。
- 增加 classifier throw 的 integration/unit test。

### 9.2 Item classifier 不得预埋“未来远程 AI 在 DB transaction 内等待”的危险路径

当前 `createOrder()` 在 Prisma transaction 内 `await classifier.classify()`。本轮要重构出一个对未来 remote adapter 安全的结构，但**不要接真实 Jev endpoint/凭据**。

要求：

- 潜在远程 classifier 调用不得发生在持有订单写事务/行锁的关键 transaction 内；
- 分类仍然是低风险辅助，失败必须回 UNKNOWN/fallback，不阻塞订单；
- 分类结果不得改变 money、责任、容量、处罚、接单资格或曝光；
- 保持创建订单的价格/商品快照一致性。若采用预分类，应在 commit 前重新校验用于下单的商品事实；若事实变化则安全重试/失败，而不是把旧分类与新商品事实静默拼接；
- 不为了这点引入复杂异步基础设施，优先最小、安全实现。

报告里必须明确 remote Jev 仍未激活。

---

## 10. P2：修正 exception routeSuggestion 与普通管理员定位

当前 deterministic classifier 仅因异常类型是 `SEVERE_FOOD_DAMAGE / FOOD_LOST / DELIVERY_DISPUTE` 就建议 `SUPER_ADMIN_REVIEW`，与已确认管理员分工不一致。

修复原则：

- **异常类型本身不等于需要超管。**
- 普通 OPERATOR 是日常人工判断者；多数异常应进入 shared/operator pool。
- 只有明确的复杂度、证据冲突、资金/权限超界、规则例外等条件才建议 Super Admin；这些条件当前并未完整自动化，因此 deterministic fallback 不应凭异常名称默认上超管。
- 当前最安全的 deterministic default 可以是 `OPERATOR_POOL`，保留 priority 作为事实排序；后续 Jev/规则再提供更细建议。

不要让 AI suggestion 自动执行升级。

---

## 11. P2：订单池快照语义要一致

当前 rider DTO 同时返回：

- Order snapshot 的 pickup/destination label/region；
- live Merchant name / live CampusLocation name。

报告却声称“基础资料后改不会漂移”。

本轮请选择最小一致方案：

- 履约决策字段以订单创建时 snapshot 为权威；
- 如果仍返回 live entity id/name，字段命名/结构必须明确它是 live reference，不得与 snapshot 混淆；或直接只返回履约所需 snapshot + stable id。
- 商家/地点改名后，骑手不应看到一个无法判断哪个才是订单约定地点的矛盾 DTO。

补负向/回归测试：创建订单后修改 merchant/location 名称，再读取 rider pool，权威履约文本仍保持订单快照。

---

## 12. P2：修 deterministic item classifier 的明显关键词优先级问题

当前“奶油蛋糕”会因为先匹配“奶”而判为 DRINK。

这是低风险质量问题，可以本轮顺手修：

- 调整优先级/规则，使明显的 `蛋糕/cake/dessert` 不被泛化“奶”抢先命中；
- 不需要追求完整 NLP；
- 补至少“奶油蛋糕 → CAKE_DESSERT + CRUSH_RISK”的单测；
- 继续保持 UNKNOWN/fallback 容错，不把 deterministic classifier 宣称为高准确率系统。

---

## 13. 测试与验证要求

先做针对性测试，再做全量验证。至少覆盖：

- 默认 commission=0 的 merchant settlement/platform revenue；
- compensation release 后 reservation、platformAdvanced、outstanding、status 的金额恒等与幂等；
- non-zero voluntaryPaymentMinor 无法伪造已付款；
- ESCALATED remake proposal/response 均不能覆写 case；
- Super Admin A → Super Admin B takeover，OPERATOR target 被拒；
- capacity historical backfill；
- exception classifier throw fallback；
- item classifier 不在关键写 transaction 等远程调用的结构性保证（用可控 fake classifier 证明失败/延迟不会破坏事务语义，避免长 sleep 测试）；
- rider pool snapshot rename regression；
- 奶油蛋糕分类回归；
- 既有 rider capacity、rescue 100% pass-through、tip 100%、subsidy、refund/version/idempotency 主测试继续通过。

最终必须执行项目既有完整验证：

- typecheck
- unit tests
- PostgreSQL integration tests
- build
- migration/schema drift 检查
- 空库 migrations + seed（如果 AGENTS/项目现有流程要求）

Docker 必须继续遵守 `AGENTS.md`：最多一次安全 restart，禁止 factory reset / clean / purge / 删除 volume / 删除用户数据目录。

---

## 14. 报告与提交要求

- 不要 force push，不要 reset/discard 用户/既有有效修改。
- 修复完成后正常 commit + push `main`。
- 更新根目录 `CODEX_REPORT.md`，不要另起散落报告。
- 报告必须逐项对应本任务 1–12：
  - 改了什么；
  - runtime 是否真正 enforce；
  - 测试是什么；
  - 哪些仍只是 adapter/hook/documentation；
  - 哪些商业问题明确没有碰。
- 报告必须明确说明：商家初始配送费真实结算语义仍待 W/真实运营验证；本轮没有把 current reference-only 实现升级为产品事实。
- 报告必须明确说明旧 `20260926000400_capacity_pool_pricing` 属于 pre-production semantic rewrite，不是生产财务 migration 范式。
- 完成全部验证后停止，不自行进入定价算法、商家结算模型或下一阶段产品功能。
