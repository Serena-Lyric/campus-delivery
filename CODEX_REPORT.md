# CODEX_REPORT

## 1. 任务、提交与结果

- 任务：审核补丁 + 骑手容量 + 订单池决策信息 + 配送定价语义拆分。
- 起始提交：`04f167e8040feff9f2755d5509f0c9db97b60c48`。
- 实现提交：`d0edaf1`（`feat: add capacity and split delivery pricing`）。
- 分支：`main`；实现提交已普通 push，未 force push。
- 未 reset、discard、checkout 或覆盖已有工作。

计划内后端实现与验证已完成。本报告生成后停止，不进入下一阶段。

## 2. Implementation truthfulness

### Enforced behavior

- 每日取餐前无责取消次数真正封顶；已持第三单也不能继续使用免费取消入口。
- ExceptionCase 显式状态机、terminal protection、ESCALATED 决策边界。
- refund-and-close 的 version/status/idempotency/transaction 保护；rider voluntary compensation 仅限严重餐损/丢失合法状态。
- 骑手容量 1→2→5、global cap、个人 override、原子 claim 限制与通知事件。
- Rider order-pool 显式决策 DTO。
- 拆分后的 delivery pricing、merchant rescue、tip、subsidy 和 claim 快照公式。
- pricing/capacity 配置仅 SUPER_ADMIN 可写。

### Data / telemetry available

- 原始商品名、商家原始分类、suggested foodType、handlingTags、classifier source/version/confidence。
- pricing policy version、reason、inputs snapshot；claim 时完整资金来源快照。
- Rider firstNormalDeliveredAt、capacity stage/override events。

### Policy hook / adapter ready

- ItemClassifier typed adapter、deterministic fallback、manual/UNKNOWN fallback 已接入。
- 没有真实 Jev endpoint/凭据或公网调用：`adapter/hook ready, not active`。

### Not implemented

- 真实支付/提现/退款网关。
- 路线规划、导航、自动拼单。
- 5 单后自动升级、异常自动降容量或骑手评分。
- ML/黑箱动态定价。
- category/region/foodType 对金额的正式调整矩阵。

## 3. 审核补丁

### 3.1 每日免费取消封顶

`cancelBeforePickup()` 在任何 assignment/task/order 修改前读取校园自然日计数；`dailyBefore >= riderDailyFreeCancelLimit` 时返回 `RIDER_DAILY_FREE_CANCEL_LIMIT`。配置值不是硬编码。

回归测试覆盖：骑手在触发第 2 次 warning 前已经持有第 3 单，第 3 次取消返回 409，第三单仍保持 CLAIMED。

### 3.2 ExceptionCase 状态机

新增 `exception-cases/state-machine.ts`，逐动作约束：

- CLAIM：仅 OPEN；
- RELEASE/TRANSFER/ESCALATE/RESOLVE/ADMIN_REFUND：仅 IN_PROGRESS 或 WAITING_FOR_PARTICIPANT；
- TAKEOVER：OPEN/IN_PROGRESS/WAITING/ESCALATED；
- RIDER_COMPENSATE：OPEN/IN_PROGRESS/WAITING。

RESOLVED/CLOSED 对 release、transfer、takeover、escalate、resolve、refund 全部 terminal。ESCALATED 后 operator resolve/refund 被拒绝；SUPER_ADMIN 必须先 audited takeover，且 ESCALATED takeover 不能直接重新分给 operator。

纯单元矩阵和 PostgreSQL route 回归均通过。

### 3.3 经济动作 stale-state 保护

Admin refund：

1. case row `FOR UPDATE`；
2. handler permission；
3. legal status；
4. 实际比较 `expectedVersion`；
5. conditional update 预占 version；
6. 同一事务执行 obligation/reservation/refund/order close；
7. final resolution 使用预占后的 version/status 条件。

Rider voluntary compensation 也要求 expectedVersion，且只允许 `SEVERE_FOOD_DAMAGE` / `FOOD_LOST`。REMAKE_AND_CONTINUE/RESOLVED/CLOSED 不能被覆盖。

幂等 key 处理真正的同请求重试；version/status guard 独立处理陈旧页面。测试覆盖 remake 接受后的 stale admin refund、stale rider compensation、ESCALATED operator refund，以及相同 refund key 并发重试只生成一份 obligation。

Reservation release 同样要求 RESOLVED + REFUND_AND_CLOSE、expectedVersion 与 release idempotency key。

## 4. 骑手容量

### 4.1 阶段计算

- 无 `firstNormalDeliveredAt`：TUTORIAL，个人容量 1。
- 首单正常 DELIVERED 后同一 Asia/Shanghai 校园自然日：FIRST_DELIVERY_SAME_DAY，容量 2。
- 下一校园自然日起：STANDARD，容量 5。
- 5 后无自动升级。

首次正常送达事务写 `firstNormalDeliveredAt` 和唯一 FIRST_DELIVERY_UPGRADE 事件；首次在下一校园日读取/claim 时幂等写 NEXT_DAY_UPGRADE 事件。

### 4.2 Override、global cap 与并发

- Seed 全局 cap：10，位于版本化 ORDER_POLICY。
- SUPER_ADMIN 可设置/清除 `capacityOverride`；每次写 RiderCapacityEvent，记录 actor、reason、前后容量和 metadata。
- `effectiveCapacity = min(personalCapacity, platformMaxConcurrentOrdersPerRider)`。
- claim 事务先锁 Rider，再计算 stage/override/global cap 与 active CLAIMED/PICKED_UP 数量。
- 调低个人或 global cap 不取消已有任务，只阻止新 claim。

测试覆盖：新 rider 两个并发 claim 竞争唯一槽位仅一个成功；首单后同日 2、下一日 5；override/global min；个人/global 下调后已持单保留、新 claim 被拒；OPERATOR override 返回 403。

## 5. Rider order-pool DTO

`GET /delivery-tasks/available` 和 rider task response 返回显式 DTO：

- `riderGuaranteedPayoutMinor`；
- pickup merchant、locationName、region；
- destination label snapshot、region、location；
- totalQuantity、lineItemCount；
- foodTypes、handlingTags；
- preparation/status/deadline 等既有履约事实。

取餐/目的地使用 Order 快照，基础资料后改不会漂移历史订单。负向测试确认 DTO 不含 customerId、customer fee、rider base、merchant rescue、platform subsidy 或 platform contribution。未做地图、路线或拼单建议。

## 6. Item classifier / Jev

- `FoodType`：DRINK/RICE_MEAL/NOODLE/SOUP/CAKE_DESSERT/OTHER/UNKNOWN。
- OrderItem 分开保存原始商品名、商家分类、AI 建议、tags、source/version/confidence。
- deterministic classifier 根据有限关键词产生低风险建议；adapter 抛错时 `classifyItemSafely()` 回退 MANUAL_FALLBACK/UNKNOWN。
- classifier 失败的集成测试仍成功创建订单；原始事实保留，金额保持 pricing policy 结果。
- classifier 输出没有被容量、责任、处罚、接单资格或曝光模块读取。

真实 Jev：**未激活**。

## 7. 配送价格语义与 migration

### 7.1 新语义

- `merchantBaseDeliveryPriceMinor`：参考输入，不是真实商家出资。
- `customerDeliveryFeeMinor`：用户承担的基础配送费。
- `riderBasePayoutMinor`：骑手基础保证收益。
- `merchantRescueContributionMinor`：商家真实追加资金。
- `customerRiderTipMinor`：用户红包。
- `platformSubsidyMinor`：平台补贴。
- `riderGuaranteedPayoutMinor`：骑手当前保证总收益。
- `deliveryPlatformContributionMinor`：配送部分平台贡献。

Runtime 公式：

`guarantee = riderBase + merchantRescue + tip + subsidy`

`deliveryPlatformContribution = customerDeliveryFee - riderBase - subsidy`

`platformRevenue = existing item commission fact + deliveryPlatformContribution`

商品佣金最终规则仍未决定；本轮未修改既有 commission 配置语义。

### 7.2 旧字段迁移

`20260926000400_capacity_pool_pricing`：

- 旧 merchant/order `merchantDeliveryContributionMinor` 复制为 reference/base 后置零；
- 历史 pricing 的 rider base 由旧 guarantee - tip - subsidy 推导；
- rescue 初始化为 0；旧 guarantee 保留；
- merchant settlement 加回旧 reference amount，避免继续把参考价当真实商家欠款；
- 已 FINALIZED Settlement merchant payable 同步加回 reference；
- 保存 legacy migration input/reason；
- 新建 rescue event、capacity event、location/classification snapshots。

旧 `MerchantDeliveryQuote` 与旧 snapshot 字段保留为 legacy audit compatibility，不参与新账务；新 rescue history 使用独立 `MerchantRescueContributionEvent`。

`20260926000500_guaranteed_payout_snapshot` 增加显式 `riderGuaranteedPayoutMinorAtClaim`。

`20260927000100_drop_item_classification_backfill_defaults` 只移除历史回填默认值，使新 runtime 必须显式保存分类事实。

## 8. Merchant rescue 100% pass-through

兼容 endpoint `/merchant/orders/:orderId/delivery-quote` 内部已迁移为 rescue contribution；OpenAPI 主字段为 `newRescueContributionMinor`，`newMinor` 仅为 deprecated alias。

- 仅未 claim 且未过原 deadline 可增加；不能下降或原值重写。
- 保留 cooldown、CAS version、row lock、history、actor/reason。
- 增量 X：merchant rescue +X、merchant settlement -X、rider guarantee +X；platform contribution 不变。
- 不更新 firstPublishedAt/claimDeadline。

测试证明 rescue +50 后 guarantee 220→270、merchant settlement 1900→1850、platform contribution 保持 100；下降到 40 被拒；claim 原子快照 rescue=50。

## 9. Tip、subsidy 与 platform contribution

- Tip +X：customer tip +X、guarantee +X、platform contribution 不变。
- Subsidy +X：platform subsidy +X、guarantee +X、platform contribution -X；原预算、步长、间隔和单订单上限继续执行。
- Base/reference 不进入 merchant real funding，也不进入 guarantee 求和。

集成测试最终快照：customer fee 320、rider base 220、rescue 50、tip 30、subsidy 50、guarantee 350、platform contribution 50。

## 10. Pricing policy

第一版 `ConfiguredDeliveryPricingPolicy` 为确定性、可替换 policy。

实际生效 inputs：

- global default customer fee；
- global default rider base；
- merchantId 对应的 SUPER_ADMIN override；
- totalQuantity（额外件数增量）。

已记录但 reserved/not active：

- merchant base/reference price；
- merchant category；
- pickup region；
- destination region；
- suggested foodType。

这些 reserved inputs 写入 snapshot，但不影响当前金额，特别是 AI foodType 不影响钱。配置校验禁止 default、quantity increment 或 merchant override 产生负基础贡献，并校验 merchant UUID/重复项。

Pricing config 复用版本化 BusinessConfig + Audit；OPERATOR 写入 403，SUPER_ADMIN 可写。Seed 300/200/每额外件 20 等均明确是 DEMO，不是永久商业参数。

## 11. 角色资金隔离

- Customer：item subtotal、自己的 customer fee/tip/refund；看不到 rider base、rescue、subsidy、spread。
- Merchant：自己的 base/reference、rescue current/version/history；看不到 customer fee/tip、platform subsidy。
- Rider：订单池只看 guaranteed payout 和履约决策事实，不看资金来源/spread。
- SUPER_ADMIN：完整 pricing、legacy audit、rescue/tip/subsidy/snapshot。

完整 serialized response 有负向测试。

## 12. Migration、Docker 与验证

新增 migration：

1. `20260926000400_capacity_pool_pricing`
2. `20260926000500_guaranteed_payout_snapshot`
3. `20260927000100_drop_item_classification_backfill_defaults`

最终结果：

- 当前数据库：14 migrations，up to date。
- 空库：14 migrations 全量成功。
- 空库 Seed：连续两次成功。
- Prisma migration/schema drift：`No difference detected.`
- typecheck：通过。
- unit：9 files / 24 tests 通过。
- PostgreSQL integration：3 files / 54 tests 通过。
- build：通过。
- OpenAPI：capacity、rescue compatibility 和既有权限路径在集成测试中验证。

Docker：本轮首次 preflight 为 running，ServerVersion `29.8.0`。最终回归前 engine 曾停止，导致 Prisma `Schema engine error`；按 AGENTS.md 仅执行一次安全 `docker desktop start`，随后 postgres healthy、全部测试通过。未 factory reset、clean/purge、删除 volume 或数据目录。

临时 verify/shadow 数据库仅为本轮创建，验证后删除；项目数据库和 volume 未删除。

## 13. 权限

- ORDER_POLICY（含 global capacity / pricing defaults / merchant overrides）：SUPER_ADMIN 写；OPERATOR 403。
- 单 rider capacity override：SUPER_ADMIN；OPERATOR 403；Rider 只读自己的 capacity/events。
- Merchant rescue：仅订单所属 Merchant，未 claim/未过期/只增。
- Platform subsidy：SUPER_ADMIN，继续受预算策略限制。
- Item classifier：无高风险写权限，仅订单创建时保存建议。

## 14. Intentional omissions / unresolved

- 没有真实 Jev runtime integration。
- 没有 category/region/foodType 金额矩阵；这些输入仅 snapshot/reserved。
- 没有成熟动态定价、统计优化或机器学习定价。
- 没有 5 之后自动升级或异常自动降容量。
- 没有路线规划、导航或自动拼单。
- 没有真实支付、提现或退款网关。
- 用户配送费、rider base、merchant/category/region 正式数值和长期算法仍待真实运营数据确认。
- 商品佣金、支付通道费、税费的最终口径未决定。

本轮完成后停止，未自行进入下一阶段。
