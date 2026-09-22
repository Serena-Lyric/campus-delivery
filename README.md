# campus-delivery

campus-delivery 是面向校园半封闭场景的即时配送平台工程。当前版本在第一阶段订单池基础上加入订单冷静期、人工短码、交付方式、交接验证、Evidence、结构化异常、角色化时间线、骑手持单限制和待结算资金。

## 当前阶段

本阶段仍是模块化单体 REST API。重点是保存履约事实并保证状态、并发和资金状态正确，不实现评分、自动判责、自动处罚、自动派单或真实支付。

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
- CAMPUS_TIME_ZONE：短订单码日期分区时区。

版本化 BusinessConfig 保存演示业务参数：

- coolingOffSeconds：Seed 为 60 秒。
- riderSettlementPendingSeconds：Seed 为 5 天。
- platformMaxConcurrentOrdersPerRider：Seed 为 3。
- verificationCodeTtlSeconds：Seed 为 10 分钟。
- customerUnreachableWaitSeconds：只预留，不用于自动判责。
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

CREATED 表示冷静期。后台处理器在 coolingOffEndsAt 到期后原子推进到 MERCHANT_PENDING。用户无责取消只允许在 CREATED 且截止时间尚未到达时执行。取消和自动推进使用互斥条件更新。

骑手在取餐前可以放弃任务。订单从 CLAIMED 返回 READY_FOR_RIDER，任务重新开放，同时保留 DeliveryAssignment 事实记录。

## 短订单码

每笔订单保存 UUID 和四位人工短码。短码按校园日期建立唯一约束，字符集排除 0/O/1/I 等易混字符。短码用于报号和人工核对，不能替代 UUID。

## 交付方式与验证

交付方式：DESIGNATED_POINT、DOOR、FACE_TO_FACE。用户只能选择商家和目的地点共同支持的方式。

交付验证为 DELIVERY_PHOTO 或 HANDOFF_CODE。取餐验证为 CONFIRMATION、PHOTO 或 PICKUP_CODE。

一次性码只保存加盐哈希。明文只在签发响应中返回，重新签发会使旧码失效。成功验证自动创建代码验证 Evidence。

## Evidence

Evidence 独立保存订单、操作者、角色、类型、订单阶段、媒体引用、备注和结构化元数据。

照片使用 MockMediaStorage 生成 mock 引用。当前后端不存储真实图片，也不能证明图片一定来自现场相机。微信小程序相机和对象存储留待后续实现。

Evidence 只提供争议事实，不自动代表任何一方有责。

## 异常与用户失联

结构化异常包括 CUSTOMER_UNREACHABLE、WRONG_ADDRESS、MERCHANT_DELAY、ITEM_MISSING、ITEM_DAMAGED、RIDER_DELIVERY_EXCEPTION 和 DELIVERY_DISPUTE。

允许无人接触投递时，用户失联订单可在骑手提交 DELIVERY_PHOTO 后完成。不允许无人接触投递时，订单进入 EXCEPTION。系统不自动判责或扣款。

DELIVERY_DISPUTE 会把相关 RiderSettlement 更新为 HELD，但不会扣除历史余额。

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
| POST | /orders | 用户 | 创建冷静期订单 |
| GET | /orders/my | 用户 | 历史订单 |
| GET | /orders/:orderId | 订单相关方 | 订单详情 |
| POST | /orders/:orderId/cancel | 用户 | 冷静期内取消 |
| GET | /orders/:orderId/timeline | 订单相关方 | 结构化时间线 |
| POST | /orders/:orderId/evidence | 商家/骑手/管理员 | 创建照片 Evidence |
| POST | /orders/:orderId/exceptions | 订单相关方 | 报告结构化异常 |
| POST | /orders/:orderId/delivery-code | 用户 | 签发交付码 |
| POST | /orders/:orderId/pickup-code | 商家 | 签发取餐码 |
| POST | /merchant/orders/:orderId/confirm | 商家 | 确认正式订单 |
| POST | /merchant/orders/:orderId/ready | 商家 | 备妥并进入订单池 |
| GET | /delivery-tasks/available | 骑手 | 查看公开任务 |
| GET | /delivery-tasks/mine | 骑手 | 查看参与过的任务 |
| POST | /delivery-tasks/:taskId/claim | 骑手 | 原子抢单 |
| POST | /delivery-tasks/:taskId/abandon | 骑手 | 取餐前放弃 |
| POST | /delivery-tasks/:taskId/verify-pickup-code | 骑手 | 验证取餐码 |
| POST | /delivery-tasks/:taskId/pick-up | 骑手 | 验证并取餐 |
| POST | /delivery-tasks/:taskId/deliver | 骑手 | 验证并送达 |
| GET | /riders/me/settlements | 骑手 | 查看待结算资金 |
| POST | /admin/orders/:orderId/exception | 管理员 | 标记订单异常 |

## 测试与构建

    pnpm typecheck
    pnpm test
    pnpm test:integration
    pnpm build

集成测试使用真实 PostgreSQL，覆盖冷静期竞态、短码、双骑手抢单、个人与平台持单上限、并发占单、放弃任务、取餐码、交付码、Evidence、用户失联、待结算释放、争议冻结、权限和时间线过滤。

## 已实现

- 可配置冷静期和自动正式提交商家
- 冷静期取消与推进竞态保护
- 人工短订单码
- 商家/地点交付方式交集
- 用户交付验证和商家取餐验证
- 独立 Evidence 与 MockMediaStorage
- 结构化异常事实
- 角色化订单时间线
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
- 用户风险判定机制
- 商家风险判定机制
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
