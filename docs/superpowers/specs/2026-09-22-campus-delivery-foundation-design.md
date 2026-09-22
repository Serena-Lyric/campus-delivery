# campus-delivery 第一阶段设计

## 1. 目标与边界

本阶段建立一个面向校园半封闭场景的可运行工程框架，通过 REST API 完整演示用户下单、商家确认与备餐、订单进入配送池、骑手领取与履约、平台生成账务快照的流程。

重点是模块边界、类型安全、数据库约束、可配置规则和自动化测试。第一阶段不包含小程序页面、真实支付、地图与定位、自动派单、路线优化、聊天、推荐、复杂评价、复杂淘汰算法、微服务或分布式基础设施。

## 2. 技术方案

- Node.js + TypeScript
- pnpm 单仓库
- Fastify REST API 与 OpenAPI 文档
- Prisma ORM
- PostgreSQL
- Vitest
- Docker Compose 本地数据库
- Fastify 内置 Pino 结构化日志

仓库先建立 `apps/api`，避免创建没有实际用途的客户端空壳。OpenAPI 文档、README 调用步骤和集成测试共同承担第一阶段演示入口。

## 3. 总体架构

API 采用模块化单体，按业务能力划分为：

- `auth`：开发环境身份识别和角色守卫
- `catalog`：商家、分类和商品查询
- `orders`：下单、订单查询和订单状态机
- `delivery`：配送任务池、抢单、取餐和送达
- `merchant-policy`：补贴与曝光策略
- `settlement`：计价拆分和结算快照
- `shared`：金额工具、配置、错误处理和日志约定

HTTP 路由只负责认证、输入校验、调用应用服务和输出结果。状态变化、金额计算、权限范围和策略判断放在应用服务或领域服务中。数据库操作通过 Prisma 仓储调用完成，并在需要一致性的流程中共享事务。

## 4. 身份与权限

`User` 具有一个角色：`CUSTOMER`、`MERCHANT`、`RIDER` 或 `ADMIN`。商家用户和骑手用户分别关联自己的 `Merchant` 或 `Rider` 资料。

本地演示通过 `x-user-id` 请求头识别 Seed 用户。认证插件从数据库加载用户和角色。该模式只在明确开启的开发配置下可用；生产配置启动时拒绝启用。未来微信登录替换认证适配层，不改变业务服务。

权限边界：

- 用户只能创建订单、查看自己的订单，并在取餐前请求取消自己的订单。
- 商家只能确认、备妥或取消本店订单。
- 骑手只能领取公开任务，并操作自己领取的任务。
- 管理员可以把非终态订单标记为异常，并执行管理范围内的取消。

取消后的退款、责任和赔付规则不在本阶段计算。

## 5. 数据模型

### 5.1 人员、商家与目录

- `User`：身份、显示名、角色、启用状态。
- `Merchant`：商家资料、营业状态、曝光状态、同时接单额度、默认配送承担金额和所属校园地点。
- `Rider`：骑手资料和状态。
- `ProductCategory`：商家内商品分类。
- `Product`：商品名称、整数分单价、上架状态。
- `CampusLocation`：校园节点名称、类型、可选描述；类型覆盖校门、商家、饭堂、宿舍楼、教学楼和其他地点。

### 5.2 订单

- `Order`：客户、商家、配送地点、地点文本快照、状态和时间戳。
- `OrderItem`：商品引用、商品名称快照、整数分单价、数量和小计。
- `OrderEvent`：订单、前后状态、操作者、操作者角色、时间和可选原因。

订单状态为：

`CREATED → MERCHANT_CONFIRMED → READY_FOR_RIDER → CLAIMED → PICKED_UP → DELIVERED`

`CANCELLED` 和 `EXCEPTION` 为终态。取餐前可按权限进入 `CANCELLED`；任一非终态可由管理员进入 `EXCEPTION`，骑手可在领取后对自己负责的订单报告异常。所有变化必须经过 `OrderStateTransitionService`，在同一事务中更新订单并追加 `OrderEvent`。

### 5.3 配送任务

- `DeliveryTask`：与订单一对一，保存公开、已领取或完成状态，骑手、配送收益和领取时间。

订单进入 `READY_FOR_RIDER` 时创建公开任务。抢单在数据库事务中执行带条件的原子更新，仅更新 `OPEN` 且尚无骑手的任务。受影响行数不是 1 时返回 409。成功后在同一事务中把订单变为 `CLAIMED` 并写入事件，因此两个并发骑手只能有一个成功。

### 5.4 金额与结算

- `OrderPricing`：订单一对一，保存商品金额、用户配送费、商家配送承担、平台补贴、骑手收入、平台抽成、商家结算、退款和异常赔付。
- `Settlement`：订单一对一，保存结算状态、最终骑手应得、商家应得、平台应得和完成时间。

所有金额均使用整数最小货币单位。输入校验拒绝小数、非安全整数和负数。订单项按下单时单价形成快照；履约所需金额字段在订单进入配送池前形成计价快照；送达时完成结算记录。

### 5.5 补贴、曝光与配置

- `MerchantSubsidyAccount`：商家的补贴额度、累计使用和风险分值。
- `SubsidyRecord`：每次平台补贴的订单、商家、金额、策略版本和时间。
- `BusinessConfig`：配置键、版本、启用状态和经过校验的 JSON 内容。
- `Merchant.exposureState`：`NORMAL`、`REDUCED`、`LIMITED`、`SEVERELY_LIMITED`、`HIDDEN`、`SUSPENDED`。

首版 `GapSubsidyPolicy` 计算配置中的目标骑手收入与商家及用户配送承担之和的差额，并受启用开关、单笔上限及商家剩余额度限制。`ExposurePolicy` 根据配置的补贴使用率区间返回曝光状态。Seed 中的数字只是本地演示配置，不代表已确认的商业规则。应用代码不包含费率或阈值常量。

## 6. REST API

- `GET /health`
- `GET /merchants`
- `GET /merchants/:merchantId/products`
- `POST /orders`
- `GET /orders/my`
- `GET /orders/:orderId`
- `POST /orders/:orderId/cancel`
- `POST /merchant/orders/:orderId/confirm`
- `POST /merchant/orders/:orderId/ready`
- `GET /delivery-tasks/available`
- `POST /delivery-tasks/:taskId/claim`
- `GET /delivery-tasks/mine`
- `POST /delivery-tasks/:taskId/pick-up`
- `POST /delivery-tasks/:taskId/deliver`
- `POST /admin/orders/:orderId/exception`

请求和响应使用 JSON Schema 校验，并据此生成 OpenAPI。列表接口第一阶段提供明确的页大小上限和游标或偏移参数，不实现复杂筛选与排序。

## 7. 核心数据流

1. 用户查询商家和商品，提交商品数量及校园配送地点。
2. 下单事务从数据库读取商品与商家状态，重新计算整数分商品总额，创建订单、订单项、初始计价和 `CREATED` 事件。
3. 商家确认订单，状态变为 `MERCHANT_CONFIRMED`。
4. 商家标记备妥。系统加载有效业务配置，计算配送收益与可选补贴，创建补贴记录，更新补贴账户和商家曝光状态，创建配送任务，并把订单变为 `READY_FOR_RIDER`。
5. 两名骑手可同时请求抢单。条件更新只允许一名骑手成功；成功者的订单变为 `CLAIMED`。
6. 成功骑手依次标记取餐和送达。
7. 送达事务把订单变为 `DELIVERED`、完成配送任务、写入事件并完成结算快照。

## 8. 错误处理与日志

统一错误响应包含：

```json
{
  "code": "ORDER_STATE_CONFLICT",
  "message": "Order cannot perform this action in its current state",
  "details": {},
  "requestId": "request-id"
}
```

- 输入错误：400
- 未认证：401
- 越权：403
- 资源不存在：404
- 状态或抢单冲突：409
- 未预期错误：500，同时记录结构化错误日志

日志包含请求标识、路由、状态码和必要的业务实体标识，不记录敏感请求头或完整个人信息。

## 9. 测试设计

单元测试覆盖：

1. 合法与非法订单状态转换。
2. 金额只接受整数分，并验证拆分计算没有浮点误差。
3. 补贴开关、单笔上限、账户余额和目标缺口。
4. 各配置区间对应的商家曝光状态。

PostgreSQL 集成测试覆盖：

1. 完整下单、商家确认、备妥、骑手领取、取餐、送达流程。
2. 两个独立骑手并发领取同一任务，断言一个成功、一个得到 409，数据库只有一个领取者。
3. 非法角色、非订单所有者、非所属商家和非任务骑手均无法执行受限操作。
4. 最终订单事件序列、配送任务、补贴记录、计价和结算记录一致。

## 10. 本地运行与交付

Docker Compose 启动 PostgreSQL。Prisma migration 建立完整结构，Seed 创建校园地点、四类用户、一个商家、商品、补贴账户和明确标注的演示配置。README 说明安装、环境变量、数据库迁移、Seed、启动、测试和完整 API 调用顺序，并列出当前实现、明确未实现功能和产品待决事项。

## 11. 产品待决事项

- 用户配送费如何收取
- 商家承担配送费用的规则
- 骑手最终收入规则
- 平台抽成比例
- 平台补贴额度和补贴策略
- 商家降曝光算法
- 商家下架阈值
- 商家同时接单额度的调整规则
- 骑手违规与淘汰机制
- 异常订单责任认定
- 少餐、丢餐与赔付规则
- 取消权限、时点、退款和责任规则
- 微信登录与微信支付
- 是否需要地图与定位
- 是否实现路线或顺路订单推荐

这些事项只以配置字段、策略边界或数据记录能力预留，不在第一阶段形成生产规则。
