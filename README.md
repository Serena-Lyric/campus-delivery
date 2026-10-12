# campus-delivery

campus-delivery 是面向校园半封闭场景的即时配送平台工程。当前版本覆盖订单池、市场报价、履约证据、商家风险灰度、骑手未取餐容错、异常订单池、赔付资金事实和管理员分权。

## 当前阶段

本阶段仍是模块化单体 REST API。第四轮报价及第五轮财务安全基础已有完成记录；商家基础报价仅作定价参考、商品佣金可配置且默认0%均已确认。代码能力和当前应用配置不同，历史报告只说明其记录的提交与验证，不代表所有产品规则已上线。

首期商品款直付商家、配送费独立支付为**暂定且尚未实现**的设计；平台统一商品款收取及商家48小时冷却保留为未来目标。现有后端仍为开发内账模拟，无真实支付/提现，不能把商家直收商品款显示为平台可冻结资金。当前产品依据见 [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md) 第1B节与状态导航，财务边界见 [FINANCE_OPERATIONS_DECISIONS.md](FINANCE_OPERATIONS_DECISIONS.md)。

文档维护按 [AGENTS.md](AGENTS.md) 的任务索引读取相关章节；旧计划/已完成任务不自动启动下一轮。报价实现与验证见 [第四轮报告](CODEX_REPORT_2026-10-11_DUAL_SIDE_PRICING.md)，财务实现与验证见 [第五轮报告](CODEX_REPORT_2026-10-11_FINANCE_SAFEGUARDS.md)。第六轮为文档精简（`d450d6d`）；第七轮手动营业与商品三态报告见 [第七轮归档报告](CODEX_REPORT_2026-10-12_MERCHANT_OPERATIONS.md)；第八轮商品每日恢复的测试报告见 [第八轮归档报告](CODEX_REPORT_2026-10-12_DAILY_PRODUCT_RESTORE.md)；当前第九轮任务见 [CODEX_TASK.md](CODEX_TASK.md)。

## 商家营业与商品菜单（2026-10-12 手动 API 已实现）

本店 OWNER 使用 `GET/PUT /merchant/operating-status` 手动开关接单，PUT 提交 `isOpen / expectedVersion / reason`。公共目录返回 `acceptingOrders / operatingStatusLabel`，休息时继续展示菜单并标「休息中」，预览与创建在数据库锁内拒单；平台 HIDDEN/SUSPENDED 仍不可见。关店不取消旧单、不改资金或履约事实。

OWNER 使用 `GET/PUT /merchant/daily-product-restore` 读取/修改本店每日商品恢复偏好，PUT 为 `enabled / expectedVersion / reason`，默认关闭。GET 提供平台有效时刻、校园时区、配置版本和来源：未配置时 `04:00 / version:0 / SYSTEM_DEFAULT`。旧 SUPER_ADMIN 可通过 `PUT /admin/business-configs/PRODUCT_DAILY_RESTORE` 设置 `{payload:{time:"HH:mm"},expectedVersion,reason}`，版本化并审计；不授予 Root 或资金权限。接口纳入运行时 OpenAPI；无完整商家/管理 UI。

`ENABLE_BACKGROUND_JOBS=true` 时现有后台循环按 `campusTimeZone`（默认 Asia/Shanghai）执行每日恢复；默认关闭时 API 请求也不补执行。按校园本地日历日期、当日配置时刻到点后首次成功 sweep 执行，一店一天最多一次；晚开启允许当日补执行，遗漏的历史日期不回补。已执行后改时刻或关闭再开启都不重复执行，时钟/时区回退也不处理早于最近成功日的日期。配置锁→商家锁→商品有序行锁、逐商品版本/status 条件和整批事务保证多实例、失败回滚及人工操作安全；完成记录也覆盖零商品变更的日期。

`MerchantDailyRestoreRun` 记录配置/偏好版本、日期、时区、计划时刻、实际触发时间及 SYSTEM/AUTO_DAILY 来源；`ProductDailyRestoreAudit` 记录自动状态和商品新版本，不伪造 User，也不修改既有人工作业审计。仅 SOLD_OUT→ON_SALE；OFF_SHELF/已在售不变，不开店、不加库存、不改订单/定价/履约/财务。首次执行前人工售罄可能被本次恢复覆盖；首次执行后的人工售罄保留到下次日期或手动恢复。

`PUT /merchant/catalog/products/:id/sale-status` 接收 `saleStatus / expectedVersion / reason`：`ON_SALE` 展示可买，`SOLD_OUT` 展示「已售罄」不可买，`OFF_SHELF` 隐藏不可买。公共商品 `purchasable` 还依赖商家营业。状态修改不改价格/风险类别；当前版本无变化返回 `changed:false`，陈旧版本409，非法/额外字段400；实际变更与审计同事务提交。商家自己的 catalog 管理三态。

旧 `isAvailable` 保留为可售投影：仅在售为 true；旧 false 迁移为下架。旧布尔创建/完整编辑端点仍可用，SOLD_OUT 的相同 false 完整编辑保留售罄；需要明确区分售罄/下架时用状态接口。数据库 trigger 与约束维护一致性，重复 Seed 不重开商家、不恢复商品状态。迁移含 PostgreSQL 原生触发器，升级应使用 `prisma migrate deploy`；只做 `db push` 不足以安装兼容逻辑。

当前交付是 API、后台执行与测试，没有完整小程序或商家前端标签。第九轮每日营业确认任务已编排、尚未实现；定时关店、数量库存、真实支付均未实现；没有预留或开放不安全库存开关。详见 [经营专题](MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md) 和本轮 [CODEX_REPORT.md](CODEX_REPORT.md)。

每日自动恢复已由第八轮实现后端运行路径，应用迁移保留原营业/商品/订单事实且所有旧商家默认未启用；后台开关也默认关闭，API 能力不等于部署时已运行或完整 UI 上线。数量库存和支付预留另行开发，详见产品第1D节及经营专题第6/7节。

## 第九轮计划：每日营业确认（产品确认，未开发）

商家可选“每日营业确认”，默认关闭，启用从下一营业日生效、关闭立即生效。平台统一营业日切换时刻初始校园当地04:00，管理配置与商品每日恢复的04:00独立；未来预留商家自定义切换点。确认今日营业、手动开始营业都完成当日确认并打开接单；不确认则**只暂停新单**，不修改人工`isOpen`、不影响已有订单。门禁必须在客户目录和服务端结账事务即时校验，不能依赖后台调度。详见 [主产品第1E节](PRODUCT_DECISIONS.md) / [经营专题第8节](MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md) / [CODEX_TASK.md](CODEX_TASK.md)。

## 2026-10-10 履约与管理员能力边界

- 易损商品如蛋糕、圣代的取餐证据规则：易损商品相关价值 > ¥15 建议照片，> ¥50 强制有效照片或审计化例外；阈值由新的一级管理员/root 控制台配置。**金额按同订单全部已核定易损商品行小计之和**（两份 ¥30 圣代计 ¥60、强制），优惠分摊、无法拍照时的替代凭证及放行权限仍待确认，详情见 `FRAGILE_PICKUP_EVIDENCE_DECISIONS.md`。照片仅证明取餐时可见状态，不自动判定骑手无责。
- 管理员产品方向是 **不可通过普通后台任免/删除/撤销的特殊 Root 身份 + 可扩展运营层级**；首版普通管理员为一级运营管理、二级（暂定客服），未来可增加三级、四级或中间层，业务权限由 Root 受控下放。Root 可参与但通常不上线，作为最后应急权能；不能将密码、永久令牌硬编码于程序。详见 `ADMIN_ROLE_DECISIONS.md` 和主产品决策。
- **当前运行时**：商品标准履约分类与商家货架独立，核心易损金额聚合及创建时冻结的取证等级已执行；普通取餐改为商家确认，骑手可立即提出交接异议，经专用人工核实纠正。个人商家黑名单只过滤本人未来订单并限制 claim。媒体仍为 Mock reference，无法取证上报不豁免强制照片。
- **管理员迁移尚未实施**：`AdminLevel` 仍为 `OPERATOR/SUPER_ADMIN`；取证阈值临时由旧 SUPER_ADMIN 修改。Root、可扩展等级与认证、真实支付、商家惩戒仍待后续任务。

## 技术栈

- Node.js 20+、TypeScript 5、pnpm workspace
- Fastify 5、OpenAPI
- Prisma 6、PostgreSQL 16
- Vitest、Docker Compose、Pino

## 目录结构

    apps/api/
      prisma/                 数据模型、migration、Seed
      src/auth/               开发认证
      src/catalog/            商家和商品
      src/item-classifier/    物品粗分类 adapter 与安全 fallback
      src/orders/             订单、冷静期、短码
      src/delivery/           订单池、持单限制、履约
      src/evidence/           Evidence 和媒体抽象
      src/exceptions/         结构化异常
      src/exception-cases/    异常共享池、领取、处理与审计
      src/compensation/       赔付义务、资金 reservation 与平台垫付
      src/riders/             骑手取消、暂停、冷却与管理员 override
      src/merchant-risk/      商家履约指标、风险结论和曝光策略
      src/verification/       一次性码
      src/timeline/           角色化时间线
      src/settlements/        骑手待结算
      src/pricing/            价格视图、资金变更与可配置定价 policy
      tests/                  单元和 PostgreSQL 集成测试
    docs/superpowers/specs/   设计规范
    CODEX_REPORT.md           本轮交接报告

## 本地启动

    pnpm install
    Copy-Item apps/api/.env.example apps/api/.env
    docker compose up -d --wait postgres
    pnpm db:generate
    pnpm db:migrate
    pnpm db:seed
    pnpm dev

- 健康检查：http://localhost:3000/health
- OpenAPI UI：http://localhost:3000/docs
- OpenAPI JSON：http://localhost:3000/docs/json

开发认证通过 x-user-id 选择 Seed 用户。生产环境不能启用 ENABLE_DEV_AUTH。

## 配置

技术配置位于 apps/api/.env：

- ENABLE_BACKGROUND_JOBS：是否运行冷静期、接单池到期、结算和商品每日恢复扫描；省略/示例默认为 false，开发演示需要扫描时显式设为 true。已有部署的显式 true 不会被默认值修改覆盖。
- BACKGROUND_SWEEP_INTERVAL_MS：扫描频率。
- CAMPUS_TIME_ZONE：短订单码日期分区时区，国内校园默认 Asia/Shanghai。

版本化 BusinessConfig 保存演示业务参数：

- coolingOffSeconds：Seed 为 60 秒。
- riderSettlementPendingSeconds：Seed 为 5 天。
- platformMaxConcurrentOrdersPerRider：第一版全局绝对上限 Seed 为 10。
- deliveryPricingDefaultCustomerFeeMinor / deliveryPricingDefaultRiderBasePayoutMinor：用户基础配送费与骑手基础保证收益独立 DEMO 默认值。
- deliveryPricingAdditionalItemCustomerFeeMinor / deliveryPricingAdditionalItemRiderPayoutMinor：按额外件数增加的第一版规则参数。
- deliveryPricingMerchantOverrides：SUPER_ADMIN 管理的商家级绝对覆盖；仍受非负基础价差校验。
- platformCommissionBps：已确认的可配置商品佣金，默认0%，版本变更只影响新订单；正式非零费率仍待确认。旧“仅hook、规则未确认”的描述已被2026-10-11产品确认取代。
- verificationCodeTtlSeconds：Seed 为 10 分钟。
- customerUnreachableWaitSeconds：只预留，不用于自动判责。
- riderTipWindowSeconds：Seed 演示为 86400 秒，创建订单时快照到 tipDeadline。
- merchantRepriceCooldownSeconds：Seed 演示为 15 秒。
- orderClaimWindowSeconds：Seed 演示为 2400 秒。
- defaultNaturalClaimBaselineSeconds：自然接单样本不足时的演示基线。
- finalUserWarningSecondsBeforeClaimDeadline：Seed 演示为截止前 300 秒。
- platformSubsidyStepMinor / platformSubsidyMaxStepMinor：演示补贴步长和单次上限。
- platformSubsidyMaxPerOrderMinor：演示单订单累计补贴上限。
- platformSubsidyMinIntervalSeconds：演示补贴最短间隔。
- merchantSubsidyBudgetMaxUsageBpsPerOrder：单订单商家风险预算占用比例上限。
- merchantRiskWindowOrderCount / merchantRiskMinimumSampleSize：履约统计窗口和最低样本量。
- merchantTrialExposureBps：TRIAL 商家的稳定用户灰度比例；Seed 演示值不是长期规则。
- merchantExposureRecoveryWindowOrderCount / merchantExposureRecoveryMinimumSampleSize：独立恢复观察窗口与最低样本。
- slowFulfillmentThresholdSeconds：独立时间风险阈值。
- completionRiskElevatedThresholdBps / completionRiskHighThresholdBps：可观察完成风险阈值。
- exposure*ThresholdBps：曝光状态进入与恢复阈值；恢复阈值与进入阈值分离以避免抖动。
- subsidyDependencyThresholdBps / subsidyRescueThresholdBps：补贴依赖和救援效果事实阈值，不直接改变曝光。
- riderDailyFreeCancelLimit：单日未取餐无责取消/警告阈值，Seed 为 2。
- riderCancellationRollingWindowDays：滚动计数窗口，Seed 为 7 天。
- riderCancellationCooldownThreshold / riderWarningCooldownThreshold：累计取消与 warning 两条冷却路径阈值。
- riderCancellationCooldownSeconds / riderWarningCooldownSeconds：两条冷却路径时长，Seed 为 2 天。
- unattendedDeliveryMethods：允许无人接触投递的方式。
- handoffCodeDeliveryMethods：正常情况下要求交付码的方式。

这些数字都是开发演示配置，不是最终商业规则。

## Seed

| 身份 | x-user-id |
|---|---|
| 用户 | 00000000-0000-4000-8000-000000000001 |
| 商家 | 00000000-0000-4000-8000-000000000002 |
| 骑手 A | 00000000-0000-4000-8000-000000000003 |
| 骑手 B | 00000000-0000-4000-8000-000000000004 |
| 超级管理员 | 00000000-0000-4000-8000-000000000005 |
| 普通管理员 | 00000000-0000-4000-8000-000000000006 |

Seed 包含正常订单、冷静期订单、等待骑手订单、配送中订单、需要交付码订单、用户失联订单、现场 Evidence 订单，以及有争议且骑手结算为 HELD 的订单。

需要交付码的 Seed 演示订单使用开发码 246810。该值只用于本地演示。

## 订单生命周期

    CREATED
      → MERCHANT_PENDING
      → MERCHANT_CONFIRMED
      → READY_FOR_RIDER
      → CLAIMED
      → PICKED_UP
      → DELIVERED

    READY_FOR_RIDER
      → NO_RIDER_ACCEPTED

CREATED 表示冷静期。后台处理器在 coolingOffEndsAt 到期后原子推进到 MERCHANT_PENDING。用户无责取消只允许在 CREATED 且截止时间尚未到达时执行。取消和自动推进使用互斥条件更新。

商家确认后订单立即进入骑手池并固定 firstPublishedAt 与 claimDeadline。商家“备餐中/可取”只是自报市场信号，真实商家到骑手交接以 pickup 为准。

接单即形成履约承诺，不提供无限制 abandon。骑手仅可在实际取餐前使用有限无责取消；订单回到原池但原 firstPublishedAt、claimDeadline 和资金事实不刷新。到达原 claimDeadline 时仍无人承接则进入 NO_RIDER_ACCEPTED。

## 短订单码

每笔订单保存 UUID 和四位人工短码。短码按校园日期建立唯一约束，字符集排除 0/O/1/I 等易混字符。短码用于报号和人工核对，不能替代 UUID。

## 交付方式与验证

交付方式：DESIGNATED_POINT、DOOR、FACE_TO_FACE。用户只能选择商家和目的地点共同支持的方式。

交付验证为 DELIVERY_PHOTO 或 HANDOFF_CODE。取餐验证为 CONFIRMATION、PHOTO 或 PICKUP_CODE。

一次性码只保存加盐哈希。明文只在签发响应中返回，重新签发会使旧码失效。成功验证自动创建代码验证 Evidence。

取餐由本单商家针对 activeAssignmentId、pickupProtocol.revision、requestKey 确认，普通骑手取餐 POST 已弃用并返回 409。PICKUP_CODE 由系统签发给当前骑手，商家可仅输入六位数字完成核验（codeId 可选）；码绑定本次承接和交接 revision。工程默认有效期取现有配置与 10 分钟较小值，同一承接 10 分钟内最多 5 次签发和 5 次错误尝试。PHOTO 及核心易损 REQUIRED 照片要求继续执行；原金额快照不因商家确认改写。

骑手在商家确认后可对本次 handoff 提交未实际取餐争议，未决及 INCONCLUSIVE 会阻止正常送达和资金处分。获分派案件的管理员核实未交货时，通过专用版本化审计更正恢复 CLAIMED；若同时有漏报核心易损声明，则原子进入既有 RISK_REVIEW 和免普通取消的解除承接路径，等待商家更正并明确重新发布。核实已交货则继续配送，不自动建立赔偿债务。普通状态机不允许 PICKED_UP 自由回退。原接单截止时间始终保留，截止前已合法承接者可以在截止后正常交接。

## Evidence

Evidence 独立保存订单、操作者、角色、类型、订单阶段、媒体引用、备注和结构化元数据。

照片使用 MockMediaStorage 生成 mock 引用。当前后端不存储真实图片，也不能证明图片一定来自现场相机。微信小程序相机和对象存储留待后续实现。

Evidence 只提供争议事实，不自动代表任何一方有责。普通低风险订单的照片默认可选；风险订单、配置明确要求照片或用户失联无人接触投递时才强制。

## 异常与用户失联

结构化异常进一步区分轻微损坏/延迟、严重餐损、餐品丢失、投诉争议和其他待审。ExceptionEvent 保存事实，ExceptionCase 保存运营处理状态，两者不混用。

普通固定地址/校园位置节点订单正常情况下不要求骑手先联系用户或等待本人出现；骑手按订单地址/位置快照正确送达即完成正常履约。地址填写/选择错误属于用户侧责任，额外转送由用户与骑手自愿协商，骑手拒绝不构成履约失败。仅必须本人交接、强制交付码等特殊模式下的失联等待与最终处理仍待确定。

`WRONG_ADDRESS` 只记录结构化事实，不自动创建共享管理员 case 或改变订单状态；后续如产生真实投诉，使用 `DELIVERY_DISPUTE` 进入人工处理。严重餐损/丢失只能由责任骑手在取餐后通过 dedicated route 上报；正常继续履约只认可用户明确接受补餐形成的 `REMAKE_AND_CONTINUE`，不能由通用 admin continue 代替。

允许无人接触投递时，用户失联订单可在骑手提交 DELIVERY_PHOTO 后完成。不允许无人接触投递时，订单进入 EXCEPTION。系统不自动判责或扣款。

DELIVERY_DISPUTE 会把相关 RiderSettlement 更新为 HELD，但不会扣除历史余额。

严重餐损/丢失后，骑手可提出补餐继续；用户明确接受后才能恢复送达。用户拒绝后 case 回到共享池。骑手主动赔付或管理员确认标准退款时，订单进入 EXCEPTION，订单本体退款事实立即记录，不等待骑手资金补足；RiderTip 不被自动清零或重算。

## 骑手未取餐取消与限制

每次未取餐取消保存不可变事件、结构化原因、校园自然日、当日计数、7 天计数和 warning 事实。单日第 2 次暂停当天新 claim；7 天累计 4 次或累计 2 次 warning 分别进入配置化冷却。暂停/冷却只阻止新 claim，不取消、不回池、不改变骑手已经持有的订单；已持订单继续按原履约或异常流程处理。

限制状态保存类型、来源、开始/结束、状态和审计。只有 SUPER_ADMIN 可以创建、提前解除或调整跨订单限制；OPERATOR 无权修改。

## 配送定价、救单与价格快照

配送价格区分商家基础参考报价B、用户基础配送费、骑手基础收益、商家真实救单出资、用户红包、平台补贴、骑手保证收益和平台配送贡献。2026-10-10已确认B不出资、不从商家商品结算等额扣除；用户承担第一版基础配送费。

为保护旧配置，未配置 `DELIVERY_PRICING_POLICY` 时继续旧 `ORDER_POLICY` 定额/商家override/数量规则。新模式需旧SUPER_ADMIN（临时代行一级运营配置权限，不是Root）通过 `PUT /admin/business-configs/DELIVERY_PRICING_POLICY` 明确启用，提交expectedVersion（首次0）与理由。payload包含 `mode: REFERENCE_BPS`、独立 `customerMarkupBps` / `riderDeductionBps`（0..10000）、`rounding: FLOOR_ADJUSTMENTS`、`maxMerchantBaseMinor`（1..1073741823分安全上限）。比例没有默认；演示20%不是正式费率。也可显式配置 `mode: LEGACY_ORDER_POLICY` 回退，仅影响新订单。

新模式 `customer=B+floor(B×markupBps/10000)`，`riderBase=B-floor(B×deductionBps/10000)`，不叠加旧定额/override/数量收费，不制造最低价或最低收益。两侧金额、B、比例、舍入、基础价差和两种策略版本保存在内部订单/claim快照。商家类别、区域、AI分类与数量在新模式只记录、不决定金额；长期舍入/费率/限额仍待确认。

商家通过 `GET/PUT /merchant/base-delivery-quote` 读写自己的未来B，使用报价expectedVersion和非空理由；记录旧/新价、操作人、时间、版本。安全限额可由新策略配置，旧模式报价编辑采用100000分工程上限（不是商业推荐价）。提示“仅对后续订单生效，已付款订单不变”，不UPDATE既有订单。

用户先 `POST /orders/price-preview` 获取仅含自己承担金额的预览与quoteToken，再向 `POST /orders` 提交 `expectedQuoteToken`。新模式必须确认；旧模式选填但一旦提供就核验。商家报价、策略、商品/数量、目的地或交付方式变化将返回409，用户需重新预览/确认。订单创建仅为 `CREATED` 冷静期及开发内账报价合同，不等于微信付款；没有PAID或真实支付回调。配置/报价编辑与下单通过事务锁防止并发快照混用。

未接单前商家可以增加真实 rescue contribution；只允许增加，增量 100% 进入骑手保证收益并从商家结算扣除，平台配送贡献不扩大。兼容 endpoint `/delivery-quote` 已在 OpenAPI 标记 `newRescueContributionMinor` 语义。

骑手接单事务原子冻结 customer fee、rider base、merchant rescue、tip、subsidy、guaranteed payout、platform contribution、policy version 和 inputs snapshot。角色价格视图彼此隔离：用户只看自己的费用/tip，商家看到自己的基础参考与rescue/history，骑手只看保证收益，管理员按现有权限查看后台账务。救单、红包、补贴均不重算基础双侧价差；补贴降低配送贡献并占用预算。

新增迁移 `20261011000100_merchant_base_delivery_quote` 仅添加商家报价版本（旧库初始0）与独立审计表，无历史财务或配置重解释。Seed保留已有报价/版本与ORDER_POLICY；已有演示订单及关联财务/承接事实不再被重写，新双侧策略不会由Seed启用。Seed仍是本地演示初始化工具，会维护其他演示资料，不作为生产运维入口。

商品佣金已确认可配置、默认0%，独立于配送双侧价差；非零变更须版本校验与审计，仅影响新订单，不能追溯历史快照或结算。默认 `platformCommissionBps=0` 时正常创建/完成订单不会因此减少 merchant payable，也不会生成商品 commission revenue。正式非零费率与首期直付模式实际收取/结算仍待确认；此前“正式抽成规则未决定”仅作历史说明。

## 用户骑手激励

用户激励与商家初始配送金额、商家救单出资、平台补贴独立记账。操作窗口从订单创建起 24 小时，并在订单创建时保存 tipDeadline；截止判断由服务端执行。接单前用户可以增加、减少或撤回；接单后只能追加。正常送达后只要仍在窗口内仍可追加，新增部分更新当前责任骑手的收益和结算金额，100% 归骑手，不增加平台收入。

无人承接失败时，尚未锁定的用户骑手激励记录为全额退款。

## 平台逐步补贴

平台不再使用 targetRiderPayout 自动补足，也不在商家 ready 时自动补贴。补贴只能通过受控服务逐步追加，每次记录旧补贴、增量、新总额、策略版本、时间和触发原因。

服务端同时限制单次步长、单次绝对上限、单订单累计上限、最短间隔和商家风险预算占用比例。补贴资格、时点和增量是三个独立策略接口。

自然接单样本只包含补贴介入前接单的 DeliveryAssignment；补贴后接单记录为 SUBSIDIZED，不进入自然接单基线。

补贴服务只更新 subsidyUsageBps 这一事实指标，不再直接修改 Merchant.exposureState。每增加 X 补贴，骑手保证收益增加 X，平台配送贡献减少 X；预算/步长/间隔限制保持不变。

## 商家履约风险与曝光

Merchant fulfillment metrics 使用相互独立的终态、接单、补贴终态和恢复样本查询。完成率只使用 DELIVERED 与 NO_RIDER_ACCEPTED；补贴救援率分母只包含已到可判断终态的 subsidized claim，进行中订单不会算失败。

timeRisk 与 completionRisk 独立返回。曝光策略实际使用完成/无人承接风险和“高补贴依赖 + 低救援率”；SLOW 和未归责 exceptionCounts 只作事实参考。恢复使用独立 window/minimum sample。TRIAL 通过 merchantId + customerId 稳定 hash 灰度，种子商家可显式覆盖为 100%；HIDDEN/SUSPENDED 始终不可见。

角色信息隔离：用户目录只看到简化风险提示；商家看到自己的履约事实摘要，不看到平台内部补贴策略；管理员看到完整指标、补贴事实和曝光决策历史。

## 管理员业务配置

只有 SUPER_ADMIN 可读取/更新全局版本化 BusinessConfig、执行平台补贴、调整曝光策略、管理员级别和骑手跨订单限制。OPERATOR 可领取异常 case、查看必要事实、转交/释放/升级并完成系统定义的标准处理，但不能绕过 ledger 任意输入扣款。

## 异常订单池与赔付资金

异常池使用 `ExceptionCase.version` 与原子条件更新保证同一 case 只有一个有效处理人。claim、release、transfer、takeover、escalate 和 resolve 都记录不可变 action。退款/冻结使用 case row lock、唯一 idempotency key、唯一 obligation 和事务，重试不会重复执行。

Dedicated severe report 与正常 deliver 使用一致的 Order → DeliveryTask 行锁顺序；并发时要么 severe case 先提交并阻止送达，要么 deliver 先完成且迟到的 severe report 因阶段变化被拒绝。Customer remake reject 使用独立 `REMAKE_REJECTED` audit action，不冒充管理员释放处理权。

赔付义务分别记录本单 settlement reservation、其他未提现 settlement reservation、平台垫付、用户退款和 outstanding。`RiderSettlement.reservedMinor` 支持部分冻结；并发事务按固定顺序锁定结算行，同一余额不能重复占用。真实支付、提现、未来收入自动抵扣和长期追偿尚未实现；因此 public API 当前拒绝非零 `voluntaryPaymentMinor`，不会把骑手输入的数字记作已付款。

`release-compensation` 只解除已有 settlement reservation。若用户退款已经发生，解冻后由平台继续垫付的金额会同时增加 `platformAdvancedMinor` 与 `outstandingMinor`，义务保持未结；release 不等于 write-off 或债务核销。

`DELIVERY_DISPUTE` terminal resolve 会在同一事务内同步 linked ExceptionEvent，并仅在同订单已无其他 unresolved dispute 时解除 `holdReason=DELIVERY_DISPUTE` 的 RiderSettlement hold：未到期回 PENDING、已到期回 AVAILABLE，`reservedMinor` 原样保留。后台 settlement sweep 可幂等修复历史遗留的 dispute-only hold，但不触碰其他 hold reason。

异常分类提供类型化 `ExceptionClassifier`、确定性 fallback 和 manual fallback。adapter 抛错时 case 仍创建，并明确记录 `MANUAL_FALLBACK`；确定性默认只建议 `OPERATOR_POOL`，异常类型本身不会自动升级超管。分类来源/版本/置信度与管理员最终结论分开保存；当前没有真实 Jev 网络调用，AI 不执行资金或责任动作。

## 骑手容量与订单池信息

新骑手个人容量按校园自然日经历 1→2→5：未正常完成首单为 1；首单 DELIVERED 后同日为 2；下一校园自然日起为 5。5 后不自动升级。SUPER_ADMIN 可设置个人 override；有效容量始终为 `min(personal, globalAbsolute)`，第一版全局 Seed 为 10。

claim 事务锁定 Rider 后计算阶段/override/global cap 并统计 CLAIMED/PICKED_UP，两个并发请求竞争最后一个槽位只能成功一个。调低额度不破坏已持订单。骑手可通过 `/riders/me/capacity` 查看阶段、有效额度和升级/override 事件。

可接订单 DTO 只返回骑手决策所需事实：保证收益、稳定 merchant/location id、订单创建时的商家名称、取餐地点/区域与目的地 label/区域快照、foodType、handlingTags、总数量和行项目数；不混入可变的 live 商家/地点名称，也不返回 customer、平台价差或资金来源拆分。平台不据此规划路线或推荐拼单。

物品分类保存原始商品名、商家原始分类与 suggestedFoodType/handlingTags/source/version/confidence。潜在远程分类调用在订单写事务之前执行，事务内会重新校验商品事实，变化时安全拒绝重试。当前只有 deterministic/manual fallback，没有真实 Jev 网络调用；分类失败回退 UNKNOWN 且不阻塞订单，也不影响钱、容量、责任或曝光。

## Migration 约束

`20260926000400_capacity_pool_pricing` 对开发/demo 历史 settlement 与 BusinessConfig 做过 semantic rewrite。项目尚未进入真实生产账务，因此本轮不为 demo 历史构造复杂反迁移；该 migration 明确只属于 pre-production 语义迁移，不是未来生产财务 migration 模板。真实生产后，已 FINALIZED 财务事实和已生效历史配置必须通过保留审计历史的版本化 correction/event/明确迁移策略修正，不能由普通 migration 静默原地重写。

`20260927000300_order_pickup_merchant_snapshot` 为历史缺失的商家名称快照使用当前 `Merchant.name` 做 best-effort pre-production backfill；它只能提供兼容近似，不能证明历史订单创建时的真实店名，也不是生产审计迁移范式。

## 待结算资金

送达后资金状态为 PENDING，等待期结束且不存在未解决争议时变为 AVAILABLE，争议可使其变为 HELD。

当前没有真实提现、支付网关、无限负余额或历史余额自动追偿；只有关联明确 exception case / compensation obligation 的未提现资金 reservation。

## API

| 方法 | 路径 | 主要角色 | 用途 |
|---|---|---|---|
| GET | /health | 公开 | 健康检查 |
| GET | /campus-locations | 已登录 | 校园地点及交付方式 |
| GET | /merchants | 已登录 | 商家及交付方式 |
| GET | /merchants/:merchantId/products | 已登录 | 商品目录 |
| GET | /merchant/fulfillment-risk | 商家 | 自身履约事实与风险摘要 |
| POST | /orders | 用户 | 创建冷静期订单 |
| GET | /orders/my | 用户 | 历史订单 |
| GET | /orders/:orderId | 订单相关方 | 订单详情 |
| POST | /orders/:orderId/cancel | 用户 | 冷静期内取消 |
| GET | /orders/:orderId/timeline | 订单相关方 | 结构化时间线 |
| POST | /orders/:orderId/evidence | 商家/骑手/管理员 | 创建照片 Evidence |
| POST | /orders/:orderId/exceptions | 订单相关方 | 报告结构化异常 |
| POST | /orders/:orderId/delivery-code | 用户 | 签发交付码 |
| POST | /orders/:orderId/pickup-code | 商家 | 已弃用，409；改用骑手签发接口 |
| GET | /orders/:orderId/pricing | 订单相关方 | 角色隔离价格视图 |
| POST | /orders/price-preview | 用户 | 只读价格预览与确认标识，不创建支付 |
| GET / PUT | /merchant/base-delivery-quote | 商家 | 自有未来基础参考价、CAS版本与审计 |
| POST | /orders/:orderId/rider-tip-adjustments | 用户 | 调整或追加骑手激励 |
| POST | /merchant/orders/:orderId/confirm | 商家 | 确认并立即发布到骑手池 |
| PATCH | /merchant/orders/:orderId/delivery-quote | 商家 | 未接单前增加真实救单出资（兼容路径名） |
| POST | /merchant/orders/:orderId/ready | 商家 | 更新可取自报信号 |
| GET | /delivery-tasks/available | 骑手 | 查看公开任务 |
| GET | /delivery-tasks/mine | 骑手 | 查看参与过的任务 |
| POST | /delivery-tasks/:taskId/claim | 骑手 | 原子抢单 |
| POST | /delivery-tasks/:taskId/pre-pickup-cancel | 骑手 | 取餐前有限无责取消并回原池 |
| POST | /delivery-tasks/:taskId/verify-pickup-code | 骑手 | 已弃用，409；由商家确认时核验 |
| POST | /delivery-tasks/:taskId/pick-up | 骑手 | 已弃用，409；由商家确认交接 |
| POST | /delivery-tasks/:taskId/pickup-code | 当前承接骑手 | 签发本人可见的绑定数字码 |
| POST | /merchant/orders/:orderId/confirm-rider-pickup | 本单商家 | 按当前承接及 revision 确认取餐 |
| POST | /delivery-tasks/:taskId/dispute-pickup | 当前承接骑手 | 否认实物交接，可附漏报易损声明 |
| POST | /merchant/orders/:orderId/acknowledge-pickup-mistake | 本单商家 | 留痕确认误点、实物仍在店 |
| POST | /admin/pickup-disputes/:disputeId/resolve | 获分派管理员 | 核实交接、受控更正或继续等待 |
| GET | /rider/blocked-merchants | 骑手 | 本人的屏蔽商家 |
| PUT / DELETE | /rider/blocked-merchants/:merchantId | 骑手 | 幂等屏蔽或解除屏蔽 |
| POST | /delivery-tasks/:taskId/deliver | 骑手 | 验证并送达 |
| GET | /riders/me/settlements | 骑手 | 查看待结算资金 |
| GET | /riders/me/restrictions | 骑手 | 查看取消计数、warning、暂停和冷却 |
| GET | /riders/me/capacity | 骑手 | 查看 1→2→5 阶段、有效容量和通知 |
| POST | /rider/orders/:orderId/severe-exception | 骑手 | 报告严重餐损或丢失 |
| POST | /exception-cases/:caseId/remake-proposal | 骑手 | 提出补餐继续 |
| POST | /exception-cases/:caseId/voluntary-compensation | 骑手 | 主动选择原价赔付 |
| GET | /riders/me/compensations | 骑手 | 查看自身赔付/冻结摘要 |
| POST | /exception-cases/:caseId/remake-response | 用户 | 接受或拒绝补餐继续 |
| GET | /orders/:orderId/exception-cases | 订单相关方 | 角色隔离异常状态/退款视图 |
| GET | /admin/exception-cases | OPERATOR/SUPER_ADMIN | 浏览/筛选异常池 |
| GET | /admin/exception-cases/:caseId | OPERATOR/SUPER_ADMIN | 查看 case 所需证据、时间线与订单资金事实 |
| POST | /admin/exception-cases/:caseId/claim | OPERATOR/SUPER_ADMIN | CAS 原子领取 |
| POST | /admin/exception-cases/:caseId/release | 当前处理人/SUPER_ADMIN | 释放回共享池 |
| POST | /admin/exception-cases/:caseId/transfer | 当前处理人/SUPER_ADMIN | 转交处理人 |
| POST | /admin/exception-cases/:caseId/escalate | 当前处理人/SUPER_ADMIN | 升级复杂案件 |
| POST | /admin/exception-cases/:caseId/resolve | 当前处理人/SUPER_ADMIN | 标准人工判断或退款结束 |
| POST | /admin/exception-cases/:caseId/takeover | SUPER_ADMIN | 接管/重新分配 case |
| POST | /admin/exception-cases/:caseId/release-compensation | 当前处理人/SUPER_ADMIN | 幂等释放 reservation |
| POST | /admin/orders/:orderId/exception | OPERATOR/SUPER_ADMIN | 标记订单异常并创建 case |
| POST | /admin/orders/:orderId/platform-subsidies | SUPER_ADMIN | 逐步追加平台补贴 |
| GET | /admin/business-configs/:key | SUPER_ADMIN | 查看全局配置和审计 |
| PUT | /admin/business-configs/:key | SUPER_ADMIN | 创建新配置版本 |
| GET | /admin/merchants/:merchantId/fulfillment-risk | SUPER_ADMIN | 完整履约指标、风险与曝光审计 |
| POST | /admin/merchants/:merchantId/exposure/evaluate | SUPER_ADMIN | 评估或明确强制曝光状态 |
| POST | /admin/riders/:riderId/restrictions | SUPER_ADMIN | 创建人工骑手限制 |
| GET | /admin/riders/:riderId/restrictions | SUPER_ADMIN | 查看取消计数、限制和完整审计 |
| PUT | /admin/riders/:riderId/capacity-override | SUPER_ADMIN | 设置/清除个人容量 override 并审计 |
| PATCH | /admin/rider-restrictions/:restrictionId | SUPER_ADMIN | 解除或调整限制 |
| PUT | /admin/users/:userId/admin-profile | SUPER_ADMIN | 管理管理员级别 |

## 测试与构建

    pnpm typecheck
    pnpm test
    pnpm test:integration
    pnpm build

集成测试使用真实 PostgreSQL，覆盖既有订单/异常/结算流程、审核补丁状态矩阵，以及默认 commission=0、release 后未结垫付恒等、非零自报付款拒绝、participant escalation guard、超管转派、容量历史回填、容量 1→2→5、订单池快照 DTO、classifier fallback/事务边界、rescue/tip/subsidy 精确传递、claim 价格快照、角色资金隔离和 Super Admin 权限。

## 已实现

- 可配置冷静期和自动正式提交商家
- 冷静期取消与推进竞态保护
- 人工短订单码
- 商家/地点交付方式交集
- 用户交付验证和商家取餐验证
- 独立 Evidence 与 MockMediaStorage
- 结构化异常事实
- 角色化订单时间线
- 商家基础报价仅作参考（已确认）与独立 rescue contribution/history/cooldown 分离；金额仍为开发内账，未证明外部实付
- 可配置 DeliveryPricingPolicy：全局默认、商家 override、数量规则和输入快照
- 用户骑手激励独立账本
- 服务端 24 小时骑手激励窗口和订单 tipDeadline 快照
- 骑手接单原子价格快照
- customer fee、rider base、merchant rescue、tip、subsidy、guarantee、platform contribution 原子快照
- 固定首次发布时间和接单截止时间
- NO_RIDER_ACCEPTED 与退款记录边界
- 平台逐步补贴和三类策略接口
- 自然接单与补贴后接单样本隔离
- 商家履约事实指标与结构化异常计数
- 独立 timeRisk / completionRisk 和 TRIAL/UNKNOWN 语义
- 带最低样本、进入/恢复滞后和审计的曝光策略
- TRIAL 稳定灰度 gate 与种子覆盖
- 终态/接单/补贴救援/恢复样本集合分离
- 骑手未取餐取消、日内 warning、两条滚动冷却路径和 override 审计
- 严重餐损/丢失、补餐提议与用户确认
- ExceptionCase 共享池、单处理人 CAS、转交/接管/升级审计
- Compensation obligation、部分 settlement reservation、平台垫付与 outstanding；非零 rider 自报付款在可验证资金能力上线前被拒绝
- OPERATOR / SUPER_ADMIN 分权和管理员级别审计
- 类型化异常分类 adapter 与确定性/manual fallback（无真实 Jev 调用）
- 补贴使用事实与曝光状态解耦
- 管理员配置版本和审计
- 角色隔离价格视图
- 骑手容量 1→2→5、个人 override、平台绝对上限 10 和可读升级事件
- 骑手订单池 guaranteed payout / pickup / destination / foodType / quantity 显式 DTO
- 低风险物品分类 telemetry 与不可用 fallback（无真实 Jev 调用）
- DeliveryAssignment 责任记录
- RiderSettlement PENDING、AVAILABLE、HELD
- PostgreSQL migration、幂等 Seed、OpenAPI 和自动化测试
- 第一阶段 Pricing、Settlement、补贴和订单池能力

## 尚未决定的商业规则

- 冷静期最终秒数
- 骑手待结算最终天数
- 5 单之后是否自动升级、哪些事实会触发自动降额度
- 各商家/品类/区域的正式配送定价参数与长期算法
- 商家基础报价只作参考、不出资已经确认，旧“reference或真实成本”问题已收口；仍待设计的是实际付款渠道与报价/支付并发细节，不改变已创建订单快照或已付款本单基础价
- 商品佣金可配置、默认0%已确认；正式非零费率及首期直付模式实际收取/结算仍待议
- 平台补贴正式步长、间隔、单订单上限和预算比例
- 40 分钟窗口内更细的提醒与补贴顺序
- 接单后激励在异常争议下的退款边界
- 商家风险和曝光的正式统计窗口、阈值及严重风险自动暂停条件
- 商家何时必须取餐验证
- 用户何时必须使用交付码
- 异常订单判责规则
- 赔付比例
- 平台垫付后的长期追偿、未来收入抵扣和骑手恢复接单规则
- 普通管理员资金权限的更细粒度授权与二次审批
- 必须本人交接、强制交付码等特殊模式下的用户失联等待与最终处理；普通固定地址/位置节点正常履约不要求联系或等待
- 真实媒体存储
- 微信登录
- 手机号登录
- 实名要求
- 微信支付

## 明确未实现

- 完整聊天或 IM
- 地图、导航、自动派单和路线规划
- 评价、评论、推荐和排名
- 骑手或商家评分
- 自动处罚、自动判责和 AI 判责
- 真实提现和支付
- 微信正式登录、手机号登录、短信验证码和强制实名认证
- 复杂图片防伪

## 第五轮财务安全基础（2026-10-11）

- 商品佣金默认 0%，明确切换费率需要 ORDER_POLICY 当前版本和审计原因，只影响新订单。配送双侧比例与商品佣金独立。
- `PAYMENT_COST_ESTIMATE` 显式配置 `feeBps` / `fixedFeeMinor` 后，仅在新订单财务快照保存 ESTIMATED 平台手续费；未配置及旧订单保持未知。估算基数是初始商品款加用户基础配送费，后续红包/退款手续费调整尚无真实渠道实现。估算不改变任何一方合同款项。
- `GET /admin/finance/orders/:orderId/projection` 是旧 SUPER_ADMIN 可读的开发内账投影，分别显示商品佣金、配送基础价差、平台补贴、预计手续费与第三方权益；实际手续费、真实退款损失及运营实际支出未核实，不等于可分配利润或现金。
- `FINANCE_RESERVE_POLICY` 必须显式配置 `fixedFloorMinor` / `forecastDays` / `forecastMultiplierBps`（10000表示倍数1，仅解释单位，不是默认值）。`POST /admin/finance/budget-preview` 只读模拟场景，不创建工资批准、预算预留或支付。预测组件为同一期间的退款损失、补贴、支付费用与短期运营成本估计，按来源去重，与已知义务对照后计算 `max(固定最低, 向上取整的动态预测)`。没有真实订单自动预测器。
- 场景现金在扣除义务之前，场景合法收益在扣除安全储备之前；义务须说明是否已在各基数中扣减，避免重复计算。现金/收益分别减去尚未扣减义务、工资预留及储备，再取较小非负上限；这些输入始终是假设，客户端不可声明真实余额或 Root 认证。
- 所有财务预览均标记 `simulated:true`、`notVerified:true`、`realWithdrawalEnabled:false`、`realWithdrawableMinor:0`。骑手既有 `withdrawableMinor` 也固定为0，原内账未预留额改由 `internalUnreservedMinor` 表达；已得收入、冻结与 AVAILABLE 账务状态不变。
- 两项新财务配置无 Seed 默认值，复用现有配置 CAS/版本审计。没有新增迁移、真实收款/提现/工资审批接口，旧 SUPER_ADMIN 不是 Root。外部手续费去重/调整纯函数仅为隔离测试契约，可信渠道验证和实际费用持久化尚未实现。
