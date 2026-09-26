# CODEX_TASK

执行当前根目录 `IMPLEMENTATION_PLAN.md` 的全部内容。

开始前按以下顺序完整阅读并核对当前工作区：

1. `git status` / `git diff` / 最近 commits / migrations / untracked files；不要 reset/discard 已有有效工作。
2. `AGENTS.md`
3. `PRODUCT_DECISIONS.md`
4. `IMPLEMENTATION_PLAN.md`
5. `AUDIT_FOLLOWUP.md`
6. `RIDER_CAPACITY_DECISIONS.md`
7. `ORDER_POOL_DECISIONS.md`
8. `DELIVERY_PRICING_DECISIONS.md`
9. `EXCEPTION_HANDLING.md`
10. `ROLE_RESPONSIBILITIES.md`
11. `OPERATIONS_CONTEXT.md`
12. Prisma schema、Seed、README/OpenAPI 与相关 runtime/tests。

## 本轮执行顺序

### 1. 先修审核补丁

必须先完成 `AUDIT_FOLLOWUP.md`：

- 每日无责取消真正封顶；
- ExceptionCase 合法状态机；
- RESOLVED/CLOSED terminal protection；
- ESCALATED 后 operator 权限边界；
- refund-and-close 真正使用 expectedVersion + status guard + idempotency；
- voluntary compensation 的合法状态/严重异常限制；
- 陈旧页面与并发回归测试。

修完并通过针对性测试后再进入新功能。

### 2. 实现骑手容量 1 → 2 → 5 + 全局/个人上限

- Seed 全局绝对上限 10，版本化配置；
- 新 rider 未正常完成首单：1；
- 首单正常 DELIVERED 后同一校园自然日：2；
- 下一校园自然日：5；
- 5 后不自动升级；
- Super Admin 可设置单 rider override；
- effective cap = min(personal/global)；
- 下调不破坏已持订单，只阻止新 claim；
- claim transaction 原子防并发越限；
- rider 可查看当前 capacity/stage，并能读取 1→2、2→5 的额度变化通知/事件；
- 不实现自动降额度、骑手评分或 5 后自动升级。

### 3. 实现 rider order-pool 最低决策 DTO

至少包含：

- rider guaranteed payout；
- pickup merchant/location/region；
- destination snapshot/location；
- foodType 粗分类；
- quantity / carrying-count fact。

显式 DTO/select；不泄漏 customer/private internal pricing/platform spread。
不做 UI、地图、自动路线、拼单推荐。

### 4. 实现低风险 item classifier / Jev hook

- 保存原始商品名/商家分类与 AI 建议分离；
- typed foodType + optional handlingTags + source/version/confidence；
- deterministic/manual/UNKNOWN fallback；
- classifier 失败绝不阻塞下单/入池/配送；
- AI 输出绝不能执行或影响资金、责任、处罚、容量、接单资格、商家曝光。
- 如果没有安全可用的真实 Jev 配置，不硬编码 key、不依赖公网测试；报告明确 `adapter/hook ready, not active`。

### 5. 重构配送价格语义

严格按 `DELIVERY_PRICING_DECISIONS.md`：

- merchant base/reference delivery price ≠ merchant real contribution；
- customerDeliveryFee；
- riderBasePayout；
- merchantRescueContribution；
- customerRiderTip；
- platformSubsidy；
- riderGuaranteedPayout；
- platform delivery contribution/spread；
- 迁移旧 `merchantDeliveryContributionMinor` 语义，不能继续一字段两义。

第一版公式：

`riderGuaranteedPayout = riderBasePayout + merchantRescueContribution + customerRiderTip + platformSubsidy`

`deliveryPlatformContribution = customerDeliveryFee - riderBasePayout - platformSubsidy`

商家 rescue 增量与用户 tip 均 100% 传给 rider；merchant rescue 是真实商家新增资金，base/reference price 不是。

### 6. 第一版 pricing policy

实现可替换、可配置、可审计的确定性 policy，不做黑箱“最优价格算法”。

允许使用 merchant base price、merchant/category、pickup region、destination region、foodType、quantity 等输入；按当前 schema 能安全支持的层级实现。

要求：

- customer fee 与 rider base payout 独立计算；
- baseline 不隐藏制造负价差；主动让利通过既有受预算约束的 platform subsidy；
- Super Admin 可配置全局/商家相关 pricing 参数并审计；
- Seed 值只作为 DEMO；
- policy version + inputs/reason 可追溯；
- 报告必须区分已真正参与 runtime 计算的 input 与 reserved input。

### 7. 把 merchant reprice 迁移为 rescue contribution

- 未 claim 前可追加；
- 增量 100% 加到 rider guaranteed payout；
- 从 merchant 真实资金/settlement 记录；
- 不刷新 firstPublishedAt/claimDeadline；
- 保留 cooldown/version/history；
- claim 后已承诺收益不可向下撤销；
- claim 瞬间原子快照全部资金来源。

如为兼容保留旧 endpoint/字段名，必须在内部和 OpenAPI 明确新语义，避免继续把 reference price 当 real contribution。

## 强约束

- 不修改普通业务账号单角色模型。
- 不做真实微信支付/提现/退款网关。
- 不做路线规划、导航、自动拼单。
- 不做 5 单后自动升额或异常自动降额。
- 不做机器学习/黑箱动态定价。
- 不让 Jev/AI 影响高风险动作。
- 不擅自确定平台商品佣金最终比例、支付通道费、税费。
- 所有钱使用 integer minor units。
- 所有 customer/merchant/rider API 使用显式 DTO/select。
- 关键资金、capacity override、pricing config、claim snapshot、exception transitions 必须可审计。
- 严格遵守 `AGENTS.md` Docker 与 implementation truthfulness 规则。

## 完成与验证

执行 `IMPLEMENTATION_PLAN.md` 的必测场景，并完成：

- typecheck；
- unit tests；
- PostgreSQL integration tests；
- build；
- current DB migration/status/drift；
- current DB migrate；
- empty DB full migrate；
- Seed 连续至少两次；
- OpenAPI/权限检查；
- Docker 如异常最多一次安全 restart，禁止 destructive cleanup/reset/purge/delete volumes。

完成后：

1. 更新必要 README/OpenAPI；
2. 提交并普通 push `main`，禁止 force push；
3. 生成根目录 `CODEX_REPORT.md`，逐项回答 `IMPLEMENTATION_PLAN.md` 的报告要求，特别说明：audit 修复、容量并发保护、订单池 DTO、Jev active/hook 状态、旧 pricing migration、资金来源、100% merchant rescue pass-through、platform contribution、policy active/reserved inputs、权限矩阵、测试/migration/Seed/Docker 结果、刻意未实现和仍待产品决定内容；
4. 完成后停止，不自行进入下一阶段。
