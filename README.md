# 校园即时配送平台

面向校园半封闭场景的即时配送平台第一阶段工程框架。当前版本通过 REST API 跑通用户下单、商家备餐、订单池抢单、骑手履约和结算快照，不代表完整商业产品。

## 当前阶段

这是第一阶段的工程地基，目标是验证清晰的领域边界、订单状态机、数据库事务、角色权限、整数金额和配置化规则。演示入口为 OpenAPI 文档和自动化 API 测试，本阶段按产品选择不创建小程序页面。

## 技术栈

- Node.js 24、TypeScript 5、pnpm workspace
- Fastify 5 REST API 与 OpenAPI
- Prisma 6、PostgreSQL 16
- Vitest
- Docker Compose
- Fastify/Pino 结构化日志

## 目录结构

```text
.
├─ apps/api/
│  ├─ prisma/
│  │  ├─ migrations/                 # PostgreSQL migration
│  │  ├─ schema.prisma               # 数据库模型
│  │  └─ seed.ts                     # 幂等演示数据
│  ├─ src/
│  │  ├─ auth/                       # 开发认证与角色守卫
│  │  ├─ catalog/                    # 商家和商品查询
│  │  ├─ delivery/                   # 配送池、抢单和履约
│  │  ├─ merchant-policy/            # 补贴与曝光策略
│  │  ├─ orders/                     # 订单服务和状态机
│  │  ├─ shared/                     # 错误与金额工具
│  │  ├─ app.ts                      # Fastify 应用组装
│  │  └─ server.ts                   # 进程入口
│  ├─ tests/
│  │  ├─ integration/                # PostgreSQL/API 集成测试
│  │  └─ *.test.ts                   # 领域单元测试
│  └─ .env.example
├─ docs/superpowers/specs/           # 已批准的第一阶段设计
├─ docker-compose.yml
├─ package.json
└─ pnpm-workspace.yaml
```

## 本地启动

要求：Node.js 20 以上、pnpm 11、Docker Desktop 或兼容的 Docker Engine。

```powershell
pnpm install
Copy-Item apps/api/.env.example apps/api/.env
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm dev
```

服务默认地址为 `http://localhost:3000`：

- 健康检查：`http://localhost:3000/health`
- OpenAPI UI：`http://localhost:3000/docs`

本地接口使用 `x-user-id` 请求头选择 Seed 用户。`ENABLE_DEV_AUTH=true` 在 `NODE_ENV=production` 时会阻止进程启动，不能作为生产认证。

## 数据库初始化与 Seed

```powershell
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
```

Migration 除表、索引、外键和枚举外，还为金额、数量、配置版本和风险分值建立数据库检查约束。Seed 可重复执行，包含：

| 身份 | `x-user-id` |
|---|---|
| 用户 | `00000000-0000-4000-8000-000000000001` |
| 商家 | `00000000-0000-4000-8000-000000000002` |
| 骑手 A | `00000000-0000-4000-8000-000000000003` |
| 骑手 B | `00000000-0000-4000-8000-000000000004` |
| 管理员 | `00000000-0000-4000-8000-000000000005` |

演示商家 ID 为 `10000000-0000-4000-8000-000000000001`，宿舍地点 ID 为 `30000000-0000-4000-8000-000000000002`，鸡腿饭商品 ID 为 `50000000-0000-4000-8000-000000000001`。Seed 中的费率、补贴和曝光阈值只用于本地演示，不是生产商业规则。

## API 演示

启动服务后，可在 PowerShell 依次执行：

```powershell
$customer = @{ 'x-user-id' = '00000000-0000-4000-8000-000000000001' }
$merchant = @{ 'x-user-id' = '00000000-0000-4000-8000-000000000002' }
$rider = @{ 'x-user-id' = '00000000-0000-4000-8000-000000000003' }

$body = @{
  merchantId = '10000000-0000-4000-8000-000000000001'
  destinationLocationId = '30000000-0000-4000-8000-000000000002'
  items = @(@{
    productId = '50000000-0000-4000-8000-000000000001'
    quantity = 1
  })
} | ConvertTo-Json -Depth 4

$order = Invoke-RestMethod -Method Post -Uri http://localhost:3000/orders -Headers $customer -ContentType application/json -Body $body
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/merchant/orders/$($order.id)/confirm" -Headers $merchant
$ready = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/merchant/orders/$($order.id)/ready" -Headers $merchant
$taskId = $ready.deliveryTask.id
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/delivery-tasks/$taskId/claim" -Headers $rider
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/delivery-tasks/$taskId/pick-up" -Headers $rider
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/delivery-tasks/$taskId/deliver" -Headers $rider
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/orders/$($order.id)" -Headers $customer
```

## 当前 API

| 方法 | 路径 | 角色 | 用途 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查 |
| GET | `/merchants` | 已登录 | 浏览可曝光商家 |
| GET | `/merchants/:merchantId/products` | 已登录 | 查看商品 |
| POST | `/orders` | 用户 | 创建订单 |
| GET | `/orders/my` | 用户 | 查看历史订单 |
| GET | `/orders/:orderId` | 相关方/管理员 | 查看订单与事件 |
| POST | `/orders/:orderId/cancel` | 相关用户/商家/管理员 | 取餐前取消 |
| POST | `/merchant/orders/:orderId/confirm` | 所属商家 | 确认订单 |
| POST | `/merchant/orders/:orderId/ready` | 所属商家 | 备妥并进入配送池 |
| GET | `/delivery-tasks/available` | 骑手 | 查看公开任务 |
| POST | `/delivery-tasks/:taskId/claim` | 骑手 | 原子抢单 |
| GET | `/delivery-tasks/mine` | 骑手 | 查看自己的任务 |
| POST | `/delivery-tasks/:taskId/pick-up` | 领取骑手 | 标记取餐 |
| POST | `/delivery-tasks/:taskId/deliver` | 领取骑手 | 标记送达并结算 |
| POST | `/admin/orders/:orderId/exception` | 管理员 | 标记异常 |

分页列表接受 `limit`（1–100）和 `offset`。统一错误结构为 `code`、`message`、`details`、`requestId`。

## 测试与构建

```powershell
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

`pnpm test:integration` 会执行 migration 和 Seed，并使用真实 PostgreSQL 验证完整流程、角色越权和双骑手并发抢单。测试会清理自己创建的订单数据，请使用本地测试数据库执行。

## 已实现

- 四类角色及资源归属权限
- 商家、分类、商品和校园地点目录
- 订单及商品价格快照
- 受控订单状态机和完整 `OrderEvent` 轨迹
- 配送任务池、条件更新与事务化抢单
- 整数分金额模型和数据库约束
- 计价拆分、送达结算快照和平台净收入记录
- 配置化的缺口补贴策略与曝光状态策略
- 商家补贴账户和逐单补贴记录
- Prisma migration、幂等 Seed、统一错误、日志和 OpenAPI
- 单元测试与 PostgreSQL 集成测试

## 当前明确未实现

- 微信小程序页面、微信登录、真实支付和自动退款
- 地图、导航、GPS、路线规划、顺路推荐和自动派单
- 聊天、推荐、复杂评价和投诉处置工作流
- 骑手或商家的复杂排名与淘汰算法
- 实时通知、消息队列、微服务、Kubernetes 和分布式高并发架构
- 生产身份认证、生产监控、生产部署与数据备份方案

## 关键模型说明

- `OrderPricing` 保存商品金额、用户配送费、商家配送承担、平台补贴、骑手收入、平台抽成、商家结算、退款和赔付字段。
- `Settlement` 保存送达时的最终骑手应付、商家应付和平台净收入。平台净收入可能为负，表示该单补贴超过抽成；其他金额均要求非负整数分。
- `DeliveryTask.orderId` 唯一，抢单通过 `OPEN + riderId IS NULL` 条件更新；任务、订单状态和事件在同一事务提交。
- `BusinessConfig` 保存带版本的策略 JSON，加载时做运行时结构校验。
- `MerchantSubsidyAccount` 保存额度和使用量；`SubsidyRecord` 保证每一笔实际补贴可追踪。

## Future Decisions

以下问题尚未确定，代码中的 Seed 数字不能视为产品决策：

- 用户配送费如何收
- 商家具体承担多少配送费
- 骑手最终收入规则
- 平台抽成比例
- 平台补贴额度和补贴策略
- 商家降曝光具体算法
- 商家下架阈值
- 商家可接订单额度的调整规则
- 骑手违规与淘汰机制
- 异常订单责任认定
- 少餐、丢餐赔付规则
- 取消权限、时点、退款和责任规则
- 微信登录与微信支付
- 是否需要地图、定位和路线推荐
