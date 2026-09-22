# CODEX_REPORT

## Commit 范围

- 本轮请求起始基线：52a65eb54c90147a36824a427373dcaeec18ae87
- 已批准设计提交：bfa63b5
- 本轮结束代码 commit：d922186668e7a0c2ed5f465c616ff3bca9c36603
- 分支：main
- 远程：origin/main

## 修改文件概览

- Prisma schema、正式 migration 和幂等 Seed
- 订单状态机、冷静期处理和短订单码
- 商家/校园地点交付方式
- 配送任务、骑手持单限制和 DeliveryAssignment
- 一次性取餐码与交付码
- Evidence、MediaStorage mock、结构化异常
- 角色化 Timeline
- RiderSettlement 待结算服务与后台释放
- Fastify 路由、OpenAPI、环境配置
- 单元测试和 PostgreSQL 集成测试
- README

## 数据库 Migration

新增 migration：

- apps/api/prisma/migrations/20260922000200_order_handoff_settlement/migration.sql

Migration 增加交付方式、验证模式、OrderEvent 类型、DeliveryAssignment、RiderSettlement、VerificationCode、Evidence 和 ExceptionEvent。

兼容处理包括：

- 现有订单回填短码、短码日期、冷静期截止时间和交付配置。
- 现有骑手获得兼容并发额度。
- 现有已领取或完成任务补建 DeliveryAssignment。
- 现有已完成骑手收入补建为 AVAILABLE，避免迁移后重新冻结。
- 增加金额、额度、同任务单一 ACTIVE Assignment 和单用途活动验证码约束。

已验证 migration 可以在现有数据库上执行，也可以从空数据库连续执行全部 migration。

## 新增领域模型

- DeliveryMethod
- DeliveryAssignment
- RiderSettlement
- VerificationCode
- Evidence
- ExceptionEvent
- OrderEventType 和 OrderEventActorType
- DeliveryVerificationMode
- PickupVerificationMode

现有 Settlement 保留为订单整体结算快照。RiderSettlement 专门表达骑手收入的 PENDING、AVAILABLE 和 HELD。

## 状态机变化

主订单状态流：

CREATED → MERCHANT_PENDING → MERCHANT_CONFIRMED → READY_FOR_RIDER → CLAIMED → PICKED_UP → DELIVERED

CREATED 表示冷静期。到期后台服务原子推进到 MERCHANT_PENDING。

用户普通取消只允许在冷静期内。取消和到期推进使用互斥条件更新。

骑手取餐前放弃时：

CLAIMED → READY_FOR_RIDER

任务重新开放，原 DeliveryAssignment 记为 ABANDONED。

## 新增 API

- GET /campus-locations
- GET /orders/:orderId/timeline
- POST /orders/:orderId/evidence
- POST /orders/:orderId/exceptions
- POST /orders/:orderId/delivery-code
- POST /orders/:orderId/pickup-code
- POST /delivery-tasks/:taskId/verify-pickup-code
- POST /delivery-tasks/:taskId/abandon
- GET /riders/me/settlements

调整：

- POST /orders 接收 deliveryMethod。
- POST /orders/:orderId/cancel 只处理冷静期用户取消。
- pick-up 和 deliver 根据订单保存的验证模式检查 Evidence 或验证码。

## OpenAPI 变化

OpenAPI 版本更新为 0.2.0。所有新增路由和请求 Schema 已注册，可从 /docs 和 /docs/json 查看。

## Evidence 设计

Evidence 独立保存订单、操作者、角色、Evidence 类型、订单阶段、媒体引用、备注和 JSON 元数据。

代码验证 Evidence 只能由验证服务创建。

照片 Evidence 使用 MediaStorage 接口。当前 MockMediaStorage 只生成 mock 引用并记录客户端声明信息，不保存真实文件，也不证明照片真实性。

Evidence 不触发自动判责或处罚。

## 骑手并发限制

Rider.currentConcurrentOrderLimit 保存个人额度。BusinessConfig.platformMaxConcurrentOrdersPerRider 保存平台绝对上限。

抢单事务先对 Rider 行执行 FOR UPDATE，再统计 CLAIMED 和 PICKED_UP 任务。有效额度取个人额度与平台上限较小值。

同一骑手的并发抢单在数据库中串行化。原有两个骑手不能同时抢到同一任务的条件更新仍然保留。

## Settlement pending、available、held

订单送达时完成原 Settlement，并创建 RiderSettlement.PENDING。

pendingUntil 由配置化等待期计算。后台批处理只释放已到期且没有未解决 DELIVERY_DISPUTE 的记录。

DELIVERY_DISPUTE 将相关 PENDING 或 AVAILABLE 记录更新为 HELD。本阶段没有自动解冻、提现、扣款、负余额或历史余额追偿。

## 冷静期实现

BusinessConfig.coolingOffSeconds 控制新订单冷静期。Seed 演示值为 60 秒。

订单保存 coolingOffEndsAt。轻量后台处理器周期扫描到期订单。进程重启后可继续处理数据库中尚未推进的记录。

后台频率由 BACKGROUND_SWEEP_INTERVAL_MS 控制，不是商业参数。

## Timeline 实现

Timeline 查询合并 OrderEvent、Evidence 和 ExceptionEvent，按时间、来源和 ID 稳定排序。

所有角色复用订单关系权限。普通角色看不到事件内部 metadata、完整媒体引用、验证码或哈希；管理员可查看非敏感结构化 metadata。

没有建立第二套通用日志系统。

## 测试列表与结果

单元测试 12 项全部通过：

- 金额整数运算
- 状态机及放弃回池
- 短订单码和校园时区
- 补贴与曝光策略
- 用户交付验证策略
- 商家取餐验证策略

PostgreSQL 集成测试 12 项全部通过，覆盖：

- 冷静期内取消
- 到期后普通取消失败
- 取消和自动推进竞态
- 短码生成和同日唯一性
- 商家提前确认失败及角色权限
- 骑手个人额度
- 平台绝对上限
- 同一骑手并发请求不能绕过额度
- 两名骑手不能领取同一任务
- 领取、放弃和重新入池
- 正确与错误取餐码和交付码
- Evidence 订单、操作者和阶段绑定
- 用户失联允许与禁止无人接触投递
- 骑手收入进入 PENDING
- 到期变为 AVAILABLE
- 争议进入 HELD 且不能自动释放
- Timeline 顺序和权限过滤
- 原有完整订单、Pricing、Settlement 和补贴流程

## Build 与 TypeScript

- pnpm typecheck：通过
- pnpm build：通过
- 生产构建入口启动：通过
- /health：通过
- OpenAPI 0.2.0：通过

## Seed 与 Migration

- 现有开发数据库 migration：通过
- 空数据库全部 migration：通过，共 2 个
- 空数据库 Seed：通过
- Seed 幂等执行两次：通过
- 空数据库 Seed 演示订单：8 个

Seed 覆盖正常、冷静期、等待骑手、配送中、交付码、用户失联、现场 Evidence 和争议 HELD 场景。

## 已知问题

- MediaStorage 仍是 mock，不存储真实图片。
- 现场照片真实性无法由当前后端证明。
- 一次性码尚未实现生产级尝试次数限制和通知通道。
- 后台处理器运行在 API 进程内，适合当前小规模部署；未来多进程规模扩大时可迁移到独立 Worker。
- 四位短码适用于当前校园规模；如果单日订单量接近字符空间上限，应扩大码长。
- HELD 没有自动或人工解除接口，等待责任与争议流程确定。

## 有意没有实现

- 完整聊天和 IM
- 地图、导航、自动派单、路线规划
- 评价、评论、推荐和排名
- 用户、骑手或商家评分
- 自动处罚、自动判责、AI 判责
- 真实对象存储和复杂图片防伪
- 真实提现、微信支付
- 微信正式登录、手机号登录、短信验证码、强制实名认证
- 任意扣除历史余额、负余额和追债

## 下一阶段产品负责人需要决定

- 冷静期最终秒数
- 骑手待结算最终天数
- 骑手具体并发额度和升级规则
- 用户风险判定机制
- 商家风险判定机制
- 商家何时必须取餐验证
- 用户何时必须使用交付码
- 异常订单判责与解决流程
- 赔付比例和资金释放方式
- 用户失联等待时间
- 错误地址责任规则
- 真实媒体存储
- 微信登录、手机号登录和实名要求
- 微信支付
