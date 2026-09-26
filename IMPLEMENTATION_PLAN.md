# IMPLEMENTATION_PLAN

> 本文件记录下一轮 Codex 的实现计划与第一版工程默认值。
> `PRODUCT_DECISIONS.md` 是产品规则最高依据；`EXCEPTION_HANDLING.md` 约束异常工作流；本文件不得创造未确认的产品规则。
> Seed、测试夹具、阈值和工程实现选择不能自动升级为永久产品规则。

## 下一轮：审核修正 + 骑手容错 + 异常订单池 + 管理员分权

### 总目标

本轮先收口上一轮审核发现的真实缺口，再实现已经确认的骑手未取餐无责取消、冷却、取餐后严重异常、赔付资金记录、异常订单池和普通/超级管理员分权。

本轮仅要求后端数据模型、服务、API、权限、迁移、审计、测试和 README/OpenAPI；不做完整后台/小程序 UI，不接真实微信支付/提现，不自动判责。

---

## 0. 先修复上一轮审核遗留

这些事项必须在新功能之前完成，并在报告中逐项证明运行时行为，而不是只提供字段/接口占位。

### 0.1 TRIAL 必须产生真实灰度曝光差异

当前 TRIAL 只是状态标签，目录返回基本等同 NORMAL。

本轮要求：

- 建立真实 catalog exposure gate，使 TRIAL 商家不是默认对所有用户全量可见。
- 第一版允许采用**稳定、确定性的用户灰度桶**作为工程实现：基于 merchantId + customerId 的稳定 hash 与管理员配置的 exposure BPS 决定可见性，避免刷新时抖动。
- 新增版本化配置，例如 `merchantTrialExposureBps`；Seed 值明确标注 DEMO。
- 种子商家支持显式管理员/数据标记将试运营曝光覆盖到 100%，但不形成永久豁免。
- HIDDEN/SUSPENDED 始终不可见。
- 该灰度实现只是第一版工程选择；以后可以换成区域/宿舍/订单数等策略，不得把 stable-hash 方式写成永久产品规则。
- 增加测试证明：同一用户结果稳定、不同用户可产生灰度差异、种子覆盖生效、隐藏商家不可见。

### 0.2 商家曝光策略不能继续伪装成“多因素”

当前 policy 接收多个输入，但实际状态迁移近似只看 `noRiderAcceptedRateBps`。

本轮要求：

- 自动曝光策略至少真实使用已经确认可以参与决策的两个方向：
  1. 完成/无人承接风险；
  2. 补贴健康度（补贴依赖 + 补贴救援效果）。
- `timeRisk=SLOW` 本身不得导致降曝光。
- `exceptionCounts` 在责任归因未完成前只能作为事实/管理员参考，不能自动把所有异常算成商家责任。
- 第一版可配置规则建议：高补贴依赖且补贴救援效果低时，允许阻止恢复或推动有限降级；具体阈值全部来自 BusinessConfig。
- 不做单一综合分。
- 报告必须说明每个 policy input 是否真的影响决策，未使用输入明确写 reserved。

### 0.3 恢复滞后要有独立 sample/window

- 除进入阈值/恢复阈值不同外，再实现独立的恢复最小样本量/恢复观察窗口。
- 新增配置，例如 `merchantExposureRecoveryMinimumSampleSize` 与 `merchantExposureRecoveryWindowOrderCount`。
- 商家不能仅因短期一两单改善立即恢复 NORMAL。
- 降级与恢复使用的样本语义必须在代码和测试中清楚。

### 0.4 修正补贴救援率口径

- `subsidizedClaimConversionBps` / rescue metric 必须明确 numerator、denominator。
- 进行中、尚未到可判断终态的订单不能静默作为“未救回”进入分母。
- 优先用已到可判断终态的补贴样本计算；若样本不足返回 null/insufficient data。
- 如现有名称与实际口径不符，重命名而不是保留误导名称。

### 0.5 修复 customer catalog 数据泄漏

- `GET /merchants/:merchantId/products` 和其他 customer-facing catalog/order API 禁止直接 spread 原始 Merchant ORM 实体。
- 建立显式 customer-safe DTO/select。
- 用户不得获得 `deliveryContributionMinor`、内部 `maxConcurrentOrders`、owner/internal IDs、内部 exposure/policy 细节等非用户所需字段。
- 增加敏感字段“不出现”的负向测试。
- 同步抽查 merchant/rider role API，遵守 `AGENTS.md` 的 role isolation。

### 0.6 分离 rolling metric 样本集合

- 不要先取最近 N 个所有 published task 再让大量进行中订单挤掉历史有效终态样本。
- completion/time terminal metrics 与 live claim/subsidy metrics 使用适合各自定义的独立样本集合/查询。
- 样本定义写入代码注释/测试与报告。

---

## 1. 骑手未取餐无责取消

### 1.1 正常行为

- 新增明确的“pre-pickup responsibility-free cancellation”服务/API；它不是恢复旧的无限制 abandon。
- 只允许：
  - 当前任务已被该骑手 claim；
  - 尚未 actual pickup；
  - 骑手当前有资格使用该入口。
- 取消后：
  - 当前 assignment 结束并保留完整历史；
  - DeliveryTask 回到可承接状态；
  - Order 回到与订单池一致的状态；
  - riderId/claimedAt 等当前占用字段按模型正确释放；
  - **原 `firstPublishedAt`、`claimDeadline`、final warning 节点绝不刷新**；
  - 商家报价、平台补贴、用户 tip 已存在的订单资金事实不得因此重置。
- 如果重新入池时原 claimDeadline 已到/立即到期，应按原截止规则失败，不授予新的 40 分钟。
- 每次取消都创建不可变事实事件，记录 rider、order/task/assignment、时间、取消原因（结构化 reason + optional note）和当时计数。

### 1.2 单日规则

第一版 DEMO/产品当前默认：

- 当日第 1 次：记录，无额外限制；
- 当日第 2 次：创建正式 warning，并暂停该骑手当天剩余时间继续接**新订单**。

注意：

- 暂停接新单不得自动破坏骑手已经持有的其他订单；已持订单继续按正常/异常流程履约。
- 自然日按平台/校园时区（当前 China campus semantics 使用 `Asia/Shanghai` 或明确配置），不能按数据库 UTC 生硬切日。

### 1.3 7 天滚动规则

两条路径并存：

1. **warning path**：7 天内出现第 2 次正式 warning → 第一版进入 2 天 cooldown；
2. **cancellation accumulation path**：尚未触发第 2 次 warning，但 7 天内未取餐无责取消达到第一版 4 次 → 第一版进入 2 天 cooldown，不因此补记“第 2 次 warning”。

要求：

- cooldown 只禁止接新单，不自动终止已经持有的订单。
- 两条路径都可配置；不要把 2 / 4 / 7 天 / 2 天散落硬编码。
- 至少配置：
  - `riderDailyFreeCancelLimit` / warning threshold；
  - `riderCancellationRollingWindowDays`；
  - `riderCancellationCooldownThreshold`；
  - `riderWarningCooldownThreshold`；
  - 两路径 cooldown seconds/days。
- 当前第一版参数可 Seed 为已确认默认，但控制台/BusinessConfig 可实时调整未来判断。
- 计数事件必须可审计；不要只在 Rider 表存一个不可解释的累计数字。

### 1.4 骑手限制状态与管理员 override

建立 rider restriction/cooldown 事实与审计结构，至少能表示：

- same-day new-claim pause；
- rolling cooldown；
- source/reason；
- startsAt / endsAt；
- active/released/overridden；
- automatic vs admin action；
- operator/reason/audit。

超级管理员可以：

- 提前解除；
- 延长；
- 降低/提高限制；
- 人工增加明确限制。

普通管理员默认不得任意跨订单修改骑手处罚；只有后续显式授权的能力才可执行。

---

## 2. 取餐后严重餐损/丢失

### 2.1 异常类型与入口

至少支持明确区分：

- minor damage / delay（可协商继续，不一定生成正式 case）；
- severe food damage；
- food lost；
- delivery dispute / complaint；
- other / needs review。

不自动判责。

### 2.2 补餐继续

严重餐损/丢失后，骑手可以提出 `REMAKE_AND_CONTINUE`：

- 骑手记录已联系商家补做及说明；
- 用户必须显式确认是否接受继续等待；
- 用户确认后才能继续正常履约；
- 用户拒绝时转到退款赔付或争议流程；
- 平台不定义骑手与商家如何结算补做成本。

### 2.3 原价赔付并结束

第一版内部账务实现，不接真实支付网关：

- 骑手可以主动选择赔付；管理员也可在异常处理后确认该结果。
- 一旦平台确认 `REFUND_AND_CLOSE`，用户侧退款事实应立即生成/推进，不等待骑手先补足资金。
- “订单本体退款”与 RiderTip 独立：不得因为退款自动清零、撤销或重算已经成立的 tip；继续遵守 tip 的独立规则。
- customer refund 的订单本体口径必须使用当前 customer-facing 已支付订单金额中**不含 RiderTip 的部分**，并在报告中列明组成；若现有模型无法安全表达，先做显式 ledger 字段，不要混账。
- 订单进入明确的异常退款终态/处理结果，不能伪装成正常 DELIVERED。

---

## 3. 骑手赔付义务、冻结与资金来源

### 3.1 核心原则

- 平台不能无依据任意扣历史资金。
- 当骑手主动选择赔付，或管理员处理确认某具体订单产生明确骑手赔付义务时，平台可以冻结该骑手**未提现资金**中对应金额。
- 本单资金不足时，可以冻结其他订单产生但尚未提现的余额，最高到本次明确应赔金额。
- 当前不得自动制造无限负余额，也不得把“平台垫付”直接变成无上限未来追债。

### 3.2 数据模型

实现可审计的赔付 obligation + funding allocation / reservation 结构，语义至少能表达：

- requiredCompensationMinor；
- orderId / riderId / exceptionCaseId；
- rider current-order reserved amount；
- rider other unwithdrawn balance reserved amount；
- rider voluntary payment/transfer amount；
- platform advanced amount；
- customer refund amount；
- outstanding/unsettled amount；
- status；
- created/updated/resolved timestamps；
- actor + reason。

允许具体表名按现有模型调整。

### 3.3 防止重复占用资金

- 如果用 RiderSettlement/PENDING/AVAILABLE 作为未提现资金来源，必须支持**部分金额 reservation**，不能为了赔 5 元把整笔 50 元 settlement 全部不可解释地吞掉。
- 同一份未提现资金不能被两个赔付 obligation 重复冻结。
- 事务中锁定/版本保护可用资金，保证并发赔付不会超额 reserve。
- 每个 allocation 记录来源 settlement/wallet bucket（如适用）、金额、用途和 order/case。
- 真实提现尚未实现，但数据模型必须让未来提现只能使用未被 reservation 的金额。

### 3.4 用户退款与平台垫付

- 用户退款流程不等待 rider obligation 完全结清。
- 骑手可冻结/主动支付金额不足时，差额记录为 `platformAdvancedMinor` / equivalent。
- 不在本轮决定平台垫付后自动停接单、未来收入自动抵扣、线下追偿等规则。

---

## 4. 异常订单池

### 4.1 Case 模型

在现有 ExceptionEvent 事实之上建立可运营的 ExceptionCase（命名可调整），至少包括：

- caseId；
- orderId；
- category / subtype；
- severity / priority（可以 UNKNOWN）；
- status；
- currentHandlerAdminId；
- claimedAt；
- lastActionAt；
- resolutionType；
- resolutionNote；
- escalatedAt / escalationReason；
- version / concurrency token；
- createdAt / resolvedAt。

事实事件与运营 case 不要混成同一含义：ExceptionEvent 可以保留不可变事实，Case 表示当前处理工作流。

### 4.2 状态第一版

可以使用类似：

- OPEN / UNCLAIMED；
- IN_PROGRESS；
- WAITING_FOR_PARTICIPANT；
- ESCALATED；
- RESOLVED；
- CLOSED。

枚举名可调整，但要支持“责任无法确定/证据不足”作为合法 resolution，而不是强迫归责。

### 4.3 自行领取 + exactly-one-active-handler

- 第一版共享池，普通管理员自行领取。
- 同一 case 同一时刻只能有一个有效处理人。
- 使用数据库原子条件更新、row lock + conditional update、CAS/version、lease 或等效机制实现；不要只在应用层先查再写。
- 两个管理员并发领取，只能一人成功。
- release / transfer / takeover / escalation 都要审计。
- 超级管理员可接管卡住 case。

### 4.4 高风险动作幂等

退款、冻结、释放、赔付 allocation、订单关闭至少满足：

- idempotency key 或唯一业务约束；
- version/status precondition；
- transaction；
- 重试不会执行两次经济动作。

必须有并发/重复请求测试。

---

## 5. 普通管理员与超级管理员

### 5.1 不改变普通用户业务身份模型

- 不修改“一个业务账号是否多角色”的未决问题。
- 在现有 `ADMIN` 业务身份内部增加 admin level / admin capability 模型。
- 第一版至少支持 `OPERATOR` 与 `SUPER_ADMIN`；具体 schema 命名可调整。

### 5.2 普通管理员

普通管理员是真正处理日常异常的人，不是“只能看、所有判断都上交超管”。

默认可以：

- 浏览异常池；
- 原子领取/释放自己权限内的 case；
- 查看该 case 所需时间线、证据、参与者和订单级资金事实；
- 做日常人工判断；
- 选择已授权标准结果：补餐继续、退款结束、等待补充、责任无法确定、维持/继续履约、升级等；
- 执行系统已经定义好金额与范围的订单级冻结/释放/退款动作。

默认不能：

- 修改全局 BusinessConfig；
- 管理管理员身份/权限；
- 绕过 ledger 任意输入扣款；
- 修改平台级补贴/结算政策；
- 无边界调整骑手跨订单处罚；
- 对复杂/高风险 case 越权处理。

### 5.3 超级管理员

- 拥有后台完整管理权限；
- 现有全局 BusinessConfig 写操作改为 SUPER_ADMIN；
- 管理 admin level/capabilities；
- 可接管/释放/重新分配异常 case；
- 可处理普通管理员升级的复杂、高风险、权限不足案件；
- 可执行 rider restriction override；
- 高风险动作全部审计。

### 5.4 现有 admin API 权限清点

逐个审计所有 `/admin/**` API：

- 明确哪些是 operator-safe；
- 哪些必须 SUPER_ADMIN；
- 不允许因为旧代码只有 `role === ADMIN` 就默认全部继续开放。

在 `CODEX_REPORT.md` 列出权限矩阵。

---

## 6. Jev / AI 异常分类边界

本轮**不要求接真实 Jev 外部调用**，除非仓库已经存在安全可用的依赖和凭据配置；禁止为了“完成”而硬编码 API key 或让测试依赖公网。

本轮需要：

- 抽象 `ExceptionClassifier` / equivalent 类型化接口；
- 输出预定义 category / subtype / priority / route suggestion / confidence；
- 保存 classifier source/version/result 与最终管理员结论分开；
- 提供 deterministic/no-op/manual fallback，使 Jev 不可用时异常池仍完整工作；
- AI 输出不得直接执行 refund/freeze/penalty/liability/account restriction。

报告中如果没有真实 Jev runtime integration，必须明确写为 **policy hook / adapter ready, not active**，不得声称 Jev 已上线。

---

## 7. API / 角色视图

### 骑手

至少需要：

- pre-pickup responsibility-free cancel；
- 查看自己的当日取消计数、7 天计数、warning、pause/cooldown 与到期时间；
- severe damage/loss report；
- propose remake；
- choose voluntary compensation；
- 查看与自己相关的 compensation obligation/冻结摘要，但不能看到其他人的敏感资金。

### 用户

至少需要：

- 收到 remake proposal 并 confirm/reject；
- 查看与自己的订单有关的异常处理状态和退款结果；
- 角色安全，不暴露 rider/internal funding breakdown。

### 普通管理员

至少需要：

- list/filter exception pool；
- claim/release own case；
- case detail；
- submit judgment/resolution；
- request more info / responsibility-undetermined / escalate；
- operator-safe standard economic action。

### 超级管理员

至少需要：

- takeover/reassign case；
- rider restriction override；
- admin level/capability management（第一版可最小实现）；
- 现有高风险 admin config/action。

所有响应显式 DTO/select，不返回 raw ORM。

---

## 8. 本轮明确不做

- 不做自动判责；
- 不做 AI 自动退款/冻结/处罚；
- 不做真实 Jev 网络调用作为核心依赖；
- 不做真实支付、提现；
- 不做完整后台 UI；
- 不做异常自动下派；
- 不做骑手欠平台款后的自动未来收入抵扣/自动停单（除已确认未取餐取消冷却）；
- 不定义严重餐损最终固定赔付比例或商家分摊；
- 不修改普通业务账号单角色模型；
- 不实现复杂 SLA/客服班组；
- 不做骑手综合评分。

---

## 9. BusinessConfig / 第一版参数

复用版本化 BusinessConfig + Audit，至少增加/校验：

- merchantTrialExposureBps；
- merchantExposureRecoveryMinimumSampleSize；
- merchantExposureRecoveryWindowOrderCount；
- riderDailyFreeCancelLimit / daily warning threshold；
- riderCancellationRollingWindowDays；
- riderCancellationCooldownThreshold；
- riderWarningCooldownThreshold；
- riderCancellationCooldownSeconds；
- riderWarningCooldownSeconds。

第一版 Seed 使用当前产品已确认数字：

- daily: 1 次仅记录，第 2 次 warning + 当日暂停；
- rolling window: 7 天；
- cumulative cancellation threshold: 4；
- warning cooldown threshold: 2 warnings；
- 两条 cooldown 第一版 2 天。

这些都必须可配置，不得散落魔法数字。

---

## 10. Migration / 兼容

- 使用正式 Prisma migration，不改历史 migration。
- 迁移必须支持当前数据库升级和空库重建。
- 现有数据如需 backfill admin level：当前 Seed/已知平台管理员可按最小安全策略设为 SUPER_ADMIN；不要把所有未来 ADMIN 默认升级成 SUPER_ADMIN。
- compensation reservation、exception case、rider restriction 等新增约束必须有数据库 check/unique/index 支撑关键不变量。
- Seed 连续执行至少两次保持幂等。

---

## 11. 测试重点

除正常 unit/integration 外，至少覆盖：

1. pre-pickup cancel 成功回池且原 deadline 不变；
2. pickup 后不能使用无责取消；
3. 第 1/第 2 次日内行为；
4. 跨自然日计数使用 campus timezone；
5. 7 天 4 次累计路径与 2-warning 路径分别触发 cooldown；
6. cooldown/pause 阻止新 claim，但不破坏已持订单；
7. 超级管理员 override 审计；
8. 两管理员并发 claim exception case 只能成功一个；
9. 重复 refund/freeze 请求不会重复执行；
10. remake proposal 必须 customer confirm 才继续；
11. refund-and-close 不自动改变 RiderTip；
12. compensation reserve 不超过未提现可用额，不重复冻结同一资金；
13. 余额不足时正确记录 platform advance/outstanding；
14. operator 不能写 BusinessConfig/高风险权限，super admin 可以；
15. operator 能实际做普通人工 case resolution；
16. customer/merchant/rider DTO 不泄漏内部资金/管理员字段；
17. TRIAL 真正灰度，stable bucket 稳定；
18. subsidy rescue denominator 不把 in-progress 当失败；
19. recovery window/min sample 生效；
20. exposure policy 的 subsidy health 输入确实影响已定义的策略分支；
21. rolling metric 不被大量进行中订单挤掉 terminal 样本。

---

## 12. 验证

严格遵守 `AGENTS.md` Docker 规则。

完成后运行：

- `pnpm typecheck` / 项目对应 typecheck；
- unit tests；
- PostgreSQL integration tests；
- build；
- Prisma migration status / drift；
- 当前数据库 migrate；
- 空库完整 migrate；
- Seed 连续至少两次；
- OpenAPI 路径/权限检查。

Docker 如失败，按 CLI health → 一次安全 restart → diagnostics 流程；禁止 destructive reset/cleanup。

---

## 13. CODEX_REPORT 审核清单

报告必须按 `AGENTS.md` 区分 enforced / telemetry / hook / not implemented，并逐项回答：

1. 上轮 6 个审核缺口分别如何修复，runtime enforcement 和 test 在哪里？
2. TRIAL 是否真的改变用户目录可见性？灰度工程算法是什么、哪些部分只是 provisional？
3. Exposure policy 实际用了哪些因素？哪些输入仍 reserved？
4. rescue metric numerator/denominator 与 terminal population 是什么？
5. recovery sample/window 如何防止快速恢复？
6. customer catalog 是否仍泄漏 Merchant internal fields？列出负向测试。
7. pre-pickup cancel 如何保证原 firstPublishedAt/claimDeadline 不变？
8. 日内、7 天累计、warning/cooldown 如何计数？campus timezone 如何处理？
9. pause/cooldown 是否只阻止新 claim，不破坏已持订单？
10. compensation obligation 与各 funding source 如何建模？如何避免同一未提现资金重复冻结？
11. refund-and-close 的 customer refund 组成是什么？如何证明 RiderTip 未被自动改写？
12. 余额不足时 platform advance/outstanding 如何记录？本轮刻意没有做哪些追偿逻辑？
13. ExceptionCase 的 exactly-one-active-handler 如何保证？并发测试结果？
14. refund/freeze/close 的幂等/版本保护如何保证？
15. operator 与 super admin 的完整 endpoint 权限矩阵。
16. 普通管理员是否真的可以完成人工判断/标准处理，而不是所有 case 都必须升级？
17. Jev/AI 部分是 active runtime integration 还是 adapter/hook？不要夸大。
18. 所有 migration、typecheck、test、build、空库 migrate、双 Seed 和 Docker 验证结果。
19. 已知问题和刻意未实现内容。

完成后停止，不自行开始微信登录、真实支付、自动下派或下一阶段产品设计。
