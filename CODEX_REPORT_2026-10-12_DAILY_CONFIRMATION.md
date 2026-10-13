# CODEX_REPORT — 第九轮：商家每日营业确认与有效新单门禁

日期：2026-10-12（Asia/Singapore）。仅执行 CODEX_TASK.md 第九轮 A → B → C，每阶段实际验证、独立提交和普通 push 后才继续。交付后端/API、OpenAPI、迁移及测试，无完整客户端或生产部署声明。

## 1. 结果与实际提交

每日营业确认与手动 `Merchant.isOpen` 独立。默认不启用，启用从下一实际营业日要求确认；关闭立即解除该门禁，两者都不改 isOpen。默认校园当地04:00切换，03:59和午夜仍属前一营业日。未确认者保留菜单及原手动状态，但商品不可买、预览/新单拒绝；**ENABLE_BACKGROUND_JOBS=false仍执行**。显式确认和已启用模式下的主动手动true同事务确认+开店，已有true也能补确认；重复同日幂等、陈旧版本409、关店保留当天确认。

| 阶段 | 实际完整 SHA | 状态 |
| --- | --- | --- |
| 同步前 | cbb34fe55d186f356ffc1f01e7e038ec4d714db1 | main干净，无未提交/未跟踪源文件 |
| 开发起点 | 1d48e1f98c996c8427b8f09cb729a0376295e42c | fetch + merge --ff-only同步main和第九轮任务 |
| A | 8947ac5489989c59c23db7fa76473d17a15c6d2c | 独立配置、营业日计算、OWNER偏好/CAS/审计/读接口；全套绿色后普通push |
| B | b71dcc0c9530eca61c979784748c0b1ac9773289 | 真人日确认、手动开启共享事务、目录/checkout同步门禁；全套绿色后普通push |
| C / 实现验收终点 | 2512206a3f34ce5810dcdefd896dfe8845bcab13 | 并发/边界/旧单兼容、数据库验证及角色/专题/README；全套绿色后普通push |

报告与任务完成标记在C成功推送后单独作普通文档提交；其SHA由 `git log -1 -- CODEX_REPORT.md` 查询，避免自引用。没有force-push、reset、丢弃工作、PR或修改旧迁移。第七/八轮未被当作未执行重做，第八轮既有任务/报告归档正文未改。

## 2. 决策对照与四档状态

读取并核对主产品1C/1D/1E、商家经营专题8及必要历史5/7、受影响角色、管理员旧权限边界、IMPLEMENTATION_PLAN/AUDIT_FOLLOWUP相关范围和现有catalog/checkout/配置/Seed/后台。1E补足1C营业日待定部分；1D及第八轮恢复自然日规则独立保持。当前派生角色文档纠正“每日确认未开发”，历史专题/报告保留；主产品只更新报告引用与实现状态，没有新增商业规则。

- **enforced behavior**：OWNER隔离、strict输入、偏好/营业CAS、平台时刻版本/审计、次日生效/立即停用、确认与开店原子提交、同日幂等/陈旧拒绝、目录/商品可买性、锁后实时预览及创建前准入、跨日旧报价拒绝、旧单继续履约。
- **data/API available**：enabled/active/pendingActivation、最早生效阈值、营业日起点/下次切换、当前确认、有效/待生效平台配置；真人来源、日期/时区/时刻/有效策略版本/营业版本/确认时间/原因持久化。新增接口与本人营业视图有响应OpenAPI，无完整商家/管理小程序或审计页面。
- **hook/placeholder**：未来单店时刻仅保留计算函数的时区/HH:mm参数扩展点，没有单店配置入口或未使用的策略字段；没有库存/支付/自动关店开关。
- **not implemented**：定时自动关店/自动重开/固定排班、每店自定时刻、数量库存/原料/预留/扣减/释放/退款后恢复、微信/可信真实付款/拆分实付/分账/提现、真实商家48小时控制、正式Root和完整客户端。

`POST /orders`仍是CREATED开发合同及内账快照，不证明付款。佣金默认0、商家基础报价纯参考不等于商家出资、开发结算不等于外部现金。历史异常资金审计未闭合事项不能因本轮回归被宣称全部完成。

## 3. 编号要求到运行时与验证

| 要求 | 运行时执行点 | 实际验证 |
| --- | --- | --- |
| A1：独立配置/默认/权限 | MERCHANT_DAILY_CONFIRMATION，未配置04:00/version0/SYSTEM_DEFAULT；time-only输入、expectedVersion/reason/审计、独立配置锁 | 非法HH:mm、额外字段/缺版本、OPERATOR拒绝、首次竞争200/409、同值不重复审计；PRODUCT_DAILY_RESTORE完整字段不变 |
| A1：本地营业日 | businessDayInterval按IANA本地切换，不按UTC04:00/自然日 | 03:59.999/04:00、00:00、不同UTC日期、年末、洛杉矶、纽约DST缺口/重复分钟 |
| A2：偏好/生效/所有权 | 3字段默认false/0/null；配置锁→本店锁，启用保存下一边界阈值，active按实际日起点，停用立即解除且不改isOpen | 启用/次日/再启用、关闭时原店仍关、并发CAS/同值/陈旧、他角色/字段注入/服务伪造绑定；升级和重复Seed保留旧事实 |
| A3：视图/契约 | GET/PUT /merchant/daily-confirmation显式DTO区分意愿、生效、等待、当前日/确认及平台有效/待生效配置 | 请求/响应和Swagger字段、默认/管理员版本与时区；未虚构UI |
| B1：真人事实/同事务开店 | MerchantBusinessDayConfirmation唯一(merchantId,businessDayStartsAt)，EXPLICIT_CONFIRM/MANUAL_OPEN、真实owner actor，共用commitOperatingStatus | 显式/同值true、两独立PrismaClient竞争、重复/陈旧、关再开、次日新事实；强制确认或营业审计写失败均回滚后可重试 |
| B2：同步目录/checkout | 列表批量读确认；详情/本人状态；readCheckoutFacts锁后实时读、createOrder写合同前再次校验 | 顾客休息/菜单保留、本人待确认、purchasable一致；HIDDEN/SUSPENDED不能解除；旧quote跨日拒绝；config/merchant/product等待各覆盖preview/create共6组 |
| B3：无后台依赖 | 通过服务器实时日资格计算，未加入background任务、不定时改isOpen | jobs=false的真实buildApp在04:00拒绝；两店启用/未启用；停用后开店可买/原关闭店仍不可买；商品恢复实际执行仍不确认且拒单 |
| B4：旧CAS/审计/订单兼容 | 默认未启用的旧手动no-op保持，补确认可有true→true审计并增加营业版本；订单确认不是营业确认 | OWNER/版本/无变化/重复事实；真实PG确认先/停用先→checkout，已准入创建先→关店；旧单确认/照片/配送/FINALIZED继续 |
| C：全套/升级/报告 | 原198集成保留，新增18日确认；原56单测加3营业日 | 下表全部命令、升级/Seed、原52表指纹；独立只读审查及实际CI查询 |

第九轮PG18项全部通过，原198项均回归，其中保留原第七轮178项、40分钟订单池、学生资格、商品三态/旧false trigger、易损证据和交接争议、冷静期、骑手冻结/异常资金、业务配置、报价/佣金0/费用及储备模拟。确认新增批量读取没有增加每店确认N+1，原风险摘要读取方式保持。

## 4. 时刻过渡、准入与幂等边界

1. 营业日04:00前属前日，04:00起新日。身份用实际UTC起点，日期标签为起点的校园本地日期；第八轮恢复继续按校园自然日期。确认事实不因关店/停用而删除或改写。
2. 平台只接受HH:mm，服务器生成timeZone/effectiveAt/transitionDayStart和前一有效策略快照。改时延长当前日到“当前公布下一边界”与“新时刻下一边界”较晚者，修改瞬间不撤销旧确认；pending替换不提前已公布边界。版本/审计保留，configuredVersion不冒充当前有效version。
3. 生效首个区间从实际effectiveAt开始，随后按新时刻；首个过渡区间可能长于或短于24小时，同一本地日期标签也可能对应不同实际起点，故唯一键用实际起点。已验证04→08、08→02、反复pending替换及跨午夜/跨日；这是任务授权的安全工程策略，不是固定排班规则。
4. 例如已确认10月13日04:00起的店在中午改08:00：当前确认延续至10月14日08:00（UTC10月14日00:00），不会10月14日04:00先撤销。08→02在中午设置时，首日从已公布的次日08:00起，之后按02:00；视图显示实际起点与下次切换。既有订单始终不受回写。
5. 商家effectiveAt是启用时最早下一切换资格，后续改时不回写偏好历史。active要求当前实际日起点达到阈值；平台延长当前日时不会在原阈值到达而中途停单。pendingActivation/nextBusinessDayStartsAt识别实际等待。停用立即解除门禁，两者都不自动开店。
6. 显式确认即主动开店；已启用（含待生效）模式的人工true记录今日确认，未启用模式旧同值请求仍无副作用。同日保留首次真实actor/来源/原因，不覆盖来源；关/开可有新营业审计，无重复日事实。重复操作也先检查当前营业expectedVersion。
7. checkout锁顺序：定价配置→确认配置→商家→有序商品/类别/位置；确认/偏好：确认配置→商家。共享配置锁与管理员独占锁串行，商家锁与人工经营/第八轮恢复相容。等待后重新取服务器时间；确认跨日写入则事务409回滚。读确认过程中跨界会重读，连续变化最多3次后409刷新。
8. 创建准入点是取得所需锁、写合同前的最后一次实时校验；已准入事务可之后提交，后排关店不能撤销旧合同。真实Order表锁等待与排队关店证明这一顺序。未把订单成立改为提交瞬间重新定义，也未改变付款时机。
9. DST重复时刻取首次，缺失时刻取其后首个有效分钟。实例须统一校园时区和同步可信时钟；已有配置timeZone不匹配拒绝请求，不开放普通时区迁移。反复管理员改时可延长过渡日，产品无时长/次数上限，本轮不自行添加。

## 5. 实际验证、失败、审查与CI

破坏性测试只用campus_round9_test，没有应用库全局清理或Seed。

| 命令/检查 | A | B | C最终 |
| --- | --- | --- | --- |
| pnpm db:generate（Prisma6.19.3） | 通过 | 通过 | 通过 |
| pnpm typecheck | 通过 | 通过 | 通过 |
| pnpm test | 20文件/59项通过 | 20文件/59项通过 | 20文件/59项通过 |
| pnpm test:integration | 9文件/201项通过 | 9文件/204项通过 | 9文件/216项通过 |
| pnpm build | 通过 | 通过 | 通过 |
| migrate deploy/status/diff --exit-code | 应用/旧副本/空库29条，无drift、旧字段指纹保持 | 三库30条，无drift、包括A字段/事实保持 | 三库30条；原28条新副本+全新空库升级30条，无drift、原表指纹保持 |
| Seed | 副本/空库首轮+2次，偏好/销售/审计/财务保持 | 两库各2次，新日确认事实保持 | 原备份新副本/新空库首轮+2次，旧false隐藏、新确认/恢复事实保持 |
| diff/范围/引用 | A检查 | B检查 | 整轮1d48e1f..C及staged diff-check通过，旧迁移/第八轮恢复模块/后台/第八轮归档无差异 |

失败与修正记录如下，未算作成功。保留的独立失败日志及末次执行日志归档到execution；未单独保留的早期覆盖输出可查本次聊天工具记录：

- A先红：3项单测缺营业日函数、3项PG缺偏好/严格新配置。实现后缺版本夹具误让undefined走默认0，修为真正省略请求字段；TypeBox未注册date-time导致存储校验拒绝，改严格ISO/有限日期校验；pending替换预期改为不提前已公布边界，定向6项绿色。
- A首次migration diff失败：PostgreSQL截断长索引名；Prisma map对准实际名称，**未编辑已应用迁移**，后续三库及fresh验证无drift。
- A两次全套各198通过/3失败，资格定向13通过/3失败：既有并发事务P2028，源于临时容器仅绑IPv4却用localhost。最小两个并发事务也复现，127.0.0.1后同时成功，全套201通过。未改资格业务或放宽超时。一次generate与测试并行遇Windows引擎DLL EPERM，停止测试后顺序生成通过，后续按顺序执行。
- B先红3项：过期仍可预览、同值true跳过确认、显式接口404；实现后定向6/全套204绿色。
- C初期17通过/1失败：履约夹具硬编码handoff revision改为读取实际版本；再次失败显示照片被INVALID_PICKUP_PHOTO正确拒绝，因为注入次日服务器时钟与PG DEFAULT now()不一致。在隔离夹具中把照片时间对齐注入承接时间，未改生产取证。另有辅助payload exactOptionalPropertyTypes错误，改省略undefined。最终定向18/全套216绿色。时间边界用注入Date和真实PG锁，照片仍为现有Mock，200分收益仍为开发内账。

独立只读审查覆盖起点至B及C工作差异，未发现确认成立的Critical/Important缺陷；三处脚本空白使整轮diff-check失败，C清理后通过，无未处理/延后问题。审查未编辑代码/数据库，不代替执行或CI。

对A/B/C完整SHA实际执行 `gh run list --repo Serena-Lyric/campus-delivery --commit ... --json databaseId,headSha,status,conclusion,url`，均为 `[]`。**独立CI验证不可用**，本地验证和代码审查不是CI。GitHub读取用agent-reach的GitHub/gh路径，没有发送消息或发布PR。

审查保留的工程判断：过渡日延长/反复改时不增加产品未确认的上限；时区迁移/时钟同步为部署前提；准入按最终锁内校验而非提交瞬间；支付/库存/自动关店/客户端/Root/历史资金缺口不扩做；执行和CI需另取证。若以后改变这些边界，需新的规则/版本策略，不改历史事实。

## 6. 迁移、备份和原应用事实

仅新增 `20261012000500_daily_confirmation_preference`（3个默认关闭字段/真人偏好审计）和 `20261012000600_business_day_confirmation`（真人来源枚举/实际营业日事实/唯一键和索引）。原28迁移未改，没有db push、清迁移历史或重复迁移；应用30条完成，旧rolled_back记录保留，status/diff干净。

应用只备份、增量迁移及只读核验，**未执行应用Seed**。原两店isOpen=true/operatingVersion0、商品恢复偏好false/version0；新增确认偏好false/version0/null。234商品和既有订单/配置/履约/金额保持。

原备份恢复campus_round9_baseline对照最终应用：**52张全部既有业务表**行数及完整排序JSON MD5一致。Merchant只排除新增3字段，包含第八轮全部旧字段；Product含全部状态/版本/时间。迁移表单独status核验。

| 原事实 | 行数 | 原备份/最终一致指纹 |
| --- | --- | --- |
| Merchant原字段 | 2 | cc833a54d4e073ba56bd7c7114c49140 |
| Product全字段 | 234 | 13eef5f7627560ff4194c16d0c8fef66 |
| Order | 2 | 9b6935a8651548297c673b7d1a2f7ce0 |
| OrderItem | 4 | 2dd0fb12e79585b5760a067936b9ec32 |
| OrderPricing | 2 | 102cbb332a80bb3abcaf68b9f3062c58 |
| DeliveryTask | 2 | 58a9e9d8a9693ac5c292cc96e7e3f0d9 |
| Settlement | 2 | e6626a51ace6235f319f03fb933e3bb1 |
| RiderSettlement | 0 | d41d8cd98f00b204e9800998ecf8427e |
| BusinessConfig | 2 | 1d4e463c53f7a4f38a5eb73cff0ea9b3 |

原收入空表不证明收益安全；C在隔离库实际完成易损配送/FINALIZED/200分内账后，确认、关店、偏好切换和次日确认均不改完整订单/资金/履约快照。原库无false，故仅在副本构造：A副本迁移后旧bool写false；C重还原28条备份、升级前写false，升级/重复Seed后OFF_SHELF及隐藏保持，未写回应用。

备份/日志：`C:\Users\Serena Lyric\AppData\Local\Codex\backups\campus-delivery-round9-20261012\`。

| 文件 | 字节 | 用途 |
| --- | --- | --- |
| round9-before.dump | 205904 | A前28条原应用，恢复baseline/旧副本成功 |
| round9-before-B.dump | 209976 | B前29条应用 |
| round9-after.dump | 214037 | C后30条应用 |

初始SHA256：`AAA6037E2E2158D6110435FAEEB98A64DFD94E507C52BE101435CE088CE495D8`；最终：`36E009B646C113E4EAA7B2E4137982A5D8A1AA58B1A6E3D719D19F966DE5EF44`。阶段history JSON/original-comparison保存，执行日志/审查账本归档到execution；环境、备份、日志未提交。

复核脚本：`scripts/verify-round9-migrations.ps1`（deploy/status/diff/逐表指纹，FromRound8支持旧备份新副本）及 `apps/api/scripts/verify-daily-confirmation-seed.ts`（限命名隔离库，旧false隐藏、真实夹具恢复/确认和重复Seed）。test/old/empty/final_old/final_empty/baseline隔离库保留。

## 7. 基础设施与停止线

起初docker info无法连接、Desktop未运行；仅一次安全Desktop启动后CLI健康（29.8.0）。原PG容器已停止，Windows保留5358..5457端口包括5432，启动绑定失败。确认原容器一直exited后，临时campus-round9-postgres独占挂载原campus-delivery_postgres-data卷，以127.0.0.1:55439运行PostgreSQL16.15，验证客户端明确IPv4。没有purge/reset、删数据目录/卷或重建应用库；最后备份/验证后停止临时容器，原容器保持初始停止状态。5432限制仍需本机环境处理，未改应用.env或生产配置。

仅完成A/B/C及报告；认证仍为开发x-user-id，未重启/部署生产API、未替所有商家启用模式。报告/完成标记普通推送后停止，不自动续做库存、支付或自动关店。
