# CODEX_REPORT — 商家货架与易损配送风险 A / B / C

记录日期：2026-10-10（Asia/Singapore）。执行范围仅为本轮 `CODEX_TASK.md`。

## 1. 提交与交付状态

- 同步前本地 main：`4690492`，工作区干净；通过 fetch + fast-forward 同步，没有覆盖未提交工作。
- 本轮实现起点：`94ee79a9eeceb4b89290d002e9a725532db524f4`。
- A：`f844f19c4fc3115a74575fde2fc25c8c514cb55c` — 两套分类、商家维护、订单权威风险快照。
- B：`4a449757f81f8f04bf6b46f51f90d8fc700bb509` — 聚合金额、版本化取证等级、并行验证、无法取证上报。
- C / 实现结束：`0abb8197d2852411ca75a7d06b19fddbe4e8ab5f` — 漏报拒取、暂停、更正、明确重新发布。
- A/B/C 均已正常 push 到 `origin/main`；`git ls-remote --heads origin main` 已确认远端为上述 C 提交。没有 force push。
- 生成报告前 `git status --short --branch` 为 `## main...origin/main`，无工作区改动。本报告单独提交和推送；报告自身 SHA 用 `git log -1 -- CODEX_REPORT.md` 查询，最终提交/远端一致性和工作区状态在推送后再次核验。

以下结果来自本地执行。GitHub 查询 C 提交的 Actions runs = 0、check runs = 0、combined status 数量 = 0（state 返回 pending），**没有独立 CI 通过证据**。

## 2. 阶段 A：已执行的行为

| 任务要求 | 运行时实现 | 验证 |
| --- | --- | --- |
| 商家自由货架与平台风险分离 | 复用 ProductCategory；Product 增加图片 URL、营销短标签、排序；DeliveryCategory 独立保存稳定 code、名称、版本、核定标签、核心组及可选状态 | 同名商品分属不同自建组时，权威风险一致 |
| 首批仅蛋糕、圣代属于核心组 | 迁移建立 CAKE / SUNDAE；DRINK、SOUP_MEAL、ORDINARY_MEAL 非核心，UNKNOWN 待核定 | 可选类别及核心组断言；昂贵普通食品不触发新强制规则 |
| 商家必须明确选择标准类别 | saveProduct 验证可选的平台 code；商家不能传入或写入 coreFragile/riskTags 等映射字段 | catalog-input 单测；商品字段边界、UNKNOWN 不可作为新发布选择 |
| 身份、归属、价格与展示字段校验 | 商家 guard + service 角色/merchantId 校验；分组归属校验；商品更新 expectedVersion 条件更新；显式响应 select | 跨商家商品/分组拒绝、跨商家分组引用拒绝、陈旧更新拒绝、价格/长度/标签边界 |
| 订单权威快照不被 AI 或后续编辑改变 | OrderItem 保存独立类别、类别版本、风险标签、核心组和 reviewRequired；原 suggestedFoodType/handlingTags 保留为建议 | 分类器失败仍保留蛋糕权威风险；后改名/类别不倒灌历史订单 |
| 分类期间防止旧快照写入 | 预分类保存商品版本和完整类别事实；事务按排序对 Product、DeliveryCategory 加 FOR SHARE，重读后比较再插入订单 | 预分类期间修改商品类别或平台类别版本，返回 PRODUCT_FACTS_CHANGED，订单不落库 |
| 旧数据安全兼容与补录 | 历史商品默认 UNKNOWN，历史 OrderItem 为 UNKNOWN + reviewRequired；商家可通过 catalog 读出待核定记录再显式更新商品 | 真实旧库升级验证；补录商品不改旧订单名称、分类或金额 |

新增维护 API：

- `GET /catalog/delivery-categories`：读取平台标准类别。
- `GET /merchant/catalog`：读取自己商家的分组和商品，包括下架商品及待核定类别。
- `POST /merchant/catalog/categories`、`PUT /merchant/catalog/categories/:id`。
- `POST /merchant/catalog/products`、`PUT /merchant/catalog/products/:id`；更新需要 expectedVersion。
- 原 `GET /merchants/:merchantId/products` 保留，增加展示与标准履约字段，按商品 sortOrder 排序。

商品写入需要 categoryId、name、priceMinor、isAvailable、deliveryCategoryCode、sortOrder、marketingTags；description/imageUrl 可选。价格、数量继续使用整数。商品未知类别不会被猜成普通食品或蛋糕；兼容旧商品下单时继续显式输出 reviewRequired，不代表已核定为安全普通食品。

## 3. 阶段 B：已执行的行为

| 任务要求 | 运行时实现 | 验证 |
| --- | --- | --- |
| 合并所有核定核心商品行 | pickupRiskSnapshot 累加 coreFragileSnapshot 行的 unitPriceMinor × quantity，排除普通行 | 两份 3000 分圣代合计 6000；核心 3000 + 普通 8000 只计 3000 |
| 严格超过阈值 | 默认 >1500 RECOMMENDED，>5000 REQUIRED，否则 NONE | 单测及 PostgreSQL API 场景覆盖 1500 / 1501 / 5000 / 5001 |
| 版本化配置与旧单稳定 | ORDER_POLICY 增加两个可选字段，旧配置缺字段时兼容初始值；原 SUPER_ADMIN 写 guard 和配置审计沿用；新订单保存实际阈值、等级、金额、策略版本 | OPERATOR 修改拒绝；阈值顺序错误拒绝；创建/claim 后修改配置不改变旧单要求 |
| 接单前和接单后可见风险 | available、claim、mine 及订单详情返回 pickupRisk；骑手任务 DTO 分开返回权威类别/风险标签与 carrying 中的分类建议 | available 中核定类别、合计、等级、版本断言；内部资金和阈值负向断言 |
| 原取餐验证与额外照片并行 | pickUpTask 先校验原 PHOTO / PICKUP_CODE，再校验额外 REQUIRED 照片；新增 pickupPhotoEvidenceId，兼容旧 evidenceId | 同单取餐码与照片必须同时满足；仅码或仅照片失败 |
| Evidence 引用不能冒用 | 查订单、actorId、actorRole、类型、CLAIMED 阶段及当前承接时间；强制照片另校验图片 MIME、服务端 Mock reference 与当前 claim 时点 | 随机 UUID、跨单、他人/非骑手、错阶段/类型、非图片、无媒体引用、旧承接照片拒绝 |
| 无法取证留痕而不豁免 | 专用接口创建 PICKUP_EVIDENCE_UNAVAILABLE 事件、异常案件和订单审计；同一承接重复上报不重复开案 | 并发上报仅一案；上报后无照片仍不能取餐；普通客服不能调用 rider 取餐接口 |

配置字段：`fragilePickupRecommendedMinor` / `fragilePickupRequiredMinor`，要求 `0 <= recommended < required`。本轮保留旧 SUPER_ADMIN 权限，不迁移 Root 或可扩展管理员体系。

冻结时点选择：在订单创建时冻结义务，取餐读取该快照，不读取最新后台阈值。这保证接单前看到的义务和取餐执行一致，避免创建后/承接后悄然改变要求。C 的有审计更正是单独的显式修正路径，正常订单仍使用原阈值。

金额口径是**已售商品行单价快照原价 × 数量的技术基准**；没有分摊整单优惠、配送费、红包或平台补贴。优惠分摊仍待产品确认，不能把此实现当作永久优惠规则。

`POST /delivery-tasks/:taskId/pickup-evidence-unavailable` 接收 reason。不能将它理解为完成取证、替代交接凭证或取餐豁免。普通案件 resolve 也不会改写订单的 REQUIRED 照片条件。

## 4. 阶段 C：已执行的行为

| 任务要求 | 运行时实现 | 验证 |
| --- | --- | --- |
| 未实际取餐的独立漏报拒取 | reportCatalogRisk 检查当前 ACTIVE assignment、CLAIMED 订单/任务、riderId、pickedUpAt；仅接收原快照未标核心的商品行及明确 CAKE/SUNDAE 声明 | 保管边界单测；取餐/送达后拒取失败；其他骑手、其他承接失败 |
| 免普通取消计数与释放容量 | 关闭原 assignment 为 ABANDONED，原因独立；清空任务 riderId/claimedAt，进入 RISK_REVIEW；不写 RiderCancellationEvent / RiderRestriction | 取消次数/限制均未增加；容量为 1 时释放后能 claim 另一单；重领后仅一条 ACTIVE assignment |
| 举报幂等及陈旧页面保护 | CatalogRiskReport.assignmentId 唯一；重复仅返回原记录，变更原请求内容返回冲突；旧 assignment 重试不能撤销新 rider 的承接 | 并发重复举报仅一份报告/事件；新 rider 承接后原请求重放不改变任务 |
| 更正前不可公开/claim | RISK_REVIEW 排除在 available 之外，claim 要求 OPEN；更正仍保持 RISK_REVIEW | 更正前及更正后未明确发布时 claim 都失败 |
| 同一原订单修正 | 商家确认举报类别后，只修改该商品标准类别与本订单风险快照，增加风险版本，记录前后审计；不改已售商品/名称/数量/单价/总价 | 已售内容、OrderPricing 完整对象保持一致；跨商家更正/发布失败；陈旧 revision 失败 |
| 明确发布、幂等及原窗口 | 商家 republish 检查 reportId、correctedRevision、当前 revision 和状态；不更新 firstPublishedAt/claimDeadline | 两次并发发布仅一条事件；原时间戳相同；原截止后不能公开/claim |
| 暂停期间仍能超时失败 | 复用 expireOpenDeliveryTask，允许 OPEN/RISK_REVIEW；sweep 纳入暂停任务；更正或发布时发现过期，也执行既有超时记账 | 举报 vs sweep、发布 vs sweep、未更正暂停单到期；退款事件仅一次 |
| 取餐与送达并发安全 | 新流程共享 Order → DeliveryTask 锁，不改既有 severe/dispute 锁顺序；释放容量由原 active task 查询体现，不写 rider 计数器 | 举报 vs pick-up 恰一条成功；已取餐举报 vs deliver 不能撤销保管关系 |

API 流程：

1. claim/mine 给当前责任骑手 activeAssignmentId；订单详情给 OrderItem.id。
2. `POST /delivery-tasks/:taskId/report-catalog-risk`：assignmentId、orderItemId、observedCategoryCode、reason，可附自己的同单 evidenceIds。
3. `GET /merchant/orders/:orderId/catalog-risk`：商家读取自己订单的报告与风险 revision。
4. `POST /merchant/orders/:orderId/correct-catalog-risk`：reportId、expectedRevision、deliveryCategoryCode；更正后仍暂停。
5. `POST /merchant/orders/:orderId/republish-corrected`：reportId、expectedRevision；原截止时间内才重新 OPEN。

`RISK_REVIEW` 是实际控制公开和接单的任务状态。Order 维持 READY_FOR_RIDER，意味着原交易仍等待履约；不能仅按这个订单标签认定它已公开。报告、风险更正、重新发布均保留事件与版本。

本轮没有新增商家单方“已交接”写入口，也没有把 PREPARING / READY_FOR_PICKUP 变成实物交接。商家备餐可取标记不会阻止举报；只有既有骑手确认取餐运行时改变保管阶段。商家不同意举报类别时，不自动判罚，也不绕过暂停恢复；可沿既有异常渠道提交事实供人工核查。完整交接主张冲突裁决、替代取证和放行权限仍待设计。已实际接货仍可走既有异常上报，但不能走本轮无条件解除承接路径。

## 5. 资金与历史安全

- claim 建立承接及金额快照，现有路径不 reserve 钱包余额。拒取关闭这份承接并释放持单；没有凭空创建资金冻结、收入或补偿。
- 同一原订单仍继续等待履约，已有 rescue / tip / subsidy 保留在原订单。专项测试确认拒取、更正、再承接不改 OrderPricing、商家补贴账户或其他已得 RiderSettlement；替代骑手承接同一保证收益。
- 如果未取餐状态意外已有本单 RiderSettlement 或赔付义务，安全拒绝新拒取路径，交由核查；不释放其他订单 reservedMinor。
- 超时使用原内部退款记账路径，不引入真实微信退款或新赔付义务。退款字段不代表支付渠道已到账。
- 不新增到店时间/交通补偿、商家罚款、自动账号限制或处罚。举报事实不等于已认定商家责任。
- 未重构四本账、earning 判定、严重异常赔付、商家初始配送款或历史财务迁移。

## 6. 迁移、Seed 与测试记录

新增迁移（没有编辑旧迁移）：

1. `20261010000100_catalog_delivery_classification`。
2. `20261010000200_fragile_pickup_evidence`。
3. `20261010000300_catalog_risk_correction`。

| 检查命令/过程 | 结果 |
| --- | --- |
| `pnpm db:generate` | 各 schema 阶段生成 Prisma Client 成功 |
| `pnpm typecheck` | A/B/C 均通过；最终 C 提交再次通过 |
| `pnpm test` | A 29；B 35；最终 C 37，13 个文件全部通过 |
| `pnpm test:integration` | A 82；B 91；最终 C 101，4 个文件全部通过 |
| `vitest run tests/integration/catalog-delivery.test.ts` | 最终新增分类/风险集成文件 24 项；A 5、B 累计 14、C 累计 24 |
| `vitest run tests/integration/catalog-delivery.test.ts -t 'releases capacity'` | 更正响应不暴露全局阈值的最终负向测试通过 |
| `vitest run tests/integration/catalog-delivery.test.ts -t 'preserves rescue'` | 原冷却条件满足后的救单/红包/补贴资金回归通过 |
| `pnpm build` | 各阶段通过；最终 C 提交再次通过 |
| `pnpm db:migrate` / `prisma migrate status` | 当前库 20 个迁移全部完成，无待执行迁移 |
| `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` | 当前库、空库、旧库升级后均 No difference detected / exit 0 |
| 独立空库 `pnpm db:migrate` | 从零执行全部 20 个迁移成功 |
| 空库连续两次 `pnpm db:seed` | 成功；语义摘要相同：users 6、merchants 1、products 2、orders 8、items 0、evidence 1、cases 0、平台类别 6、riderPayout 合计 1670 |
| 当前库连续两次 `pnpm db:seed` | 成功；之后最终集成测试仍通过 |
| 独立旧库 17 → 20 迁移 | 先部署原 17 个迁移，再插入旧商品、已售订单、FINALIZED Settlement 和历史 BusinessConfig；追加本轮 3 个迁移成功 |
| 旧库升级只读比较 | 原商品名/价、已售名称/单价/数量/小计、完整 OrderPricing、FINALIZED Settlement、历史 BusinessConfig 全部相等 |
| OpenAPI/角色 | 新路径可见；merchant/rider/SUPER_ADMIN guards、跨角色/跨归属失败和敏感字段负向测试通过 |
| `git diff --check` | 通过 |

旧库升级的实测输出：Product = UNKNOWN；OrderItem = UNKNOWN / reviewRequired=true / 单价6000 / 数量2 / 小计12000；旧 Order 取证版本0、NONE。没有用商品名或旧 AI 建议推测核心类别，没有回填历史金额/取证义务。既有 Seed 场景没有 OrderItem，所以空库 Seed 的 items=0；本轮 OrderItem 实际落库与金额聚合由真实下单集成测试验证，不把空 Seed 场景冒充该验证。

开发过程中修正了测试准备问题：UUID 类型检查方式、SQL UUID 参数转换、过期测试使用模拟未来时点以遵守数据库窗口约束、救单测试满足原冷却。最终所有上述完整测试通过，没有遗留失败或被阻塞的必要检查。

Docker 初检引擎未运行；执行一次安全 Docker Desktop restart 后 CLI 健康，PostgreSQL compose 服务 healthy。没有 factory reset、volume 删除或数据清理恢复。两个专用验证数据库已删除，临时旧迁移副本已逐文件和空目录清理；业务数据库保留。

## 7. 能力状态与未完成事项

| 分类 | 当前事实 |
| --- | --- |
| **enforced behavior** | 两套分类隔离、商家归属及版本校验、订单权威快照、严格合计阈值、创建时冻结、接单前风险 DTO、原验证码与强制照片引用并行、无法取证审计、不计普通取消的漏报拒取、暂停/更正/明确发布、原窗口过期、幂等与陈旧请求保护 |
| **data/telemetry available** | 原商品/商家分组快照、低风险 suggestedFoodType/handlingTags、分类来源/版本/置信度、Evidence 绑定和 authenticityVerified=false、举报声明/原风险快照/更正事件；这些都不自动判责或处罚 |
| **policy hook / placeholder** | DeliveryCategory 的稳定标识、版本和数据表可承载后续类别扩充；本轮没有管理员动态类别管理 API。Jev 真实网络 adapter 未接通，现有 deterministic/fallback 只产生建议 |
| **not implemented** | 真实相机/原始图片/存储端到端验证；取证替代凭证和有权限的例外放行；完整交接事实争议裁决；Root/新管理员认证及权限体系；真实支付、退款和提现；商家惩戒梯度、申诉期限、到店补偿、小程序 UI |

当前强制约束证明的是**后端 Evidence 记录与 Mock 图片引用符合本单、本骑手、本阶段、本次承接的条件**。`mediaValidation=MOCK_REFERENCE_ONLY`；没有证明实际拍到商品、图片内容完整或来自真实设备相机。服务端生成 Mock reference 与拒绝任意/跨单 evidenceId，不能等同真实媒体真实性验证。

优惠分摊、其他候选类目是否纳入核心组、强制照片无法取得时的替代方式与放行权限仍未决。没有替用户确定资金、处罚或身份新规则；交付后不自行进入其他阶段。
