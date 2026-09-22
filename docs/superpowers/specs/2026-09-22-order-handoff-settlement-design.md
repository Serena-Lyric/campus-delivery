# campus-delivery 订单交接与结算设计

## 1. 目标与边界

本阶段在现有模块化单体中加入已确认的订单冷静期、短订单码、交付方式、交接验证、Evidence、结构化异常、角色化时间线、骑手持单限制和骑手待结算资金。

继续复用现有订单、配送任务、计价、结算、补贴、权限和错误处理结构。本阶段不实现评分、信用等级、自动判责、自动处罚、推荐、自动派单、导航、真实媒体存储、提现、支付、聊天或登录方式扩展。

## 2. 处理架构

保持单个 Fastify API 进程。新增可关闭的轻量后台处理器，按技术配置的短周期调用两个幂等批处理服务：

1. 推进已经结束冷静期的订单。
2. 释放已经到等待期且没有阻塞争议的骑手待结算资金。

业务截止时间写入数据库，进程重启后下一次扫描继续处理。集成测试关闭定时器并直接调用批处理服务。

新增 evidence、exceptions、timeline、settlements 四个窄模块。现有 orders 和 delivery 负责状态流、验证码和交接动作，不复制业务日志。

## 3. 订单冷静期

订单创建后继续使用 CREATED，表示订单已经创建且仍处于冷静期。订单增加 coolingOffEndsAt。新增 MERCHANT_PENDING，表示冷静期结束并已正式提交商家。

主流程：

CREATED → MERCHANT_PENDING → MERCHANT_CONFIRMED → READY_FOR_RIDER → CLAIMED → PICKED_UP → DELIVERED

用户无责取消只允许满足以下数据库条件：

- 状态仍为 CREATED。
- 数据库当前时间早于 coolingOffEndsAt。

后台推进使用相反时间条件。两个操作都用条件更新，在同一事务中更新状态并写 OrderEvent，所以取消和正式提交只有一个能成功。

BusinessConfig 增加 coolingOffSeconds。订单创建时保存截止时间，后续配置变更不追溯修改已有订单。Seed 演示值为 60 秒。

## 4. OrderEvent

OrderEvent 继续作为主要事实源，增加：

- eventType：区分创建、冷静期结束、商家确认、备妥、领取、放弃、取餐、送达和完成等动作。
- actorType：USER 或 SYSTEM。
- 系统事件允许 operatorId 和 operatorRole 为空。
- metadata：可选的非敏感 JSON。

已有事件迁移为 USER。自动推进使用 SYSTEM。验证码和完整媒体内部信息不得进入事件 metadata。

## 5. 短订单码

订单增加 shortCode 和 shortCodeDay。短码为四位人工友好字符，排除 0/O/1/I 等易混字符。shortCodeDay 按 CAMPUS_TIME_ZONE 技术配置计算，默认 Asia/Singapore。

数据库建立 shortCodeDay 与 shortCode 复合唯一约束。冲突由唯一约束检测并有限重试。短码只用于口头、包装和人工核对，API 资源仍使用 UUID。

## 6. 交付方式

新增 DeliveryMethod：

- DESIGNATED_POINT
- DOOR
- FACE_TO_FACE

Merchant 和 CampusLocation 分别保存 supportedDeliveryMethods。用户只能选择两者交集，订单保存最终 deliveryMethod。

版本化策略配置声明允许无人接触投递的方式，以及各方式的正常验证要求。业务代码不固定“外卖架”或“房门口”。

## 7. 交付与取餐验证

订单保存 deliveryVerificationMode：

- DELIVERY_PHOTO
- HANDOFF_CODE

DeliveryVerificationPolicy 接收交付方式和显式风险结果。风险结果只有 NORMAL 和 REQUIRE_HANDOFF_CODE；本阶段不计算风险。

订单保存 pickupVerificationMode：

- CONFIRMATION
- PHOTO
- PICKUP_CODE

MerchantHandoffPolicy 只读取显式配置或设置，不计算商家评分。

一次性验证记录区分 DELIVERY 和 PICKUP，保存随机盐、哈希、签发者、签发时间、过期时间、验证者、验证时间和失效时间。用户签发交付码，商家签发取餐码；重新签发使旧码失效。API 只在签发响应返回明文。验证成功后由系统创建对应 Evidence。

## 8. Evidence 与媒体存储

Evidence 保存：

- orderId
- actorId 和 actorRole
- evidenceType
- orderStage
- mediaReference
- note
- metadata
- createdAt

类型包括 MERCHANT_HANDOFF_PHOTO、RIDER_PICKUP_PHOTO、DELIVERY_PHOTO、HANDOFF_CODE_VERIFICATION 和 PICKUP_CODE_VERIFICATION。

代码验证 Evidence 只能由验证服务创建。照片 Evidence 根据订单关系和阶段检查权限。

MediaStorage 接口负责生成媒体引用。首版 MockMediaStorage 接收文件名、内容类型、客户端声明的采集时间和来源，返回 mock 引用。它不存储真实图片、不验证拍摄来源，也不宣称照片一定来自现场。

Evidence 只记录事实，不触发责任认定或处罚。

## 9. 结构化异常

ExceptionEvent 保存订单、报告人、订单当时状态、异常类型、说明、关联 Evidence、创建时间和可选解决时间。

类型包括 CUSTOMER_UNREACHABLE、WRONG_ADDRESS、MERCHANT_DELAY、ITEM_MISSING、ITEM_DAMAGED、RIDER_DELIVERY_EXCEPTION 和 DELIVERY_DISPUTE。

用户失联规则：

- 允许无人接触投递时，记录异常但保持配送状态；完成时必须提供 DELIVERY_PHOTO。
- 不允许无人接触投递时，记录异常并把订单转为 EXCEPTION，不自动完成、不判责、不扣款。
- 等待时长仅保留配置接口，本阶段不据此自动判责。

创建 DELIVERY_DISPUTE 时，将相关骑手待结算记录更新为 HELD，不执行扣款。

## 10. 骑手持单和责任事实

Rider 增加 currentConcurrentOrderLimit。BusinessConfig 增加 platformMaxConcurrentOrdersPerRider。有效额度取两者较小值。

抢单事务：

1. 对骑手行执行 FOR UPDATE。
2. 统计 CLAIMED 或 PICKED_UP 的活跃任务。
3. 检查个人额度和平台绝对上限。
4. 条件更新仍公开的任务。
5. 创建 DeliveryAssignment 并更新订单及事件。

同一骑手的并发请求按骑手行锁串行执行，不能绕过额度。

DeliveryAssignment 每次领取单独记录 ACTIVE、ABANDONED、COMPLETED 或 EXCEPTION。骑手在取餐前可放弃；系统结束当前 Assignment、重新开放任务，并把订单从 CLAIMED 返回 READY_FOR_RIDER。放弃不产生评分或自动处罚。

claimed、completed、abandoned、exception 和 dispute 数量从事实记录查询，不增加评分或重复计数字段。

## 11. 骑手待结算资金

保留现有 Settlement 作为整体结算快照。新增与订单一对一并关联骑手的 RiderSettlement，保存 amountMinor、status、pendingUntil、availableAt、heldAt、holdReason 和时间戳。

状态为 PENDING、AVAILABLE、HELD。

送达事务完成整体 Settlement，并创建 RiderSettlement PENDING。等待期来自 riderSettlementPendingSeconds，Seed 演示值为 5 天。

释放批处理只处理到期、仍为 PENDING 且没有未解决 DELIVERY_DISPUTE 的记录。争议使记录进入 HELD。本阶段没有提现、任意扣款、负余额、历史余额追偿或自动解冻。

## 12. 时间线

GET /orders/:orderId/timeline 复用订单可见性规则，合并 OrderEvent、Evidence 和 ExceptionEvent。

所有项目归一化为 type、timestamp、actorRole、summary 和过滤后的 details，再稳定排序。相同时间使用来源类型和记录 ID 确定顺序。

用户、商家、骑手和管理员只看到与订单关系匹配的时间线。验证码、哈希、内部存储路径和无关隐私字段对所有角色隐藏。

## 13. API

新增或调整：

- POST /orders：增加 deliveryMethod，返回短码和冷静期截止时间。
- POST /orders/:orderId/cancel：只处理冷静期用户取消。
- GET /orders/:orderId/timeline
- POST /orders/:orderId/evidence
- POST /orders/:orderId/exceptions
- POST /orders/:orderId/delivery-code
- POST /orders/:orderId/pickup-code
- POST /delivery-tasks/:taskId/verify-pickup-code
- POST /delivery-tasks/:taskId/abandon
- POST /delivery-tasks/:taskId/pick-up：校验取餐模式。
- POST /delivery-tasks/:taskId/deliver：校验 Evidence 或交付码。
- GET /riders/me/settlements

后台推进和结算释放不提供公开业务接口。

## 14. 权限

- 用户：选择交付方式、冷静期取消、签发自己的交付码、查看订单和过滤后的时间线。
- 商家：操作正式提交后的本店订单、签发取餐码、创建允许的商家交接 Evidence。
- 骑手：领取任务、创建履约 Evidence、验证取餐码、报告异常、取餐、送达或取餐前放弃。
- 管理员：查看完整但不含验证码明文的时间线，创建管理范围内的异常事实。

所有授权同时检查角色和订单关系。

## 15. Migration 与兼容

使用正式 Prisma migration：

- 添加枚举、字段、新表、索引、外键和检查约束。
- 已有 CREATED 订单的 coolingOffEndsAt 设置为 migration 执行时间。
- 已有骑手获得兼容额度。
- 已有已领取或完成任务按状态补建 DeliveryAssignment。
- 已完成订单按现有 Settlement 补建 AVAILABLE 的 RiderSettlement，避免重新冻结历史收入。

Migration 必须可从空数据库执行，也必须可应用于现有第一阶段数据库。

## 16. Seed

Seed 保持幂等，并创建正常订单、冷静期订单、等待骑手订单、配送中订单、需要交付码订单、用户失联订单、有现场 Evidence 的订单，以及有争议且 RiderSettlement 为 HELD 的订单。

演示配置：冷静期 60 秒、待结算 5 天、骑手个人额度 2、平台绝对上限 3。README 明确这些值不是最终商业规则。

## 17. 测试

保留现有测试，并覆盖：

1. 冷静期内取消。
2. 到期后普通取消失败。
3. 取消与到期推进竞态。
4. 短码格式和同日唯一冲突重试。
5. 个人额度。
6. 平台绝对上限。
7. 并发抢单不能绕过额度。
8. 正确和错误交付码。
9. Evidence 与订单、操作者、阶段绑定。
10. 用户失联时允许或禁止无人接触投递。
11. 完成后 RiderSettlement 为 PENDING。
12. 到期后变为 AVAILABLE。
13. 有争议时保持或进入 HELD。
14. 新 API 的角色和资源归属权限。
15. 时间线顺序、确定性和字段过滤。

额外验证任务放弃重新入池、取餐验证模式和 Seed 幂等性。

## 18. 文档与交付

README 更新能力、API、配置、Seed 场景和未决商业规则。OpenAPI 由路由 Schema 同步生成。

根目录新增 CODEX_REPORT.md，记录起止 commit、修改、migration、模型、状态机、API、Evidence、并发限制、结算、冷静期、时间线、测试、构建、Seed、已知问题、刻意未实现内容和产品待决事项。

完成后运行类型检查、全部测试、构建、干净数据库 migration 和 Seed，检查工作区，提交并普通 push 到 origin/main。禁止 force push，完成后停止。
