# CODEX_REPORT — 第十轮 A：历史遗留工程清理

日期：2026-10-13（Asia/Singapore）。只执行用户授权及 CODEX_TASK.md 第十轮A：Docker/数据保护、独立CI、营业日过渡复核和支付文档收口。没有开发第十轮B、自动关店、数量库存、真实支付或Root/认证。

## 1. 结果与提交边界

本机原应用库已恢复正常连接；两个campus容器共用同一PGDATA卷，另有独立的shop旧卷，全部保留。原21个数据库已逐库逻辑备份并在新PG实例恢复，所有public表行数/内容指纹一致；shop只读冷备在新卷物理恢复，再做逻辑恢复/16表对比。结束前原21库指纹仍一致。

建立GitHub Actions独立PG16 service验证；首次Linux单测脚本glob展开失败已保留并最小修复。新增5项真实PG过渡回归，最终本地59单测、221PG集成、typecheck/build、迁移status/diff通过；实现提交8f17060有独立远端成功运行。现行支付说明统一服从主产品第1G节，两路线均未选型、未实现，历史正文及归档报告保留。

| 阶段 | 实际完整SHA | 提交/验证范围 |
| --- | --- | --- |
| 同步前本地 | 494381d177635406a99f9866e97d52c637982b2f | main干净，无未提交/未跟踪文件 |
| 同步后起点 | c743c30eabfde2cf997d39d4a0cc368c38b9a4b2 | fetch后仅普通ff-only，远端领先2个提交；读取最新AGENTS/CODEX_TASK |
| A 数据盘点 | d3c3ad511a791179d0a163f7c31f17e6f475b277 | 无损恢复、全库备份/恢复取证、盘点文档；本地基线59/216、build/typecheck绿色后普通push |
| B CI首次 | 7ec3275a8a3224b89b620dfa3ce3a580da04d3b4 | workflow提交；实际首次run失败，未称通过 |
| B CI最小修复 | 1a62d25ebfea282e0507f0c4180dbf18a9382136 | 仅给排除glob加引号；单测本地59/59，远端完整59/216及迁移/重复Seed成功 |
| C 过渡复核 | 8f170605b214b2c3c814860d12de36e182114e5b | 增加5项PG回归及字段说明；全套本地59/221，独立CI59/221成功，普通push |
| D 文档收口 | e53b1235e1a5eee37b51ff58d8ab26c2f0e1d279 | 现行支付/角色/导航与历史替代说明、数据盘点补充；14份改动文档本地链接及diff检查通过，普通push；独立CI成功 |
| D 审查收口 / 报告前终点 | 1d99196db0b6e07b5127f43d984b9603f8e02cb6 | 只读审查唯一P3的两处README遗留措辞已修正，内容/diff检查通过，普通push；应用实现仍为8f17060 |

报告及任务完成标记在上述实施验证后单独普通提交；报告本身SHA用 `git log -1 --format=%H -- CODEX_REPORT.md` 查询，避免自引用。最终本地/远端HEAD和报告提交CI状态由交付前再次读取；不把仅文档后续提交的状态冒称为先前实现提交状态。所有提交直接按用户授权普通push main，没有reset、clean、强推、丢弃工作或PR。

## 2. 数据身份、保护与恢复

完整双campus对照、数据库清单、逐库表数/迁移行数/Order/Product行数、端口和恢复方式见 [本机PostgreSQL盘点](docs/local-postgres-inventory-2026-10-13.md)。核心证据如下：

| 对象 | 数据、连接与最终状态 | 用途判定 |
| --- | --- | --- |
| campus-delivery-postgres-1 / 0dc1d0c9c90e | campus-delivery_postgres-data；宿主5432；原停止，现healthy运行；PG16 | 当前两份本机.env指向localhost:5432/campus-delivery；主开发库 |
| campus-round9-postgres / 5609be7ed2db | **同一个campus-delivery_postgres-data卷**；原127.0.0.1:55439；始终停止 | 第九轮替代启动入口，不是第二份数据；绝不同时启动 |
| shop_campus-postgres-data | 原无容器挂载，原卷只读且保持；独立PG16集群含campus_delivery/postgres | 旧shop项目标签、正常关闭、只有初始迁移；历史环境判断有证据，原始用途/所有权仍需用户确认 |
| 本轮verification/shop-recovery | 新独立卷与127.0.0.1:55441/55440；验证后均停止，未删除 | 主21库/shop恢复副本、独立测试库；只在副本进行Seed/测试 |

主库55张public表，30个已完成迁移+2条历史回滚记录；User10、Merchant2、Product234、Order2、Settlement2。shop旧库16张public表，仅init迁移；User5、Merchant1、Product2、Order1、Settlement1。两集群system_identifier不同，schema及业务指纹不同，不能凭名称判为重复数据。既有第2/7/8/9轮测试/迁移库同样逐库保留，不重跑旧任务。

Docker取证实际运行：context ls、info、desktop status、compose ls --all、ps -a --no-trunc、volume ls、inspect容器/卷；Windows Get-NetTCPConnection及netsh端口保留查询。Engine29.8.2可用，Desktop status却报stopped，以CLI/真实PG连接验证为准，未重启Desktop。5432本次无监听者/保留冲突，直接启动原容器成功，Prisma能连接；第九轮冲突未复现，不声称永不复发。没有更改.env、Compose、生产配置或其他程序；原5432发布所有宿主接口事实在盘点注明，正式网络策略另行审核。

备份目录：`D:\Application\ClaudeCode\backups\campus-round10a-20261013`（仓库外，仅本机）。包含21份custom pg_dump、globals.sql、shop冷备/逻辑备份、SHA256清单、前/恢复/后指纹、测试及CI日志。目录取消继承，只给当前Windows用户及SYSTEM访问。备份和角色定义不提交Git、不上传Actions artifact，报告不包含连接凭据或业务行明细。

| 备份 | SHA256 | 恢复结果 |
| --- | --- | --- |
| campus-delivery.dump | 663BCF42900E1A674D471055D27514A3BDBE3C3B60C102568D5418F3C4506792 | 新独立实例pg_restore --exit-on-error，55表内容指纹一致；其他20库同样逐库恢复一致 |
| shop-pgdata.tar.gz | 47B1372E6F26A81D30191C7AE43AA8C0F5287B9021B2B81961CE539A9DFE8540 | 原卷只读冷备；解压到新空卷并启动单一PG16实例，正常读取 |
| shop-campus_delivery.dump | D908D1D54D2D186C6EC0916337FC6118FBA793B72BB0F24FDABFC0668155D143 | 从物理副本dump再逻辑恢复到另一独立库，16表行数/指纹一致 |

备份是逐库一致快照，本次没有应用写入；不声称所有数据库之间全局原子快照。globals保存但未在副本回放（已存在同名campus角色），不声称角色凭据恢复已演练。指纹MD5用于内容对比，备份完整性使用SHA256。原卷只有原容器一个PG进程运行，shop恢复只用新副本卷。主库不做Seed/写迁移；原21库结束前逐表复核未变，历史回滚记录不改写。

本轮辅助archive/restore容器、恢复容器/卷及测试库也都保留，仅停止无需运行的副本。没有删除、合并、重置任一数据库、容器或数据卷；没有必要通过清理完成验收。未来如要移除round9替代容器、历史测试库、shop旧卷或本轮验证副本，仍须逐对象提供差异及备份恢复证据并取得独立用户批准。**备份成功不等于删除授权。**

## 3. 独立CI证据和失败修复

`.github/workflows/ci.yml`：push main / pull_request / workflow_dispatch；Node24、固定pnpm11.5.1、frozen lockfile；checkout/setup-node/pnpm setup以实际官方tag SHA固定，contents:read，checkout不保留凭据。每job全新PG16 service，仅使用可丢弃的ci测试身份，不使用本机.env或数据库、不接真实支付、不导出本机备份。

顺序为install、Prisma generate、typecheck、单测、build、integration（迁移deploy+Seed）、migrate status/diff、重复Seed。历史PostgreSQL triggers由30条migration建立，未使用db push。CI没有连接用户Docker主库。

| run / 精确提交 | 状态与证据 |
| --- | --- |
| [38339931534](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38339931534) / 7ec3275 | **失败**：Linux展开未引用的tests/integration/**，单测阶段误跑集成，新service尚无表，P2021；build/integration等后续跳过。完整失败日志本机保留 |
| [38340171941](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38340171941) / 1a62d25 | **成功**：59单测、216PG集成；install/generate/typecheck/build、迁移status/diff、重复Seed均成功 |
| [38340552960](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38340552960) / 8f17060 | **成功**：59单测、221PG集成及完整上述检查成功；覆盖新增5项过渡回归的实际实现SHA |
| [38340857796](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38340857796) / e53b123 | **成功**：实际读取headSha/conclusion及全部步骤；59单测、221PG集成、typecheck/build、迁移status/diff、重复Seed全成功 |

修复仅将apps/api/package.json单测命令的glob用双引号包住，未删除测试、修改业务规则或提前Seed主库。Windows本地59单测验证和Linux独立CI均证实排除正确。第九轮原报告仍是其提交的本地记录，不回写成当时已有独立CI。此处“独立”指GitHub托管runner执行，不代表独立人工财务审计或生产验收。

## 4. 营业日过渡与字段

见 [过渡复核与字段表](docs/business-day-transition-review-2026-10-13.md)。保留第九轮既有04→08、08→02、跨午夜、身份隔离、无background jobs同步门禁、旧quote重新准入、配置/商家/商品锁后实时读取及既有订单履约回归。

新增5项PG/API回归：

1. 多次覆盖pending在原边界后继续延长，形成46h已确认营业日；期间预览及创建可用，实际边界后未确认拒绝；原确认及已建立订单不回写。
2. America/New_York春季DST缺失时段：配置过渡、偏好阈值、真人确认、预览/创建及下一次过期。
3. 秋季DST重复时段：同样核对真实DTO/UTC起点及准入；基础本地算法仍按首次出现。
4. 实际管理员替换pending后，商家确认与preview在真实PG商家锁后跨配置生效点排队，使用新策略/实际日。
5. 相同竞态覆盖create，旧quote不能替代实时确认校验。

没有发现需改业务代码的缺陷，没有把超过24h本身当bug；没有新增最大营业日、修改次数、强制关店规则。首个过渡区间可长/短于24h，是已授权的非回溯工程策略，不是固定排班。

已明确本人顶层effectiveAt是启用偏好的最早阈值，schedule.effectiveAt是当前有效策略生效点，configuredEffectiveAt是最新提交策略生效点；active根据**实际日起点**判定。schedule.time/version是当前有效，configuredTime/version是最新已提交；businessDayStartsAt/nextBusinessDayStartsAt才是实际UTC边界。

管理员GET当前为 `{config,audit}`、PUT返回config本身，config.version/payload.time是最新配置，不必已生效。管理员GET没有解析后的日视图或完整响应OpenAPI schema、没有完整管理UI；本轮只明确现有契约限制，不开发新增视图。真实UI将来须同时展示有效、pending及实际边界。

首次新增专项运行：20通过、1失败，原因是新增断言误以为管理员GET直接返回config；改为实际config包裹后21通过，补两项竞态后23专项全部通过。此失败是测试断言错误，不冒称运行时bug或业务修复。

## 5. 本地验证、范围与编号验收

| 检查 | 实际执行 / 结果 |
| --- | --- |
| install/generate | pnpm install --frozen-lockfile、pnpm db:generate成功；pnpm11.5.1、Node24.15.0，无lockfile变更 |
| A基线 | pnpm typecheck、test（59）、build、test:integration（216）全部成功 |
| C全套 | db:generate、typecheck、test（59）、build、test:integration（221）全部成功；PG9文件全通过 |
| C专项 | vitest run tests/integration/daily-confirmation.test.ts，最终23/23成功；原单位business-day3项保留 |
| 主库只读迁移 | Prisma migrate status：30条migration最新；migrate diff --from-url / --to-schema-datamodel --exit-code：无差异；没有迁移写入 |
| 隔离空库迁移 | 新campus_round10a_test由test:integration deploy全部历史migration及Seed；status/diff通过；CI另在新service独立重复验证 |
| Seed | 独立测试库重复db:seed成功；恢复副本127.0.0.1:55441/campus_round9_final_old执行既有verify-daily-confirmation-seed.ts，两次Seed的23资金/审计表、营业/商品状态断言全一致，历史false仍隐藏；不对原库执行 |
| 数据与diff | 21个原库前/恢复/后public表指纹全部一致；shop物理→逻辑16表一致；git diff --check及14份修改文档本地链接通过 |
| 历史保留 | 第九轮root旧报告与归档原内容hash同为20233d355d08ac083511e07fb9626655e59ce17c；全部CODEX_REPORT_* / CODEX_TASK_*、migration和lockfile相对起点无改动 |

日志在仓库外证据目录：baseline-integration.log、phase-c-*、transition-first/second/final.log、seed-preservation.log及ci-*。首次只读盘点误用shop库名campus-delivery导致不存在错误，实际枚举后改用campus_delivery；没有创建/重命名原库。初期查找两个不存在路径（run-integration-tests.ts、admin/routes.ts）和错误skill路径，随后按实际文件定位；这些不算应用失败。

完成后另对20个原业务/历史验证库的_prisma_migrations只读汇总：未完成且未回滚记录均为0，历史rolled-back保留；postgres管理库无public迁移表。汇总留本机original-migration-summary.json。

按requesting-code-review技能作一次新上下文只读整体审查（c743c30→e53b123+报告/任务草稿）：无阻断，唯一P3为README两处“首期直付模式”遗留，已改为“未来选定支付路线”。该修复只涉及文字，做内容/引用/diff验证，没有为文字修复重跑应用测试。审查核对代码/新增测试、保存的CI证据与历史文件未改，未重新运行恢复/Seed/集成或实时请求GitHub；这次审查不构成第二次数据库/CI实跑，也不评估完整既有资金安全或生产能力。没有未处理审查发现。

| CODEX_TASK要求 | 证据 / 结论 |
| --- | --- |
| 0.1 Git保护与最新main | 本地干净，fetch+ff-only，阶段普通提交/push，无覆盖 |
| 0.2–3 数据禁删、同卷单进程、备份隐私 | 原/替代挂载核验，替代始终停止，新副本卷恢复，仓库外限制ACL，全部原对象保留 |
| 0.4 阶段验证及实际SHA | 第1节及CI/local检查，首次失败真实记录 |
| A1 Docker/端口/卷 | 实际CLI清点与Windows占用/保留范围取证，完整盘点文档 |
| A2 区分数据身份/只读比较/实际.env | 两原容器一个主集群，另有独立shop；21库/迁移/表数/指纹；连接掩码 |
| A3 备份与恢复 | 21逻辑备份/全库恢复、shop冷备/新卷恢复及逻辑对比，SHA256 |
| A4 无损恢复开发连接 | 5432无当前冲突，原容器启动/Prisma连接；无需更改映射或生产配置 |
| A5 对照及待确认清理 | 两原容器ID/卷/状态、shop历史数据差异及保留对象明确；未执行清理，原始shop用途仍待用户确认 |
| B1–2 独立CI/隔离迁移Seed | Actions新PG16 service、固定工具/锁依赖，完整迁移及测试 |
| B3 实際运行/失败修复 | 3个已完成run精确SHA及日志；文档commit后续run单独记录 |
| C1 过渡/DST/竞态 | 原回归+5新增PG，23专项及221全套；无新增业务规则 |
| C2 字段契约 | 本人有效/配置/偏好版本与边界说明；管理员GET原样契约与展示限制明确 |
| D1 支付一致性 | 第1G同步当前摘要及角色；旧计划/审计/运营仅追加替代说明，历史保留 |
| D2 报告与旧引用 | 根报告第十轮A，九轮归档不改；五/七/九轮导航指向实际历史报告 |
| D3–4 验收/完整证据/停止 | 开发环境安全可用、CI与本地证据明确、原数据不变；审批/产品/生产阻断分级，停止在A |

## 6. 支付文档与未实施事项

遵循最高产品第1G节，没有新支付决定：修正PRODUCT_DECISIONS现行第6节/待办及历史优先级导航、ROLE职责的历史优先级与资金限制、FINANCE/DELIVERY_PRICING/EXCEPTION现行状态；旧OPERATIONS、IMPLEMENTATION_PLAN、AUDIT_FOLLOWUP正文保留，追加2026-10-13替代说明。经营专题补足付款顺序/库存时点未决，README和PRE_NEXT_ROUND_CHECKLIST收口。第五/七/九轮引用匹配归档；旧审计裸CODEX_REPORT文字仍指其审核时点，已加说明，不能被根新报告覆盖。

四档状态：**enforced** 为已有营业确认与准入门禁（只增加回归）、CI脚本正确排除与独立校验；**data/telemetry** 为本地盘点、恢复取证、实际DTO/配置及报告；**reserved/placeholder** 无本轮新增策略钩子或未使用输入；**not implemented** 为自动关店、数量库存、真实支付/退款/分账/提现、正式Root/强认证/完整UI及第十轮B。

待用户批准只涉及未来真实清理/回收，无清理获批，本次全部保留。shop原业务用途需用户确认，不影响现主库安全使用。若未来要限制长过渡日/改时频率，或选择支付路线，须新产品决定及单独开发授权。

**第十轮B前工程遗留**：本轮数据关系、环境可连接、CI、过渡专项和现行支付一致性已处理；恢复副本/历史数据回收不是B启动条件，B仍需用户授权。**正式生产前阻断**：x-user-id开发认证、正式Root/L1/L2、强认证、真实合法支付主体/产品与可信收款/退款/对账、正式网络/备份恢复/审计验收；当前CI通过不替代这些能力，也不关闭历史资金安全审计所有未完成发现。

本轮在上述范围完成后停止，不自动进入新功能开发。
