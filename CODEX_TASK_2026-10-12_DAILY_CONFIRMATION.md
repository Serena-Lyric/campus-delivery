# CODEX_TASK — 第九轮：商家每日营业确认与有效新单门禁（2026-10-12）

> **本轮已完成（2026-10-12）**：A/B/C均已独立全套验证、普通提交与推送；实际SHA、59项单测/216项PG集成、迁移/备份、非回溯切换策略和未实现范围见 [第九轮归档报告](CODEX_REPORT_2026-10-12_DAILY_CONFIRMATION.md)。下文保留任务编制时要求，不授权自动续做支付、库存或定时关店。
>
> 第八轮已完成（main结尾`cbb34fe5`），其原任务/报告分别已归档到`CODEX_TASK_2026-10-12_DAILY_PRODUCT_RESTORE.md`及`CODEX_REPORT_2026-10-12_DAILY_PRODUCT_RESTORE.md`，**不可当成仍未执行**。任务编制时要求先检查git status/diff、最新main、当前数据库/迁移/Seed、既有第七/第八轮商家与商品调度代码；按AGENTS.md读取 PRODUCT_DECISIONS.md第1C/1D/1E、MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md第8节、ROLE_RESPONSIBILITIES.md对应身份、涉及的catalog/checkout/admin配置及已知审核边界。旧归档仅在必要时定位实现事实。

## 0. 确认规则与禁止跨界

- 可选**每日营业确认**：商家默认不启用，继续使用旧手动开关店。启用后在**下一营业日**才开始执行确认门禁；停用**立即生效**，只解除门禁，不能隐式修改`isOpen`。平台统一本地切换默认`04:00`（项目campusTimeZone，默认Asia/Shanghai），管理员可修改，**单独新配置键**，不能复用/改写`PRODUCT_DAILY_RESTORE`。未来商家自定切换时刻只预留结构/服务接口扩展位置，本轮不开放。
- 营业日由**本地切换HH:mm定义**，默认04:00前仍属于上一营业日，04:00起属于新营业日；不同于第八轮每日商品恢复按校园自然日计算。**生效准入=手动isOpen + 当前营业日确认资格（或无需确认）+ 现有曝光/其他限制**，门禁必须在每次结账预览与订单创建时以服务器当前时间判断，不依赖后台job定时改isOpen，即使ENABLE_BACKGROUND_JOBS=false也必须执行。
- 本店OWNER主动操作「确认今日营业」或旧PUT`/merchant/operating-status`传`isOpen:true`视为当天确认，并同时使手动营业为true。**重要：原isOpen已经true而确认已过期时，主动同值PUT仍必须记录确认，不能在原no-op分支提前返回**；旧客户端仍能使用既有API。重复确认同日应幂等且审计准确，版本过期仍409。关店不清除当天确认，再开不要求重复确认。
- 当日未确认者即使isOpen还true也拒绝新单；商家目录/详情与本人GET应该提供一致的`acceptingOrders`、可读状态提示（顾客可见休息中；商家可识别“待今日确认”）、当前营业日及本日是否已确认；商品purchasable不能与有效店铺接单资格矛盾。休息/待确认仍正常展示菜单，HIDDEN/SUSPENDED继续隐藏。订单已建、已接单、已结算仍原样履约；不能以确认过期当作处罚、退款或商家违约。
- **不开**商家自动关店、后台自动开店、每日固定营业时间排班、为各商家单独配置时间、商品数量库存/原料、支付预留/微信支付/真收款/分账/提现。第八轮`PRODUCT_DAILY_RESTORE`商品恢复仍按已实现的时区/自然日/幂等规则独立运行，不能被本次配置污染；无真实客户端就明确仅后端API。
- 平台管理员中途修改切换时刻不得造成**已确认商家被当日追溯撤销接单权或已有订单失效**。此细节尚无额外商业选择：建议采用配置版本锁 + 自下一安全切换点起应用的新规则/持久化生效时间；工程阶段选择不回溯、可审计的办法，报告说明有效日期、凌晨边界与并发。如存在需新的产品决定才能避免重大行为冲突，暂停该子项并报告，不擅自选会当日追溯关店的行为。

## A. 独立营业日配置 + 商家可选偏好（先单独验证/提交）

1. 审计第八轮 `PRODUCT_DAILY_RESTORE`、`BusinessConfig`校验/CAS/审计/管理员权限；创建独立`MERCHANT_DAILY_CONFIRMATION`有效默认`04:00` + platform-config管理入口（保留expectedVersion/reason/审计，拒绝额外字段），普通SUPER_ADMIN临时运营配置，不扩充Root/支付权限。用校园IANA时区、测试03:59/04:00、午夜、跨日和可能的时区边界，避免把UTC04:00/自然日当切换时刻。
2. 商家独立偏好与版本/审计：默认关闭；启用仅从下一营业日切换时刻生效（保留明确effectiveAt/activationDay或等效数据）；关闭立即生效且不修改isOpen；再次开启仍按下一营业日。只能本店OWNER更改，不能商家指定其它merchantId。Seed迁移既有商家必须仍处原营业事实，历史审计/价格/Order等保持。
3. 提供本人GET/PUT偏好及有效营业日视图、平台配置时刻来源与时区，API/OpenAPI契约显式区分配置意愿、实际生效中、等待明日生效、当前确认状态。不要虚构现有真实UI。

## B. 今日确认、手动开店复用与同步门禁（A绿色后开始）

1. 设计商家×营业日**已确认事实**（含真实actor、事件来源EXPLICIT_CONFIRM或MANUAL_OPEN、确认时间、营业日/时区/切换时刻/策略版本），可在并发重复动作中幂等，绝不借用第八轮系统恢复审计伪造真人确认。若本日手动关店仍保留确认事实。显式确认API（例如POST`/merchant/confirm-business-day`）要在同一事务中合法记录确认并开店，受expectedVersion/必要审计保护；与原PUT手动开启共享一条确认业务函数，注意isOpen已true而确认过期的同值PUT。模式未生效时不应无意改变既定手动逻辑。
2. 更新`/merchants`、`/merchants/:id/products`、`/merchant/operating-status`、`POST /orders/price-preview`、`POST /orders`有效状态计算；catalog DTO的`operatingStatusLabel`和产品`purchasable`应与服务端订单准入一致。目录读取可高效批量读取配置/确认，无N+1失控；checkout依据同一服务器事实与数据库锁保护，防管理员改时刻、开关偏好、商家手动开关与下单竞态。旧quoteToken跨过营业日边界必须在创建阶段重新校验且拒绝尚未确认之店。
3. **不依赖背景调度**：营业日切换时间到就立即成为待确认，不直接更新`Merchant.isOpen`；后台循环即使关闭仍不能下单，打开确认模式不会中断当天现有营业。确认当日后再次手动关店（仍然待售/不可接单）及重新开店应可正确恢复接单。
4. 保留第七轮现有写入`expectedVersion`/CAS、无变化处理、状态版本及审计一致性，不通过不安全绕过跳过版本检测。人工开店和确认同事务，拒绝跨店/无权操作；旧代码/用户端初始默认不开确认，无差异表现。现有独立商品每日恢复任务不得确认开店。

## C. 实际回归、数据库升级、报告（B绿色后开始）

- PG并发与边界：两商家启用/未启用，普通在售与被HIDDEN/SUSPENDED，已经true却未确认的“开始营业”、确认即开店、当天关再开、次日过期、次日之前启用不生效、关闭立即生效且不自动开店、时刻变更/跨午夜/跨日/各实例锁顺序、重复确认及陈旧版本、无background jobs时过期拒单、quoteToken已预览过期拒单；商品自动恢复第八轮功能不能解除营业确认；拒绝额外字段/他店角色。
- 保留旧版`isOpen`和商品三态/`isAvailable`兼容，原有商品恢复198项集成基线、56项单测、订单池40分钟、学生资格、易损证据与交接争议、业务配置、报价/佣金0与费用模拟、订单和已FINALIZED财务事实不回写。
- 安全备份应用库后**在隔离测试库**进行测试破坏动作；新增Prisma增量migration不能修改旧migration，验证应用/旧库副本/空库迁移与重复Seed，避免用db push跳过旧Postgres trigger；保留原业务表及订单/金额/履约指纹。实际运行`pnpm db:generate`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm build`与migrate status/diff，记录红→绿及测试失败，不假报CI。
- A/B/C每阶段独立commit、实际全套验证及普通push；不中途强制重置/force-push、不误用生产库Seed、不制造真实资金；问题停止在上一已验证绿色阶段。完成后把本轮runtime对照/文档链接写入`ROLE_RESPONSIBILITIES.md`、`MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md`、`README.md`，覆盖`CODEX_REPORT.md`记录每步SHA、功能门禁、默认态、迁移/备份、可验证配置生效策略、UI缺口与未实施的每日自动关店/库存/真实付款。然后停止。

