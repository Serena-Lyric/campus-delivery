# CODEX_TASK — 第十轮 A：历史遗留工程清理（2026-10-13）

> **第十轮A已执行完成（2026-10-13）**：阶段实际SHA、原数据关系/备份恢复、独立CI成功与首次失败、营业日专项及支付文档收口见 [第十轮A归档报告](CODEX_REPORT_2026-10-13_ROUND10A.md)。下文保留本轮要求以供逐项复核；全部原数据库、容器和卷保留，任何回收仍需单独批准。**停止于A，第十轮B未开发且仍需用户另行授权。**

> **只执行第十轮 A，不开发第十轮 B 新功能。** 用户已要求先解决第九轮遗留问题及 Docker 中两个 campus 数据库的疑问，之后再开发。A 阶段的工作是：无损核查/恢复开发环境、建立独立 CI、营业日切换过渡审查、纠正遗留文档。完成验收后停止，下一组产品决策和 B 阶段另行授权。
>
> 第九轮原 [任务](CODEX_TASK_2026-10-12_DAILY_CONFIRMATION.md)、[报告](CODEX_REPORT_2026-10-12_DAILY_CONFIRMATION.md) 已归档，不能重跑第九轮。第八轮也已完成。当前主产品第1G节：真实支付两路线均未选型；第1F节自动关店仅已设计、**未开发**。依据 AGENTS.md、PRODUCT_DECISIONS.md、PRE_NEXT_ROUND_CHECKLIST.md、CODEX_REPORT_2026-10-12_DAILY_CONFIRMATION.md 开展只限遗留工程工作。

## 0. 开始前必做与停止线

1. 检查 git status、diff、未跟踪文件、最新本地/远端 main、任务/报告；若本地有未提交工作，**保留并停止任何可能覆盖的同步**。仅允许无冲突的普通 fast-forward、提交和 push。禁止 reset/clean/force-push，禁止修改历史 migration 或旧报告原文。
2. Docker 数据**优先保全**。禁止 `docker compose down -v`、`docker volume rm/prune`、`docker rm`、`docker system prune`、`DROP DATABASE`/`DROP SCHEMA`、`prisma migrate reset`，也不得对原应用库做具有删除副作用的 Seed。**不得删除/合并用户看到的任一个 campus 容器、数据库或卷**。涉及删除/合并必须给用户明确对象、差异与可恢复备份证明后，等待独立批准。
3. 切勿让两个 PostgreSQL 进程同时读写**同一个 PGDATA 数据卷**。备份及敏感连接信息只能留本机仓库外，不写 GitHub/报告原文；仅引用非敏感路径与掩码。
4. 分阶段执行、验证、独立普通提交并报告实际 SHA。失败/阻断要真实记录，不得把本地测试当作 GitHub CI。

## A. 先查清两个 campus 数据库和 5432 端口（先只读）

1. 先用 `docker context ls`、`docker info`、`docker compose ls --all`、`docker ps -a --no-trunc`、`docker volume ls`、`docker inspect` 清点相关容器/项目、状态/Compose labels、端口、真实挂载卷/路径与镜像版本。检查 Windows 本地 5432 端口占用（`Get-NetTCPConnection` 或 netstat）。仓库 compose 目前只定义一个 postgres、默认 DB `campus-delivery`；第九轮另建过 `campus-round9-postgres` 并临时挂载原 `campus-delivery_postgres-data` 卷、监听 127.0.0.1:55439，**但这不证明目前是两份数据**。
2. 区分“两个容器 / 两个 PostgreSQL 实例 / 一个实例下的两个或更多数据库 / 共用数据卷的替代启动容器”。在安全可读的实例中只读枚举数据库、migration status、代表性原业务表行数/最新记录、创建/运行用途；比对本地 `DATABASE_URL` 实际连接端口/库，但隐藏任何密码。若停止实例的卷可能正被使用，**不为盘点而强行同时启动**。
3. 按证据标记主应用库、独立测试库、历史备份或待确认库；不凭名字/文件大小直接决定主库。可对安全访问的库执行 `pg_dump -Fc` 及 SHA256，尽可能在全新隔离库验证可恢复；备份必须放仓库外并防止泄漏，且**备份完成不代表可删除原库**。
4. 先无损解决开发环境可连接问题：确认 5432 被哪一个进程或端口保留占用，选择清晰、稳定的端口映射/.env 配套方案，不劫持其他程序、不删除数据卷、不偷偷改生产配置。原容器如有冲突，先向用户说明两种方案的影响。
5. 交付明确的“双 campus 对照表”：容器名/ID、DB名、卷、端口、状态、迁移/行数概要、代码真正连接位置、各自用途、备份/恢复取证、建议保留的主库和**待用户确认的清理对象**。可留下非必要容器停止但不可删除，不能自动合并/删库。

## B. 独立 CI 及可复核证据

1. 创建最小 GitHub Actions CI：Node 20+/仓库固定 pnpm 11.5.1、frozen lockfile、Prisma generate、typecheck、单测、build，最好加 PostgreSQL 16 **全新一次性 service** 的 integration/迁移检查。不得连接用户 Docker 主库、公开数据库凭据或接入真实支付。
2. 注意 `pnpm test:integration` 本身会跑 `prisma migrate deploy` 和 `prisma db seed`，只能对**可丢弃的独立测试数据库**执行。历史 PostgreSQL triggers 必须由迁移建立，不能用 db push 冒充验证。
3. push 后实际读取 workflow run/commit SHA/结果/日志；若权限限制或失败，记录阻断、最小修复与后续验收。不准将“有 YAML”写成“CI 已通过”。不得通过删安全测试或修改产品规则让 CI 变绿。

## C. 第九轮营业日过渡专项

1. 复测 04:00→08:00、08:00→02:00、反复覆盖待生效配置、跨午夜/DST、商家确认与订单预览/创建的竞态。区分现有**非回溯延长过渡日**策略与真实缺陷；过渡区间可能超过24h不自动认定是 bug。
2. 检查管理员查询/配置 DTO 中有效时间与待生效时间、`effectiveAt`、`businessDayStartsAt`、`nextBusinessDayStartsAt`、版本字段的实际说明。可补严格的回归/文档或明显 bug，但不可自行新增改时次数上限、最长营业日、强制关店等未决业务规则。需要新决策则停止对应功能改动。

## D. 文档收口、验收与报告

1. 主产品1G已暂停两条真实支付路线，核实 README、AGENTS、财务、角色、经营专题和其他**非历史实施指令**不存在“首期必须分开支付”的误导。原审计/旧计划保留历史真相，只追加必要替代声明，不擦除证据。
2. 正式执行完成**之后**，把根 `CODEX_REPORT.md` 改成第十轮 A 的实际执行报告；第九轮报告保持在独立归档文档。及时更新第九轮具体报告引用，不能让旧链接指向新的根报告。
3. 验收：真实环境已可安全使用且没有误删数据；两个 campus 的身份清晰、需要删除的对象仍等审批；有独立 CI 的实际 SHA/run 或透明阻断；营业日过渡验证结论；支付文档一致。分清 “第十轮B前必要” 与 “正式生产上线前必要”（x-user-id、正式 Root、真实支付主体）。
4. 报告本地/远端 SHA、每阶段命令与验证、失败、数据库清单、备份/恢复证据与隐私保护、GitHub Actions run URL、未完成/需用户审批事项。停止，不自动做商家自动关店、数量库存、真实支付、Root/认证或第十轮 B。

**所有删除数据、移除容器/卷、实际合并数据库都必须在提交证据后等待用户授权；第十轮 B 新功能也需用户另行授权。**
