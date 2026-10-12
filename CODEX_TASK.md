# CODEX_TASK — 第七轮：商家手动营业与商品售罄三态（2026-10-12）

> 用户已批准“逐步实现已确认的商家端决策”。这是**新的待执行任务**，第六轮仅为文档优化（完成commit `d450d6d`），第五轮财务安全任务与报告分别归档在 `CODEX_TASK_2026-10-11_FINANCE_SAFEGUARDS.md` / `CODEX_REPORT_2026-10-11_FINANCE_SAFEGUARDS.md`。从Git最新main安全同步，先检查status/diff/迁移；遵守`AGENTS.md`任务范围读取`PRODUCT_DECISIONS.md`第1B/1C节、`MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md`、`CATALOG_DISPLAY_AND_DELIVERY_CLASSIFICATION.md`及受影响的角色说明，不默认加载全部历史报告。

## 本轮边界和明确不做的事

- 只开发 **(A) 商家自主手动开关新单 (B) 售罄仍展示/下架隐藏/在售可买 (C) 兼容和回归验收**，按阶段分别测试、commit和正常push。可以新增非破坏性增量迁移与审计模型。
- **不要**开发本轮以外的每日确认定时器、跨零点自动关店、数量库存扣减/预留/释放、库存归零自动售罄、次日售罄自动恢复、商家定时自动重开、真实支付/拆分商品款与配送费、微信支付、48小时真实商家提现、Root新权限、管理员工资等。以上是以后阶段，其中库存预留/恢复及自动营业日触发具体实现条件未定。即使为将来预留schema，也**不得开放一个当前会超卖的库存开关**。
- 当前 `POST /orders` 仍仅创建 `CREATED`开发合同快照，**不是付款成功**。“用户先付款、商家后确认”是支付模块暂定方向，不允许偷偷改当前订单状态或虚构款项。
- 既有已创建/已确认、已承接订单及其`OrderPricing`、配送收益、风险证据、结算/赔付和历史订单快照不因关店或商品状态变更而改写。商家休息与平台`HIDDEN/SUSPENDED`仍是独立概念。

## A. 商家手动营业（先独立完成）

1. 审计 `Merchant.isOpen`、`GET /merchants`、`GET /merchants/:merchantId/products`、`readCheckoutFacts`、相关路由与商家owner绑定。现有`isOpen`为布尔且checkout已拒绝关店；优先复用，不另建相互矛盾的第二个营业真相。
2. 增加**仅本店OWNER商家账号**可读取和变更开/关状态的安全API（例如`GET/PUT /merchant/operating-status`），采用`expectedVersion`/CAS与事务行锁、独立操作审计（旧→新、actor、时间及必要原因）。创建时现存`isOpen=true`不应被新migration或Seed静默颠倒。请求不得篡改merchantId/ownerId、其他店铺或风控曝光状态。无变化/重复请求应明确安全处理。
3. 用户商家列表/详情清楚给出是否接单以及「休息中」状态标签，休息中仍可进入详情浏览菜单；平台隐身/暂停商家仍按现有曝光策略不可见或不可下单，**不能因为休息中继续展示而展示被HIDDEN/SUSPENDED的店**。若当前只有API没有完整小程序UI，交付API状态/标签及测试，**不要声称前端标签已经上线**。
4. `POST /orders/price-preview` 与 `POST /orders` 的营业检查必须在和营业变更兼容的同一数据库并发保护下执行。按既有锁顺序 config→merchant→catalog→locations，避免升级后新增死锁；旧预览token不能用于关闭后创建；已创建订单不因关店自动撤销。
5. 不改变商家风险曝光/处罚、开店资格、已有履约状态。休息不计违规或产生自动处罚事件。

## B. 商品售罄、在售、下架（A绿色后开始）

1. 先审计当前 `Product.isAvailable`、`GET /merchant/catalog`、`GET /merchants/:merchantId/products`、`saveProduct`、商品`version`、`readCheckoutFacts`及风险分类。新商品销售状态必须可靠区分：**在售可见可买**、**已售罄可见不可买**、**已下架对普通用户不可见且不可买**。状态可用枚举或等价受约束表示，避免两字段组合形成矛盾。
2. 历史兼容至关重要：旧`isAvailable=false`被公共API隐藏，迁移时应保留它作为**已下架**而非已售罄；旧`isAvailable=true`是**在售**，不能批量翻成售罄，也不能更改历史订单快照。审查旧API/Seed/客户端使用`isAvailable`的行为，提出最小兼容方案并以集成测试证明无旧数据可见性漂移。
3. 商家本店可快捷修改售罄/恢复在售/下架状态，复用商品`version` CAS或等价安全保护，严格校验owner并留必要审计。**不要把每次售罄操作做成完整商品编辑，意外重写商品履约风险、类目、价格、图片**。原完整编辑端点必须兼容并与新状态保持一致；按产品状态保护用户与骑手角色数据。
4. 公共菜单显示在售及售罄商品，售罄返回明确状态及「已售罄」标签/不可买字段；下架隐藏，店铺休息时仍展示这两类但都不能下单。商家自己的菜单则应能管理三类。服务器预览及创建严格拒绝售罄/下架商品，沿用商品行锁、版本/quoteToken确认流程，防并发售罄与创建；不允许单靠按钮禁用。
5. 商品本身的**手动售罄优先**；本轮不开放数量库存、自动补货/恢复开关，不自动改变`DeliveryCategory`、核心易损取证规则或正在履约订单的商品快照。

## C. 验收与报告

- 回归场景至少覆盖：商家本人开/关、越权修改其他商家拒绝、客户端额外字段拒绝、并发两次改店及改店→订单/订单→改店、关店期间目录可看菜单但下单不可用、恢复营业后恢复可买、风控HIDDEN/SUSPENDED仍不可见；在售/售罄/下架三态、历史false迁移保留隐藏、并发售罄vs报价/创建、旧客户端/Seed读写兼容、跨店状态隔离、原有易损商品强制取证不被绕过。
- 原40分钟接单池、商家短码、交接争议、学生资格gate、个人商家屏蔽、用户冷静期、退款冻结、双侧报价和佣金0/平台支付费用模拟均保持回归；不以暂停营业取消既有单或修改既有财务。
- 逐阶段实际运行 `pnpm db:generate`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm build`。新schema需增量migration，验证应用库/旧库副本/空库升级与重复Seed，迁移前安全备份，不修改已应用migration，不reset/purge生产或应用DB。Docker异常遵守AGENTS一次安全恢复上限。
- 每阶段独立普通commit/push，完成一阶段才进入下一阶段；如代码设计与当前合同/历史兼容矛盾无法安全解决，停止此阶段并记录缺口，保持上一个绿色状态。禁止force push/reset丢弃工作。
- 更新 `CODEX_REPORT.md` 给出每阶段commit SHA、实际测试与迁移/备份结果，区分**enforced / model或API支持但无UI / hook / not implemented**；尤其每日确认、可选库存、自动售罄、次日恢复、分开支付都不得谎称已实现。本轮完毕即停，不自动启动后续库存/自动营业开发。
