# CODEX_REPORT — 第七轮商家手动营业与商品三态

日期：2026-10-12（Asia/Singapore）。仅执行 CODEX_TASK.md 第七轮 A → B → C；各阶段验证、独立提交并正常推送后才开始下一阶段。本轮不启动库存、营业调度或支付开发。

## 1. 结果与提交

本店 OWNER 可手动开关新单接收、切换商品在售/售罄/下架。休息菜单保留，售罄展示不可买，下架隐藏；预览和创建在数据库并发保护下拒绝不可购买状态。历史false仍隐藏，关店/售罄不改已有订单、资金或履约事实。交付为后端 API 与验证，无完整前端或生产部署声明。

| 阶段 | 实际完整 SHA | 结果 |
| --- | --- | --- |
| 同步前 | d450d6d8571794a0f004cbdebc23a12dc9ed9d27 | main工作区干净、无未提交/未跟踪文件 |
| 最新main / 开发起点 | c7744f42112a835466070babc6327b63ad2cbd94 | fetch + merge --ff-only，同步第七轮任务 |
| A | bb7b15d744f448c909b7ebbdaea9468efb611003 | OWNER营业API、CAS/锁/审计、休息目录、Seed不重开；普通push成功 |
| B | 5586db0475781bdc6e224079627dd7fd857d1cc3 | 三态、旧bool兼容、快捷状态审计、菜单/checkout、完整编辑输入拒绝；普通push成功 |
| C / 实现验收终点 | a096bc4e0a127031e70bab066103fa762c79cce2 | 生命周期/旧写入/报价竞态、迁移/Seed验收与角色文档；普通push成功 |

本报告在C成功推送后单独提交并普通推送。报告提交由 `git log -1 -- CODEX_REPORT.md` 查询，避免文件自引用SHA。替换前确认第五轮报告与现存归档 `CODEX_REPORT_2026-10-11_FINANCE_SAFEGUARDS.md` 正文完全一致；归档未改。

A/B/C均已推送origin/main，无force push、reset、discard、提交历史重写或已应用迁移修改。没有另建分支/PR。

## 2. 决策对照及四档实现状态

读取主产品1B/1C、经营专题、货架/履约分类专题、受影响角色职责和本轮任务；按影响范围核对 IMPLEMENTATION_PLAN / AUDIT_FOLLOWUP、管理员权限边界。

- **enforced**：OWNER手动营业和商品三态；休息保留正常曝光菜单但拒绝新单；售罄展示不可买、下架隐藏；历史false保持隐藏；CAS/锁/独立审计；新状态不回写原订单。
- **model/API支持、无完整UI**：中文营业/售罄标签及 acceptingOrders/purchasable、本店catalog三态管理；不声称前端标签已上线。
- **hook/placeholder**：本轮未新增库存、营业日或支付hook/开关，避免模型支持被误当成已执行能力。
- **not implemented**：每日确认、定时/跨午夜关店、自动重开、数量库存预留/扣减/释放、自动售罄、次日恢复、真实支付/拆分收款/微信支付、真实商家提现、Root新权限、管理员工资。

拆分付款仍暂定且未实现；POST /orders仍只创建CREATED开发合同快照，不代表付款成功。佣金/报价/费用模拟规则未改，没有实际付款事实或新增资金授权。经营专题编制时的缺口和旧货架能力快照保留历史，加实现补记；第五轮引用改指归档，没有新增产品规则。不从本轮回归推定其他旧审计/异常缺口已全部闭合。

## 3. 编号要求到运行时及证据

| 要求 | 执行点 | 验证 |
| --- | --- | --- |
| A1 | 单一Merchant.isOpen、认证绑定，事务内再按ownerId校验 | 默认/越权API、C伪造绑定服务测试 |
| A2 | GET/PUT /merchant/operating-status；merchant FOR UPDATE + operatingVersion CAS；旧→新/actor/reason/time审计 | 双写200/409；陈旧重放409；同当前版本无变化changed:false、不加版/审计；额外字段400 |
| A3 | 列表/详情返回休息/接单标签；HIDDEN/SUSPENDED独立过滤 | 休息菜单可看；隐藏/暂停店开关不恢复曝光；完整公共响应负向断言 |
| A4 | checkout沿用config→merchant→catalog→locations共享锁，与营业写互斥 | PG锁等待证明：关店先→preview/create拒绝；create先→关店等待且旧单保留；preview先→关店等待；关闭后旧token拒单 |
| A5 | 营业写仅isOpen/version及独立审计 | 不生成曝光处罚；CREATED及C已确认/承接/结算事实不变 |
| B1 | ON_SALE/SOLD_OUT/OFF_SHELF枚举；触发器与CHECK保证bool一致 | 三态公共菜单、预览/创建拒单测试 |
| B2 | true→ON_SALE、false→OFF_SHELF，旧version/time不改；保留bool投影 | 升级副本false仍version1且API隐藏；原库47表原字段指纹一致；旧bool创建/编辑/ORM写入 |
| B3 | PUT /merchant/catalog/products/:id/sale-status；merchant SHARE→product UPDATE→CAS→审计 | 跨店409、非MERCHANT403；额外/价格/风险/库存字段400；双写200/409；无变化不重复事件；其余全部商品字段不变 |
| B4 | 公共仅过滤OFF_SHELF，saleStatusLabel/purchasable合并营业；checkout只许ON_SALE | 休息两类菜单可看不可买；开店不恢复商品；改商品版本后旧token失效；PG售罄→preview/create及create/preview→售罄竞态 |
| B5 | 无数量库存/自动恢复开关；状态写不改履约分类 | CAKE6000分旧单在关店/售罄/下架后仍REQUIRED：缺照片取餐409，上传Mock照片引用后能继续取餐送达 |
| C | 新文件21项、原全套回归、隔离库/备份核验 | 下表实际命令；CREATED、confirmed、claimed、FINALIZED及骑手已得内账收入不因状态切换改变 |

营业、快捷状态和完整商品编辑均先校验原始body，防Fastify静默剥除未知字段。旧完整编辑仍用isAvailable：true恢复在售，在售改false下架；售罄本已false时相同false保持售罄，要明确下架则用三态接口。完整编辑实际改状态记LEGACY_EDIT审计，快捷记MANUAL_STATUS；快捷无变化不加版，完整编辑沿用既有编辑加版语义。

仅在售的isAvailable=true；售罄和下架均false。无完整客户端可验证；旧客户端若自行过滤false可能不显示售罄，未来客户端应按saleStatus/purchasable展示，不声称旧UI已经支持新体验。

## 4. 实际测试与失败记录

所有集成测试均在 `campus_round7_test` 隔离库运行，没有对应用库执行全局测试清理。

| 验证 | A | B | C |
| --- | --- | --- | --- |
| pnpm db:generate | 通过，Prisma6.19.3 | 通过 | 通过 |
| pnpm typecheck | 通过 | 通过 | 通过 |
| pnpm test | 18文件/55项通过 | 18文件/55项通过 | 18文件/55项通过 |
| pnpm test:integration | 7文件/167项通过 | 7文件/174项通过 | 7文件/178项通过，新文件21项 |
| pnpm build | 通过 | 通过 | 通过 |
| migrate deploy/status/diff --exit-code | 应用/旧副本/空库通过 | 三库通过、无drift | 应用/旧副本/全新空库通过、无drift |
| Seed | 副本/空库各连续2次；测试保留关店/版本 | 副本/空库各2次并核验保护摘要 | 全新空库首轮+重复2次；旧副本再2次，摘要保持 |

完整回归覆盖40分钟池、短码、商家取餐/交接争议、核心易损/漏报纠正、资格gate、容量/黑名单、冷静期、退款冻结/赔偿、双侧报价、佣金0及费用/储备模拟。C按已有流程模拟合法履约完成，后续关店/状态变化不会改变FINALIZED结算和200分骑手内账所得；不等于外部实付。

实际失败：A最初7项因API未实现失败、B最初4项因三态未实现失败，随后红→绿。A前两轮全套各1项旧TRIAL目录计数失败，因新夹具残留及运行顺序，补清理后全绿。B补完整编辑额外字段测试先见201而非400，首轮全套亦记录该1项失败，补校验后全绿。C初次生命周期断言误将商家自己救单字段也禁止，夹具又未先删DeliveryTask而触发FK清理错误；修正测试角色断言/清理后21项和全套通过，无C运行时代码变更。未隐藏失败或误称Docker故障。

A审查无严重问题，Minor指纹范围已扩到商家/商品/审计；B及最终审查无可复现问题。代码审查不代替独立CI。GitHub对B/C实现提交的 `gh run list --commit ...` 均返回 `[]`，**独立CI不可用**；结果为本地测试与独立代码审查。

## 5. 迁移、备份和兼容证据

仅新增 `20261012000100_merchant_operating_status`（营业version默认0/审计，保留isOpen）和 `20261012000200_product_sale_status`（枚举/历史回填/索引/兼容触发器/bool CHECK/审计）。所有旧迁移保持。

实查 `Product_sync_sale_status` trigger及 `Product_sale_status_available_check` CHECK存在；旧ORM写入测试证明执行。Prisma diff无drift，但不能代替触发器行为测试。升级须migrate deploy，只db push或生成client不足以安装兼容逻辑。

初始24条迁移已完成，另有两条历史rolled_back后成功重做记录，未删除或伪装历史；没有待处理失败。最终应用库26条已完成迁移。两家原商家isOpen=true保持、operatingVersion0；234个原可售商品仍ON_SALE，没有静默关店或售罄。

本机备份/日志：`C:\Users\Serena Lyric\AppData\Local\Codex\backups\campus-delivery-round7-20261012\`。

| 文件 | 字节 | 用途 |
| --- | --- | --- |
| round7-before.dump | 186723 | A前原应用库，已pg_restore成功、恢复库仍24迁移 |
| round7-before-B.dump | 190153 | B前原应用库 |
| round7-after.dump | 196060 | 26迁移后应用库 |

初始备份SHA256：`670D51C644CD3AB6C3157FD154B7C699CEE2224FA5A46B3FD255565ED78A1CCC`。容器/tmp也保留备份。

原备份恢复 `campus_round7_baseline`，与最终应用库对比**47张全部既有业务表**：行数及完整JSON排序MD5一致。Merchant只排除新增operatingVersion，Product只排除新增saleStatus，其他原字段含时间全部比较；迁移表独立检查。新审计表另由状态/Seed测试验证。

| 原应用事实 | 行数 | 原备份/最终一致摘要 |
| --- | --- | --- |
| Merchant原字段 | 2 | 9691580c6c342f195690f0fc6caaa7c8 |
| Product原字段 | 234 | 9dfcbe1a70ac4d927103d6b14baf810f |
| Order | 2 | 9b6935a8651548297c673b7d1a2f7ce0 |
| OrderItem | 4 | 2dd0fb12e79585b5760a067936b9ec32 |
| OrderPricing | 2 | 102cbb332a80bb3abcaf68b9f3062c58 |
| DeliveryTask | 2 | 58a9e9d8a9693ac5c292cc96e7e3f0d9 |
| Settlement | 2 | e6626a51ace6235f319f03fb933e3bb1 |
| RiderSettlement/DeliveryAssignment | 各0 | d41d8cd98f00b204e9800998ecf8427e |
| BusinessConfig | 2 | 1d4e463c53f7a4f38a5eb73cff0ea9b3 |

原库无骑手收入样本，空表不能证明该路径；C完整履约模拟生成已得收入后核验后续切换不漂移。

原库无false商品。只在 `campus_round7_old` 升级前把茶商品设false：升级后233在售/1下架/0售罄，茶version1，公共API隐藏且重复Seed仍隐藏；未写回应用库。全新 `campus_round7_final_empty` 从零26迁移/首轮Seed再重复2次，18类订单/资金/履约/配置/审计表摘要与营业/销售状态和版本一致。

Docker CLI/Desktop健康，无需恢复；未purge、删卷或重建应用库。本轮隔离库test/old/empty/final_empty/baseline保留供复核。应用库仅备份、迁移、只读核验，**未执行可能重写演示资料的应用库Seed**；Seed实际验证在副本/空库/隔离测试，不声称应用Seed已运行。

复核脚本：`scripts/verify-round7-migrations.ps1`（status/drift/全表指纹、SnapshotOnly基准）；`apps/api/scripts/verify-merchant-seed.ts`（限定隔离库、API历史隐藏/重复Seed摘要）。日志JSON保留上述目录，未提交数据库备份或环境文件。

## 6. 停止线

- 手动API已测试，不等于完整客户端/生产上线；仍用既有开发认证x-user-id。
- 自动营业、库存、真实支付均未实现；营业日/库存预留/付款真实性规则仍待确认，无不安全库存开关。
- 状态切换不免除原履约/退款/异常责任；不重构旧异常业务或调整历史资金模型。
- A/B/C和报告正常推送后停止，不自动续做后续开发。
