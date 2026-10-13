# 第十轮 B：本机数据盘点与逐对象清理审批

2026-10-13，起点 `5f11a61`。**本文件是候选清单，不是删除授权；截至本次记录没有删除任何数据库、容器或卷。** 具体批准必须指明下表对象 ID。未批准的对象一律保留。非本项目 Docker 对象不在范围内。

## 已核实事实

- Docker Engine 29.8.2 / Desktop running。原应用容器健康，端口5432；第九轮替代入口同挂主卷，始终停止，禁止同时启动。
- 原集群21库与第十轮A结束时全部public表指纹一致；主应用55表，历史迁移记录保留。没有对主库执行迁移、Seed或集成测试。
- A verification 有23库：原21库恢复副本、`campus_round10a_test`、`shop_round10a_recovery`。其中恢复副本 `campus_round9_final_old` 曾做A的重复Seed演练，10张表与原库不同，包括营业确认/审计记录数；不能声称所有副本仍与原库一致。其余原21库镜像20库一致。
- shop原卷是独立schema/业务内容，恢复副本16表与A证据一致；原用途/所有权仍待用户核实，不作为重复数据默认删除。
- A辅助容器另外产生两个匿名卷：`1508c16467613ba97d219c2f528d0069bcdf1299308735db1daea0c0e1bd0dfa`、`048c86d67aa74f65eeb555a70141aaa22c763995c8cc2df534082ae96798255a`，均为空目录（各4KiB），仍逐对象审批，不使用prune。
- 冷备时 A验证/恢复实例停止。只读挂载分别归档：verification约421.6MiB、recovery约47.3MiB、shop约47.3MiB及两个匿名卷。辅助容器数据层也保留，不通过删容器回收。

## 备份与可恢复证据

仓库外 `D:\Application\ClaudeCode\backups\campus-round10a-20261013`：21个dump SHA256及shop逻辑/物理哈希均重新核验一致；原21库逻辑恢复和shop物理/逻辑恢复证据见 [A盘点](local-postgres-inventory-2026-10-13.md)。

新增 `D:\Application\ClaudeCode\backups\campus-round10b-20261013`：取消目录ACL继承，仅当前用户/SYSTEM；保存当前全库指纹、容器挂载、冷备SHA256和测试日志。`cold-volumes/verification.tar.gz` 已解压到**新独立B恢复卷**，启动PG16并逐库验证全部23库，包含A已变化镜像及A测试库；shop原冷备哈希仍与A相同，recovery/匿名归档gzip校验成功。备份不提交Git，不上传CI。

verification冷备SHA256：`E23DB8C7DE56B59B5CFE60E2B946E6D9E6F63F0736AA7CAB18EBF3AFF823B179`；recovery：`792B80F828DF8591B8B5D2CD7C3DF74DEFF7177DACA86300E630D978CAC596D5`；两空匿名卷：`9CC2F795716C92C9A25930AEC7B9322067873A565A478902E5226B933DD60CC6`；shop仍为A记录的SHA256。

回滚只恢复到新空PG16实例/卷，先核对SHA256，再pg_restore或解压冷备，核对表指纹后人工切换。不能在原主卷上试恢复，globals凭据回放未演练。冷备为各卷独立一致快照，不宣称跨集群全局原子快照。未来删除前必须重新检查状态/挂载/指纹及备份，防止本清单后又有写入。

## 容器与卷候选（需要分别批准）

数据库条目在后表；批准容器不含其卷，批准卷也不能跳过其中数据库的逐对象批准。相同数据库名在不同集群是不同对象。

| ID | 对象 | 判定/影响 | 拟执行命令（未执行） |
| --- | --- | --- | --- |
| K1 | campus-delivery-postgres-1 | 保留：主应用入口 | 无 |
| K2 | campus-delivery_postgres-data | 保留：原21库含主应用和财务事实 | 无 |
| C1 | campus-round9-postgres | 候选：停止的同卷替代入口；不删除数据 | `docker rm campus-round9-postgres` |
| C2 | campus-round10a-verification | 候选：A验证入口，恢复23库已备份；需先确认不再使用 | `docker rm campus-round10a-verification` |
| C3 | campus-round10a-shop-recovery | 候选：shop恢复入口；原业务仍待核实 | `docker rm campus-round10a-shop-recovery` |
| C4 | campus-round10a-shop-archive | 候选：A只读归档辅助；外部备份保留 | `docker rm campus-round10a-shop-archive` |
| C5 | campus-round10a-shop-restore | 候选：A解压辅助；恢复事实保留 | `docker rm campus-round10a-shop-restore` |
| V1 | campus-round10a-verification-data | 候选：删除其全部23库；须另获每库批准、停止并移除所有依赖容器 | `docker volume rm campus-round10a-verification-data` |
| V2 | campus-round10a-shop-recovery-data | 用途待核实：shop物理恢复集群，含campus_delivery/postgres | `docker volume rm campus-round10a-shop-recovery-data` |
| V3 | shop_campus-postgres-data | 用途待核实：原shop独立数据，不推荐在用途未明时删除 | `docker volume rm shop_campus-postgres-data` |
| V4 | 1508c16467613ba97d219c2f528d0069bcdf1299308735db1daea0c0e1bd0dfa | 候选：A archive附带空匿名卷，先移除依赖 | `docker volume rm 1508c16467613ba97d219c2f528d0069bcdf1299308735db1daea0c0e1bd0dfa` |
| V5 | 048c86d67aa74f65eeb555a70141aaa22c763995c8cc2df534082ae96798255a | 候选：A restore附带空匿名卷，先移除依赖 | `docker volume rm 048c86d67aa74f65eeb555a70141aaa22c763995c8cc2df534082ae96798255a` |

本轮新建的 `campus-round10b-preservation`（停止的只读归档辅助）、`campus-round10b-restore-archive`（停止的解压辅助）、`campus-round10b-restore`/`campus-round10b-restore-data`（A冷备恢复校验）、`campus-round10b-test`/`campus-round10b-test-data`（全新隔离测试）均保留；本清单不申请删除它们。B test仅绑定127.0.0.1:55442，B restore仅绑定127.0.0.1:55443，绝不与原PGDATA共卷。恢复镜像不用于集成测试池。

## 数据库候选（逐库审批，当前全部保留）

主集群的 `campus-delivery`、`postgres`明确保留。A verification中同名主库**只是镜像**，仍单列候选。删除单库会丢失该库全部内容和连接入口；有活动连接时停止对应应用并重新审核，不自动强制断开、不使用DROP FORCE。

| ID | 集群容器 | 数据库 | 判定 | 拟执行命令（未执行） |
| --- | --- | --- | --- | --- |
| H1 | campus-delivery-postgres-1 | campus_round2_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round2_empty"` |
| H2 | campus-delivery-postgres-1 | campus_round2_legacy_final | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round2_legacy_final"` |
| H3 | campus-delivery-postgres-1 | campus_round2_old | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round2_old"` |
| H4 | campus-delivery-postgres-1 | campus_round7_baseline | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round7_baseline"` |
| H5 | campus-delivery-postgres-1 | campus_round7_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round7_empty"` |
| H6 | campus-delivery-postgres-1 | campus_round7_final_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round7_final_empty"` |
| H7 | campus-delivery-postgres-1 | campus_round7_old | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round7_old"` |
| H8 | campus-delivery-postgres-1 | campus_round7_test | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round7_test"` |
| H9 | campus-delivery-postgres-1 | campus_round8_baseline | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round8_baseline"` |
| H10 | campus-delivery-postgres-1 | campus_round8_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round8_empty"` |
| H11 | campus-delivery-postgres-1 | campus_round8_final_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round8_final_empty"` |
| H12 | campus-delivery-postgres-1 | campus_round8_old | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round8_old"` |
| H13 | campus-delivery-postgres-1 | campus_round8_test | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round8_test"` |
| H14 | campus-delivery-postgres-1 | campus_round9_baseline | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_baseline"` |
| H15 | campus-delivery-postgres-1 | campus_round9_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_empty"` |
| H16 | campus-delivery-postgres-1 | campus_round9_final_empty | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_final_empty"` |
| H17 | campus-delivery-postgres-1 | campus_round9_final_old | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_final_old"` |
| H18 | campus-delivery-postgres-1 | campus_round9_old | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_old"` |
| H19 | campus-delivery-postgres-1 | campus_round9_test | 历史测试候选；备份恢复一致，用途需确认 | `docker exec campus-delivery-postgres-1 dropdb --if-exists -U campus -- "campus_round9_test"` |
| A1 | campus-round10a-verification | campus-delivery | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus-delivery"` |
| A2 | campus-round10a-verification | campus_round2_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round2_empty"` |
| A3 | campus-round10a-verification | campus_round2_legacy_final | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round2_legacy_final"` |
| A4 | campus-round10a-verification | campus_round2_old | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round2_old"` |
| A5 | campus-round10a-verification | campus_round7_baseline | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round7_baseline"` |
| A6 | campus-round10a-verification | campus_round7_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round7_empty"` |
| A7 | campus-round10a-verification | campus_round7_final_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round7_final_empty"` |
| A8 | campus-round10a-verification | campus_round7_old | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round7_old"` |
| A9 | campus-round10a-verification | campus_round7_test | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round7_test"` |
| A10 | campus-round10a-verification | campus_round8_baseline | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round8_baseline"` |
| A11 | campus-round10a-verification | campus_round8_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round8_empty"` |
| A12 | campus-round10a-verification | campus_round8_final_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round8_final_empty"` |
| A13 | campus-round10a-verification | campus_round8_old | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round8_old"` |
| A14 | campus-round10a-verification | campus_round8_test | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round8_test"` |
| A15 | campus-round10a-verification | campus_round9_baseline | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_baseline"` |
| A16 | campus-round10a-verification | campus_round9_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_empty"` |
| A17 | campus-round10a-verification | campus_round9_final_empty | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_final_empty"` |
| A18 | campus-round10a-verification | campus_round9_final_old | A Seed演练后与原库不同；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_final_old"` |
| A19 | campus-round10a-verification | campus_round9_old | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_old"` |
| A20 | campus-round10a-verification | campus_round9_test | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round9_test"` |
| A21 | campus-round10a-verification | postgres | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists --maintenance-db=template1 -U campus -- "postgres"` |
| A22 | campus-round10a-verification | campus_round10a_test | A恢复/测试候选；B冷备恢复已核验 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "campus_round10a_test"` |
| A23 | campus-round10a-verification | shop_round10a_recovery | shop独立schema镜像，用途待核实 | `docker exec campus-round10a-verification dropdb --if-exists -U campus -- "shop_round10a_recovery"` |
| S1 | campus-round10a-shop-recovery | campus_delivery | 独立shop内容恢复副本，用途待核实 | `docker exec campus-round10a-shop-recovery dropdb --if-exists -U campus -- campus_delivery` |
| S2 | campus-round10a-shop-recovery | postgres | shop管理库；随集群回收时仍需批准 | `docker exec campus-round10a-shop-recovery dropdb --if-exists --maintenance-db=template1 -U campus -- postgres` |

shop原卷（V3）内的campus_delivery/postgres是另外两个对象，记为O1/O2；无原容器入口，不直接启动原卷或执行单库删除。若用户确认整卷回收，必须同时明确批准V3、O1、O2，使用上表V3精确命令。

批准示例：只批准 C1、C4、V4；其他全部保留。不能将「清理测试环境」解释为上表所有对象获批。

