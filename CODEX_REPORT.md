# CODEX_REPORT — 第八轮：商家自选每日商品恢复

日期：2026-10-12（Asia/Singapore）。仅执行 CODEX_TASK.md 第八轮 A → B → C，各阶段验证、普通提交及推送后才进入下一阶段。交付后端 API、后台运行路径和测试，无完整 UI 或生产部署声明。

## 1. 结果与提交

OWNER 可主动启用本店临时售罄商品每日恢复，默认关闭。平台有效默认为校园当地04:00，旧 SUPER_ADMIN 可版本化调整 HH:mm；后台也默认关闭。同一商家、同一本地日历日期最多成功执行一次，仅 SOLD_OUT→ON_SALE；不恢复 OFF_SHELF、不自动开店、不增加库存、不改价格/履约分类、已成立订单及财务。

| 阶段 | 实际完整 SHA | 结果 |
| --- | --- | --- |
| 同步前 | 0dfe2578c8ca5c5346b1c7704ab888b66e1b5468 | main干净，无未提交/未跟踪文件 |
| 开发起点 | dc43fb8a5645eddb59d0ef00fb815b21c8615b49 | fetch + merge --ff-only，同步第八轮任务 |
| A | 55fa60a0b813371269f9baac84c4b317841cad86 | OWNER偏好、有效默认、管理员时刻/CAS/审计、OpenAPI；普通push成功 |
| B | afa9cf6cd453a292c30c5443345162f6a35bcfa1 | 持久化日执行、整批事务/CAS、独立系统事件、后台循环及日期单调保护；普通push成功 |
| C / 实现验收终点 | b3c804d8122728e077e5e6f5c8e97fd0c93a25b8 | 完整兼容/并发验收，修正配置加载器及环境示例后台默认false，角色/专题文档；普通push成功 |

本报告在C成功推送后单独普通提交推送；报告提交由 `git log -1 -- CODEX_REPORT.md` 查询，避免自引用SHA。替换前确认第七轮报告与 `CODEX_REPORT_2026-10-12_MERCHANT_OPERATIONS.md` 正文一致（仅换行编码不同），归档正文未改。全程无force push、reset、丢弃工作或修改旧迁移，未创建PR。

## 2. 决策对照与四档状态

已读取主产品1C/1D、经营专题第6节、受影响角色职责、管理员旧权限边界及第七轮归档报告；按影响范围核对 IMPLEMENTATION_PLAN/AUDIT_FOLLOWUP 和 catalog、checkout、配置、Seed、后台代码。第1C/经营专题原“恢复触发待定/未实现”属于第七轮语境，已由主产品1D确认取代；历史正文和归档报告保留，追加第八轮实现状态。

- **enforced**：OWNER显式偏好/CAS/真人审计；平台HH:mm严格验证、配置CAS/审计；配置锁→商家锁→有序商品锁、逐商品version/status条件；商家×日期持久化唯一事实及单调游标；整批失败回滚/重试；SYSTEM/AUTO_DAILY系统事实；旧bool兼容、角色隔离、quoteToken和下单保护。
- **model/API支持、无完整UI**：偏好GET/PUT的请求/响应OpenAPI、有效默认来源/时区/版本和普通管理员时刻接口。系统事件已持久化可在数据库核验，无新增审计管理页面。
- **hook/placeholder**：未新增库存、每日开店确认、定时关店或支付hook/开关；没有把未来数量库存策略输入标成已执行。
- **not implemented**：真实支付/微信/商品款与配送费拆分实付、数量库存预留/扣减/付款失败释放/退款后恢复、库存耗尽自动售罄/补货、每日开店确认、定时或跨午夜关店、自动重开、真实商家48小时提现、工资提现及正式Root权限。

POST /orders仍仅创建CREATED开发合同/内账快照，不表示付款成功；佣金默认0和商家报价纯参考不变。当前商品没有真实数量库存，本轮没有添加数量或模拟补货；未来库存0保护仍是后续开发要求。旧异常/资金审计缺口不能由本轮回归推定全部闭合。

## 3. 要求到运行时与测试

| 要求 | 执行点 | 实际验证 |
| --- | --- | --- |
| A：主动开启、本店owner | Merchant独立偏好默认false/version0；锁内ownerId校验、expectedVersion CAS、无变化不加版/审计 | 默认、重复/无变化、并发200/409、陈旧重放、跨店、伪造绑定及角色负向测试 |
| A：平台时刻、默认态、权限 | PRODUCT_DAILY_RESTORE `{time:"HH:mm"}`；未配置04:00/version0/SYSTEM_DEFAULT，已有配置ADMIN_CONFIG；旧SUPER_ADMIN普通配置权限 | 无效时刻、额外字段、缺version、OPERATOR/非管理员拒绝；首次配置竞争、同值不重复审计；GET有效来源/时区和Swagger响应 |
| A：无自动副作用 | A只保存偏好/配置，未接入worker | A全套181项；营业事实及旧字段保持 |
| B：持久化同日多实例防重 | 商家排他锁、unique(merchantId,day)、最新成功日期单调保护；零变更也记录 | 双worker、独立PrismaClient、断开后新建客户端、同日轮询、关再开、改时刻、恢复后新人工售罄、日期回退 |
| B：系统来源、事务失败重试 | MerchantDailyRestoreRun存SYSTEM/AUTO_DAILY、配置/偏好版本、日期/时区/计划时刻/triggeredAt；ProductDailyRestoreAudit存旧新状态/商品新version，无User actor | 精确执行/事件断言；故意让第二条审计失败，第一商品/事件/执行行全部回滚，恢复后2商品成功重试 |
| B：销售三态、历史兼容 | SOLD_OUT行锁后逐商品version/status更新；旧trigger同步isAvailable | 下架/在售不变，其他商品全部字段不变；旧false、旧ORM写入前后竞态；HIDDEN/SUSPENDED曝光不恢复 |
| B：调度、后台门禁 | loop及worker均检查enableBackgroundJobs；校园本地日期/分钟；锁等待后live time及跨日复核 | 启用loop实际恢复；禁用loop和API无补执行；00:00/04:00边界、UTC不同日期、07:30配置、延迟/晚开启、等待跨日；真实loadConfig默认/显式true/false |
| C：人工/配置/报价/创建并发 | config→merchant→products，相容checkout config→merchant→catalog→locations | PG实际锁等待：偏好关闭先、配置写先、人工下架先、自动先→人工CAS/预览/创建、创建/价格读取先→自动、旧bool写先→自动 |
| C：原合同、资金、风险证据 | 自动仅更新销售状态/version/time及独立系统事实 | CREATED及确认/承接/FINALIZED快照、200分骑手内账收入保持；恢复后旧quoteToken409；6000分CAKE仍REQUIRED，缺照片取餐409，Mock照片后可送达 |
| C：迁移、Seed、全套回归 | 2条增量迁移、隔离验证脚本、原备份基准 | 下表完整命令；原49表完整字段指纹；旧false仍隐藏；启用偏好/执行/系统事件经重复Seed保持 |

新增daily-restore.test.ts最终20项；原178项全部回归，原商家21项中的生命周期用例增加确认、承接与FINALIZED时的实际系统恢复及完整角色响应核验。配置加载新增1项单元测试。没有把枚举/模型存在当成运行时证明。

## 4. 单次执行与工程边界

- 本功能“营业日”是校园时区的本地日历日期，不定义开店续签/强制关店。数据库day是DATE，04:00不是UTC04:00；校园时区默认Asia/Shanghai，与报告日期的Asia/Singapore分开。
- 未配置时有效默认04:00/version0，不插入虚构管理员版本。显式设置同样04:00仍可创建真实version1/审计；已有同值请求不新建版本，陈旧version仍409。
- 到点后首次成功sweep执行；BACKGROUND_SWEEP_INTERVAL_MS默认5000ms，可配置。不是毫秒精度cron，启动/锁等待会延后，实际triggeredAt留存。
- 只补当前日期：当天晚启用且已到点允许下次sweep执行；遗漏日期不逐日回补。首次成功前最近人工售罄可被恢复，首次成功后再次人工售罄保留；同日改时刻、关再开、重启不重跑。零变更也占用当日成功执行事实。
- 管理员配置写与worker用同一advisory lock；运行中批次采用锁定配置，后续配置只影响未执行日期。锁内重查偏好，关闭先提交则不执行；新启用未进入候选快照者等下次轮询。
- 每店整批事务；失败无部分商品变更/假完成，下一轮重试。此前成功的店保持已提交事实。单店失败结束当次sweep并记原后台错误日志，后续候选等待之后成功轮询；持续故障需修复，未承诺无条件漏跑完成。
- 手工API的商家/商品锁与CAS串行化，旧bool trigger继续生效。绕过现有商家锁的旧写入并发新增商品若不属于已锁定返回批次，不参加该次恢复；不凭新商品或未来库存增加数量。
- 商家锁等待后读实际时间；商品等待跨午夜或时刻回退则不创建记录/修改商品，等待后续合法轮询。最新成功日期阻止时钟/时区回退补历史日，各部署实例须采用一致campusTimeZone；无任意人工重跑或清除历史入口。
- C将真实配置加载器和.env.example默认改false；已有部署显式ENABLE_BACKGROUND_JOBS=true仍为true，运行原冷静期、到期池、结算扫描和恢复。未覆盖部署环境文件，未启动/重启生产服务。

## 5. 实际验证、失败与独立CI

全部集成测试指向campus_round8_test，未对应用库执行全局清理。

| 命令/验证 | A | B | C最终 |
| --- | --- | --- | --- |
| pnpm db:generate | 通过，Prisma6.19.3 | 通过 | 通过 |
| pnpm typecheck | 通过 | 通过 | 通过 |
| pnpm test | 18文件/55项通过 | 18文件/55项通过 | 19文件/56项通过 |
| pnpm test:integration | 8文件/181项通过 | 8文件/187项通过 | 8文件/198项通过 |
| pnpm build | 通过 | 通过 | 通过 |
| migrate deploy/status/diff --exit-code | 应用/旧副本/空库27迁移，无drift | 三库28迁移，无drift；既有字段指纹不变 | 应用/旧副本/全新空库28迁移，无drift；原备份49表一致 |
| Seed | 副本/空库首轮+连续2次，经营/财务/审计摘要保持 | 副本/空库各2次，主动启用偏好和实际执行/事件保持 | 旧副本再首轮+2次；全新空库首轮+2次，偏好/状态/version/执行/事件/财务摘要保持 |

实际回归40分钟池、短码/交接争议、易损证据、资格gate、容量/屏蔽、冷静期、退款冻结/赔偿、双侧报价/佣金0、费用/储备模拟。照片为现有Mock存储，200分收入为开发内账，都不是外部实付。

失败记录：A首次3项因接口/验证缺失失败；错误管理员ID夹具、窄字面量类型分别修正。A首次全套180通过/1失败，为定向运行残留种子偏好，改独立夹具；审查发现Swagger响应缺口，先RED后补schema，全套181通过。B首次4项因worker缺失失败，订单清理FK错误补齐；两项测试将关店409误预期为400、前一日期23:59合法补执行误预期为不执行，修正测试。一回定向与全套误并行同一隔离库，Seed和全套清理互撞，全套185通过/2失败；保留失败日志后串行重跑。日期回退发现真实缺口，RED→单调游标→GREEN，B最终187通过。C初轮197通过；最终审查发现既有loadConfig/示例后台默认true，真实加载测试先RED后改false；补跨店及SUSPENDED后最终198项全绿。上述不是Docker故障，没有隐瞒失败。

A/B/最终独立代码审查中的响应契约、日期回退、启动默认值问题均已验证修正并复核，无未处理的确认问题。审查不代替CI；对A/B/C实际完整SHA执行 `gh run list --commit ...` 均返回 `[]`，**独立CI验证不可用**。

## 6. 迁移、备份与原库事实

仅新增20261012000300_daily_restore_preference（默认关闭偏好/version/真人审计）和20261012000400_daily_restore_runs（日期执行/系统事件）。原26迁移未编辑；原bool trigger/CHECK保持并经真实写入验证，升级须migrate deploy。最终应用28条完成，无新失败/回滚；既有历史rolled_back记录未清除。

应用库只备份、增量迁移和只读核验，**未执行应用库Seed**。原两店保持营业/曝光/version，恢复偏好均false，234商品完整原字段不变，订单/账务/配置无修改。原库无false，故仅在旧副本升级前把茶bool改false：OFF_SHELF/version1，公共隐藏且Seed后仍保留；未写回应用库。

本机备份/日志：`C:\Users\Serena Lyric\AppData\Local\Codex\backups\campus-delivery-round8-20261012\`。

| 文件 | 字节 | 用途 |
| --- | --- | --- |
| round8-before.dump | 196060 | A前原应用库，恢复old及baseline成功 |
| round8-before-B.dump | 199829 | B前应用库 |
| round8-after.dump | 205904 | C验收后的28迁移应用库 |

初始备份SHA256：`5EA13C1CB2F33EF8384C6F355411E8613279B3FE88E203FA9BA763FFB90B171F`，容器/tmp副本保留。

原备份恢复campus_round8_baseline与最终应用库**49张全部既有业务表**对照：行数和完整JSON排序MD5一致。Merchant只排除本轮新增两个偏好字段，Product包含saleStatus、version、时间等全部原字段；迁移表独立检查。

| 原事实 | 行数 | 原备份/最终一致摘要 |
| --- | --- | --- |
| Merchant原字段 | 2 | 4973980091de8b41daff1fb8bfa61836 |
| Product完整字段 | 234 | 13eef5f7627560ff4194c16d0c8fef66 |
| Order | 2 | 9b6935a8651548297c673b7d1a2f7ce0 |
| OrderItem | 4 | 2dd0fb12e79585b5760a067936b9ec32 |
| OrderPricing | 2 | 102cbb332a80bb3abcaf68b9f3062c58 |
| DeliveryTask | 2 | 58a9e9d8a9693ac5c292cc96e7e3f0d9 |
| Settlement | 2 | e6626a51ace6235f319f03fb933e3bb1 |
| RiderSettlement | 0 | d41d8cd98f00b204e9800998ecf8427e |
| BusinessConfig | 2 | 1d4e463c53f7a4f38a5eb73cff0ea9b3 |

原库骑手收入为空，不能凭空表证明该路径；C实际履约生成FINALIZED及已得收入后核验自动恢复不漂移。test/old/empty/final_empty/baseline隔离库保留。Docker CLI健康，无重启、purge、删卷或重建应用库。

复核脚本：scripts/verify-round8-migrations.ps1（迁移/status/diff/全字段指纹）、apps/api/scripts/verify-daily-restore-seed.ts（只允许round8验证库；旧false API隐藏、真实恢复后重复Seed）。备份、环境文件及日志未提交。

## 7. 停止线

仅完成本轮A/B/C及报告。认证仍为既有开发x-user-id，未声称客户端/生产上线；数量库存、支付、每日确认/定时关店等保持未实现。报告与任务完成标记普通推送后停止，不自动续做后续开发。
