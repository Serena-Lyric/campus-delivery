# campus-delivery

campus-delivery 是面向校园半封闭场景的即时配送平台工程。当前版本覆盖订单池、市场报价、履约证据、商家风险灰度、骑手未取餐容错、异常订单池、赔付资金事实和管理员分权。

## 当前阶段

本阶段仍是模块化单体 REST API。当前重点是骑手未取餐取消/冷却、取餐后严重餐损或丢失、异常共享池、赔付 reservation，以及 OPERATOR / SUPER_ADMIN 最小权限边界。

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

- ENABLE_BACKGROUND_JOBS：是否运行冷静期和结算扫描。
- BACKGROUND_SWEEP_INTERVAL_MS：扫描频率。
- CAMPUS_TIME_ZONE：短订单码日期分区时区，国内校园默认 Asia/Shanghai。

版本化 BusinessConfig 保存演示业务参数：

- coolingOffSeconds：Seed 为 60 秒。
- riderSettlementPendingSeconds：Seed 为 5 天。
- platformMaxConcurrentOrdersPerRider：Seed 为 3。
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

## Evidence

Evidence 独立保存订单、操作者、角色、类型、订单阶段、媒体引用、备注和结构化元数据。

照片使用 MockMediaStorage 生成 mock 引用。当前后端不存储真实图片，也不能证明图片一定来自现场相机。微信小程序相机和对象存储留待后续实现。

Evidence 只提供争议事实，不自动代表任何一方有责。普通低风险订单的照片默认可选；风险订单、配置明确要求照片或用户失联无人接触投递时才强制。

## 异常与用户失联

结构化异常进一步区分轻微损坏/延迟、严重餐损、餐品丢失、投诉争议和其他待审。ExceptionEvent 保存事实，ExceptionCase 保存运营处理状态，两者不混用。

允许无人接触投递时，用户失联订单可在骑手提交 DELIVERY_PHOTO 后完成。不允许无人接触投递时，订单进入 EXCEPTION。系统不自动判责或扣款。

DELIVERY_DISPUTE 会把相关 RiderSettlement 更新为 HELD，但不会扣除历史余额。

严重餐损/丢失后，骑手可提出补餐继续；用户明确接受后才能恢复送达。用户拒绝后 case 回到共享池。骑手主动赔付或管理员确认标准退款时，订单进入 EXCEPTION，订单本体退款事实立即记录，不等待骑手资金补足；RiderTip 不被自动清零或重算。

## 骑手未取餐取消与限制

每次未取餐取消保存不可变事件、结构化原因、校园自然日、当日计数、7 天计数和 warning 事实。单日第 2 次暂停当天新 claim；7 天累计 4 次或累计 2 次 warning 分别进入配置化冷却。claim 服务只阻止新接单，不改写骑手已经持有的其他任务。

限制状态保存类型、来源、开始/结束、状态和审计。只有 SUPER_ADMIN 可以创建、提前解除或调整跨订单限制；OPERATOR 无权修改。

## 市场报价与价格快照

商家确认订单时，订单使用商家当前默认配送报价进入骑手池。商家可在未接单前修改订单级报价；每次修改记录版本、旧值、新值、操作者、时间和原因，并受配置化冷却时间限制。

骑手接单事务锁定 DeliveryTask，并把当时的商家报价、用户激励、平台补贴、报价版本和总收益原子写入 DeliveryAssignment。接单后商家和平台不能向下修改已接受的金额。

角色价格视图彼此隔离：商家只看自己的报价历史；用户只看自己的费用、激励和退款；骑手主要看保证总收益；管理员看完整资金来源和快照。

## 用户骑手激励

用户激励与商家报价、平台补贴独立记账。操作窗口从订单创建起 24 小时，并在订单创建时保存 tipDeadline；截止判断由服务端执行。接单前用户可以增加、减少或撤回；接单后只能追加。正常送达后只要仍在窗口内仍可追加，新增部分更新当前责任骑手的收益和结算金额，100% 归骑手，不增加平台收入。

无人承接失败时，尚未锁定的用户骑手激励记录为全额退款。

## 平台逐步补贴

平台不再使用 targetRiderPayout 自动补足，也不在商家 ready 时自动补贴。补贴只能通过受控服务逐步追加，每次记录旧补贴、增量、新总额、策略版本、时间和触发原因。

服务端同时限制单次步长、单次绝对上限、单订单累计上限、最短间隔和商家风险预算占用比例。补贴资格、时点和增量是三个独立策略接口。

自然接单样本只包含补贴介入前接单的 DeliveryAssignment；补贴后接单记录为 SUBSIDIZED，不进入自然接单基线。

补贴服务只更新 subsidyUsageBps 这一事实指标，不再直接修改 Merchant.exposureState。旧 riskScore 语义已通过 migration 改名，旧 exposureForUsage 正常业务路径已删除。

## 商家履约风险与曝光

Merchant fulfillment metrics 使用相互独立的终态、接单、补贴终态和恢复样本查询。完成率只使用 DELIVERED 与 NO_RIDER_ACCEPTED；补贴救援率分母只包含已到可判断终态的 subsidized claim，进行中订单不会算失败。

timeRisk 与 completionRisk 独立返回。曝光策略实际使用完成/无人承接风险和“高补贴依赖 + 低救援率”；SLOW 和未归责 exceptionCounts 只作事实参考。恢复使用独立 window/minimum sample。TRIAL 通过 merchantId + customerId 稳定 hash 灰度，种子商家可显式覆盖为 100%；HIDDEN/SUSPENDED 始终不可见。

角色信息隔离：用户目录只看到简化风险提示；商家看到自己的履约事实摘要，不看到平台内部补贴策略；管理员看到完整指标、补贴事实和曝光决策历史。

## 管理员业务配置

只有 SUPER_ADMIN 可读取/更新全局版本化 BusinessConfig、执行平台补贴、调整曝光策略、管理员级别和骑手跨订单限制。OPERATOR 可领取异常 case、查看必要事实、转交/释放/升级并完成系统定义的标准处理，但不能绕过 ledger 任意输入扣款。

## 异常订单池与赔付资金

异常池使用 `ExceptionCase.version` 与原子条件更新保证同一 case 只有一个有效处理人。claim、release、transfer、takeover、escalate 和 resolve 都记录不可变 action。退款/冻结使用 case row lock、唯一 idempotency key、唯一 obligation 和事务，重试不会重复执行。

赔付义务分别记录本单 settlement reservation、其他未提现 settlement reservation、骑手主动支付、平台垫付、用户退款和 outstanding。`RiderSettlement.reservedMinor` 支持部分冻结；并发事务按固定顺序锁定结算行，同一余额不能重复占用。真实支付、提现、未来收入自动抵扣和长期追偿尚未实现。

异常分类提供类型化 `ExceptionClassifier`、确定性 fallback 和 manual fallback。分类来源/版本/置信度与管理员最终结论分开保存；当前没有真实 Jev 网络调用，AI 不执行资金或责任动作。

## 骑手持单限制

Rider.currentConcurrentOrderLimit 保存个人额度，BusinessConfig 保存平台绝对上限。有效额度取两者较小值。

抢单事务锁定骑手行，再统计 CLAIMED 和 PICKED_UP 任务，因此同一骑手的并发请求不能绕过额度。平台仍采用订单池和骑手自主选单。

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
| POST | /orders/:orderId/pickup-code | 商家 | 签发取餐码 |
| GET | /orders/:orderId/pricing | 订单相关方 | 角色隔离价格视图 |
| POST | /orders/:orderId/rider-tip-adjustments | 用户 | 调整或追加骑手激励 |
| POST | /merchant/orders/:orderId/confirm | 商家 | 确认并立即发布到骑手池 |
| PATCH | /merchant/orders/:orderId/delivery-quote | 商家 | 未接单前修改订单报价 |
| POST | /merchant/orders/:orderId/ready | 商家 | 更新可取自报信号 |
| GET | /delivery-tasks/available | 骑手 | 查看公开任务 |
| GET | /delivery-tasks/mine | 骑手 | 查看参与过的任务 |
| POST | /delivery-tasks/:taskId/claim | 骑手 | 原子抢单 |
| POST | /delivery-tasks/:taskId/pre-pickup-cancel | 骑手 | 取餐前有限无责取消并回原池 |
| POST | /delivery-tasks/:taskId/verify-pickup-code | 骑手 | 验证取餐码 |
| POST | /delivery-tasks/:taskId/pick-up | 骑手 | 验证并取餐 |
| POST | /delivery-tasks/:taskId/deliver | 骑手 | 验证并送达 |
| GET | /riders/me/settlements | 骑手 | 查看待结算资金 |
| GET | /riders/me/restrictions | 骑手 | 查看取消计数、warning、暂停和冷却 |
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
| PATCH | /admin/rider-restrictions/:restrictionId | SUPER_ADMIN | 解除或调整限制 |
| PUT | /admin/users/:userId/admin-profile | SUPER_ADMIN | 管理管理员级别 |

## 测试与构建

    pnpm typecheck
    pnpm test
    pnpm test:integration
    pnpm build

集成测试使用真实 PostgreSQL，覆盖既有订单/报价/结算流程，以及 TRIAL 灰度、角色 DTO 负向泄漏、终态/rescue 样本、取餐前取消、校园时区日界、两条冷却路径、限制 override、补餐确认、异常并发领取、处理权转移、幂等退款/释放、并发 reservation、平台垫付、管理员分权和 OpenAPI 路径。

## 已实现

- 可配置冷静期和自动正式提交商家
- 冷静期取消与推进竞态保护
- 人工短订单码
- 商家/地点交付方式交集
- 用户交付验证和商家取餐验证
- 独立 Evidence 与 MockMediaStorage
- 结构化异常事实
- 角色化订单时间线
- 商家订单级报价、版本历史和改价冷却
- 用户骑手激励独立账本
- 服务端 24 小时骑手激励窗口和订单 tipDeadline 快照
- 骑手接单原子价格快照
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
- Compensation obligation、部分 settlement reservation、主动支付、平台垫付与 outstanding
- OPERATOR / SUPER_ADMIN 分权和管理员级别审计
- 类型化异常分类 adapter 与确定性/manual fallback（无真实 Jev 调用）
- 补贴使用事实与曝光状态解耦
- 管理员配置版本和审计
- 角色隔离价格视图
- 骑手个人额度与平台绝对上限
- DeliveryAssignment 责任记录
- RiderSettlement PENDING、AVAILABLE、HELD
- PostgreSQL migration、幂等 Seed、OpenAPI 和自动化测试
- 第一阶段 Pricing、Settlement、补贴和订单池能力

## 尚未决定的商业规则

- 冷静期最终秒数
- 骑手待结算最终天数
- 骑手具体并发额度
- 骑手额度升级规则
- 商家配送报价默认值来源
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
- 用户失联等待时间
- 错误地址责任规则
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
