# 第十轮 A：本地 PostgreSQL 无损盘点

日期：2026-10-13（Asia/Singapore）；起点 `c743c30`。本文件只记录本次本机证据，不是生产配置或数据库删除授权。

## 容器、卷与真实连接

| 对象 | 状态与连接 | 数据身份 / 用途 | 本次处置 |
| --- | --- | --- | --- |
| `campus-delivery-postgres-1` / `0dc1d0c9c90e` | 原先停止，现运行；宿主5432→容器5432；postgres:16-alpine；Compose项目campus-delivery、service postgres | 挂载 `campus-delivery_postgres-data`；当前代码两份本机.env都连接 localhost:5432 / campus-delivery | 启动原容器，未重建；保留全部数据库 |
| `campus-round9-postgres` / `5609be7ed2db` | 始终停止；原映射127.0.0.1:55439→5432；无Compose labels | **与上行完全相同的PGDATA卷**；第九轮5432冲突时的替代启动入口，不是第二份数据库 | 保持停止；不得与上行同时启动；待用户另行批准才可移除 |
| `shop_campus-postgres-data` | 原先和现在都没有原容器挂载；Compose labels为历史shop项目 | **独立**PG16集群；system_identifier=7688189233308463137，正常关闭，控制文件最后检查点2026-09-22；含 campus_delivery 和 postgres | 原卷只读冷备；仅启动复制到新卷的恢复副本；原用途/所有权仍需用户确认，保留 |
| `campus-round10a-verification` | 127.0.0.1:55441；新独立卷 `campus-round10a-verification-data` | 原21库逻辑恢复副本、shop逻辑恢复副本、全新 `campus_round10a_test`；本轮测试专用 | 集成测试/Seed只在全新测试库执行；验收后停止保留 |
| `campus-round10a-shop-recovery` | 本次曾监听127.0.0.1:55440，恢复取证后停止；新卷 `campus-round10a-shop-recovery-data` | 从shop冷备解压的物理恢复副本；没有挂载原shop卷 | 验证后停止保留 |

只读冷备及解压辅助容器 `campus-round10a-shop-archive` / `campus-round10a-shop-restore` 执行后停止，也未删除。没有其他运行中的容器挂载原campus卷。主集群system_identifier=7688192164030705698，与shop不同。

Docker Linux Engine 29.8.2可用；`docker desktop status` 返回stopped，与CLI服务可用结果不一致，按 `docker info`、实际exec、PG连接取证，不做Desktop重启。当前5432无原监听者、无Windows保留范围冲突；启动原容器后实际Prisma连接成功。第九轮记录的冲突在本次未复现，不能推断永久消失。原Compose配置发布到所有宿主接口；本轮没有借盘点修改网络策略。若以后端口冲突，可在用户知情后选择释放已确认非必要的占用程序，或使用替代端口并同步本机.env；不得劫持其他程序，且不得启动两个读写同一PGDATA的PostgreSQL进程。

## 数据对比

主应用库 `campus-delivery`：55张public表（含迁移表），30条已完成migration + 2条历史rolled-back记录；Prisma status最新、schema diff无差异。代表性数据：User 10、Merchant 2、Product 234、Order 2、OrderItem 4、OrderEvent 8、OrderPricing 2、Settlement 2；最新Order.createdAt为2026-10-10 03:01:56.168（数据库原输出，未推断其本地时区）。营业日确认及偏好审计表当前0行。金额及履约信息仅留本机指纹，不发布明细。

shop旧库 `campus_delivery`：16张public表（含迁移表），仅20260922000100_init；User 5、Merchant 1、Product 2、Order 1、OrderItem 2、OrderEvent 6、OrderPricing 1、Settlement 1。旧schema与当前库不同，业务行指纹也不同；不能认定为可丢弃的重复数据，不能自动合并或升级。名称、时间和初始迁移支持“历史独立环境”判断，不能证明原始业务用途或数据是否仅演示。

主集群数据库总计21个（不含template）：

| 分组 | 数据库 | 本次证据 / 用途判定 |
| --- | --- | --- |
| 当前应用 | campus-delivery | 本机.env实际目标；保留主开发库 |
| 第2轮历史 | campus_round2_empty、campus_round2_legacy_final、campus_round2_old | 历史迁移验证命名，已逐库备份/恢复/所有public表对比；不据名称清理 |
| 第7轮历史 | campus_round7_baseline、campus_round7_empty、campus_round7_final_empty、campus_round7_old、campus_round7_test | 旧迁移/测试副本；同上，保留 |
| 第8轮历史 | campus_round8_baseline、campus_round8_empty、campus_round8_final_empty、campus_round8_old、campus_round8_test | 第八轮报告对应迁移/测试环境；同上，保留 |
| 第9轮历史 | campus_round9_baseline、campus_round9_empty、campus_round9_final_empty、campus_round9_final_old、campus_round9_old、campus_round9_test | 第九轮报告对应基线/空库/旧库升级/测试；同上，保留 |
| 管理库 | postgres | 同样已备份及恢复；public表为空 |

逐库migration表及全部public表的行数和排序后JSON行内容MD5指纹保存在本机证据目录；恢复副本与对应源库全部一致。MD5用于本次内容对比，备份完整性另外使用SHA256。不把这些副本当作多个独立线上应用，也不对历史库再次Seed。

| 库 | public表数 | migration记录数 | Order / Product行数 |
| --- | --- | --- | --- |
| campus-delivery | 55 | 32（30成功+2回滚） | 2 / 234 |
| campus_round2_empty / campus_round2_legacy_final / campus_round2_old | 各42 | 各22 | 各8 / 2 |
| campus_round7_baseline | 48 | 26 | 2 / 234 |
| campus_round7_empty / campus_round7_final_empty | 各50 | 各26 | 各8 / 2 |
| campus_round7_old | 50 | 28 | 10 / 234 |
| campus_round7_test | 50 | 26 | 10 / 92 |
| campus_round8_baseline | 50 | 28 | 2 / 234 |
| campus_round8_empty / campus_round8_final_empty | 各53 | 各28 | 各8 / 2 |
| campus_round8_old | 53 | 30 | 10 / 234 |
| campus_round8_test | 53 | 28 | 10 / 107 |
| campus_round9_baseline | 53 | 30 | 2 / 234 |
| campus_round9_empty / campus_round9_final_empty | 各55 | 各30 | 各8 / 2 |
| campus_round9_old / campus_round9_final_old | 各55 | 各32 | 各10 / 234 |
| campus_round9_test | 55 | 30 | 10 / 77 |
| postgres | 0 | 无public迁移表 | 无对应表 |

上表是历史库盘点，迁移记录数可能含回滚，不等于全部成功数；没有将旧schema升级至当前版本或宣称旧基线与当前schema一致。主库及隔离测试库才运行当前Prisma status/diff。主卷数据库21个，恢复验证额外新库不计入原库清单。

## 备份、恢复与隐私

仓库外目录：`D:\Application\ClaudeCode\backups\campus-round10a-20261013`。包含主集群21份pg_dump custom备份、globals.sql、shop原卷冷备、shop逻辑备份、SHA256清单及逐库恢复指纹。数据库备份和角色定义可能含敏感数据，仅留本机，不提交Git、不上传Actions artifact。连接文档省略凭据。

证据目录已取消继承权限，仅当前Windows用户与SYSTEM具有访问权限；SHA256清单、控制/指纹与本轮测试及CI日志留本机。目录ACL验证通过，不把备份当作公开可下载附件。

| 备份 | SHA256 | 实际恢复证据 |
| --- | --- | --- |
| campus-delivery.dump | 663BCF42900E1A674D471055D27514A3BDBE3C3B60C102568D5418F3C4506792 | 在新独立PG实例pg_restore --exit-on-error；55表行数/内容指纹全一致 |
| shop-pgdata.tar.gz | 47B1372E6F26A81D30191C7AE43AA8C0F5287B9021B2B81961CE539A9DFE8540 | 原卷只读、shut down状态；解压到新卷后正常启动、枚举库及读取16表 |
| shop-campus_delivery.dump | D908D1D54D2D186C6EC0916337FC6118FBA793B72BB0F24FDABFC0668155D143 | 从物理副本dump，再在另一全新库shop_round10a_recovery恢复；16表指纹一致 |

主集群各数据库逻辑dump在没有应用写入的本次盘点中逐库执行；不声称跨所有数据库的全局原子快照。globals已保存，恢复实例已有同名campus角色，故未回放globals；不声称角色凭据恢复也已演练。主库未Seed、未迁移写入、未删库。两条历史rolled-back记录保持原样。

恢复流程只针对**新独立目标**：先核对SHA256；建立单独PG16卷/实例和目标库，以对应角色执行pg_restore --exit-on-error；读取fingerprint.sql并与对应before.jsonl逐表对比。shop物理恢复先解压到新空卷，再启动单一PG16进程，绝不在原卷上试恢复。任何未来生产恢复还须另行审核权限、应用停写、版本和切换策略。

## 日常使用与待审批对象

日常开发保留原Compose容器+5432+.env方案。启动前检查 `docker info`、`docker ps`、`docker inspect` 挂载以及5432占用；确认同卷替代容器停止后可 `docker start campus-delivery-postgres-1`。应用库只读 `prisma migrate status`/diff；**不要在应用库执行test:integration或Seed**，它们会改数据。PG集成只使用全新隔离实例/测试库。

本次**没有清理必要性，也没有删除提案获批**。候选冗余入口campus-round9-postgres、历轮测试库、shop旧卷及本轮验证副本全部保留；若用户后续希望回收，必须逐对象确认数据差异、备份与恢复证据后再单独授权。自动关店、数量库存、支付、Root和第十轮B不属于本次范围。
