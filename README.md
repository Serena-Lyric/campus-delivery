# campus-delivery

campus-delivery 是面向校园半封闭场景的即时配送平台工程。当前版本在第一阶段订单池基础上加入订单冷静期、人工短码、交付方式、交接验证、Evidence、结构化异常、角色化时间线、骑手持单限制和待结算资金。

## 当前阶段

本阶段仍是模块化单体 REST API。当前重点是 24 小时用户骑手激励窗口、商家履约事实、独立时间/完成风险提示，以及带最低样本量和恢复滞后的曝光策略基础。

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
- slowFulfillmentThresholdSeconds：独立时间风险阈值。
- completionRiskElevatedThresholdBps / completionRiskHighThresholdBps：可观察完成风险阈值。
- exposure*ThresholdBps：曝光状态进入与恢复阈值；恢复阈值与进入阈值分离以避免抖动。
- subsidyDependencyThresholdBps / subsidyRescueThresholdBps：补贴依赖和救援效果事实阈值，不直接改变曝光。
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
| 管理员 | 00000000-0000-4000-8000-000000000005 |

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

正常流程不提供骑手接单后主动 abandon。接单即形成履约承诺。到达固定 claimDeadline 仍无人接单时进入 NO_RIDER_ACCEPTED，原始截止时间不会刷新，用户已记录支付金额和未锁定骑手激励进入退款记录边界。

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

结构化异常包括 CUSTOMER_UNREACHABLE、WRONG_ADDRESS、MERCHANT_DELAY、ITEM_MISSING、ITEM_DAMAGED、RIDER_DELIVERY_EXCEPTION 和 DELIVERY_DISPUTE。

允许无人接触投递时，用户失联订单可在骑手提交 DELIVERY_PHOTO 后完成。不允许无人接触投递时，订单进入 EXCEPTION。系统不自动判责或扣款。

DELIVERY_DISPUTE 会把相关 RiderSettlement 更新为 HELD，但不会扣除历史余额。

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

Merchant fulfillment metrics 按配置窗口从订单、任务、接单快照、补贴和结构化异常中按需计算。它记录可观察事实，不把用户失联、地址错误、骑手或系统异常自动归责给商家。完成率只使用 DELIVERED 与 NO_RIDER_ACCEPTED 这两个可观察终态；其他异常按类型单独计数。

timeRisk 与 completionRisk 独立返回。慢但完成正常的商家可以保持 NORMAL；样本不足时返回 UNKNOWN，并允许新商家保持 TRIAL。曝光策略使用最低样本量、分离的进入/恢复阈值和逐级恢复，HIDDEN/SUSPENDED 只由管理员明确控制。每次实际状态变化保存策略版本、前后状态、风险结论、指标快照、原因和操作者。

角色信息隔离：用户目录只看到简化风险提示；商家看到自己的履约事实摘要，不看到平台内部补贴策略；管理员看到完整指标、补贴事实和曝光决策历史。

## 管理员业务配置

管理员可通过后端 API 读取和更新版本化 BusinessConfig。每次修改记录操作者、前后版本、前后 payload、时间和原因。订单接单窗口、报价冷却和结算等待等会形成数据库时间或价格快照，后续配置修改不追溯改变既有承诺。

## 骑手持单限制

Rider.currentConcurrentOrderLimit 保存个人额度，BusinessConfig 保存平台绝对上限。有效额度取两者较小值。

抢单事务锁定骑手行，再统计 CLAIMED 和 PICKED_UP 任务，因此同一骑手的并发请求不能绕过额度。平台仍采用订单池和骑手自主选单。

## 待结算资金

送达后资金状态为 PENDING，等待期结束且不存在未解决争议时变为 AVAILABLE，争议可使其变为 HELD。

当前没有真实提现、自动扣款、负余额或历史余额追偿。

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
| POST | /delivery-tasks/:taskId/verify-pickup-code | 骑手 | 验证取餐码 |
| POST | /delivery-tasks/:taskId/pick-up | 骑手 | 验证并取餐 |
| POST | /delivery-tasks/:taskId/deliver | 骑手 | 验证并送达 |
| GET | /riders/me/settlements | 骑手 | 查看待结算资金 |
| POST | /admin/orders/:orderId/exception | 管理员 | 标记订单异常 |
| POST | /admin/orders/:orderId/platform-subsidies | 管理员 | 逐步追加平台补贴 |
| GET | /admin/business-configs/:key | 管理员 | 查看配置和审计 |
| PUT | /admin/business-configs/:key | 管理员 | 创建新配置版本 |
| GET | /admin/merchants/:merchantId/fulfillment-risk | 管理员 | 完整履约指标、风险与曝光审计 |
| POST | /admin/merchants/:merchantId/exposure/evaluate | 管理员 | 按当前策略评估或明确强制曝光状态 |

## 测试与构建

    pnpm typecheck
    pnpm test
    pnpm test:integration
    pnpm build

集成测试使用真实 PostgreSQL，覆盖冷静期竞态、商家确认即发布、报价历史与冷却、改价和接单并发快照、24 小时用户激励边界与送达后追加、固定接单截止时间、无人承接退款边界、逐步补贴约束、补贴与曝光解耦、履约指标与风险角色视图、TRIAL/UNKNOWN、曝光审计、自然/补贴样本隔离、配置审计、双骑手抢单、持单上限、验证码、Evidence、用户失联、待结算和时间线过滤。

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
