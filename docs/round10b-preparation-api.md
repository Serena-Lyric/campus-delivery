# 第十轮B阶段A：预计出餐API与验收边界

依据主产品第1H节及出餐专题第1节。当前只交付阶段A后端，阶段B–E尚未实现；无真实消息推送或完整UI。

| 入口 | 权限与行为 |
| --- | --- |
| `PUT /merchant/orders/:orderId/preparation-estimate` | 本单商家OWNER；严格三字段 estimatedReadyAt / expectedVersion / requestKey；返回 changed、replayed、recordedVersion和当前 preparationEstimate |
| `GET /orders/:orderId/preparation-estimates` | 本人用户、OWNER、合法当前active assignment骑手及原SUPER_ADMIN读取；按版本升序；仅OWNER/Admin可见actorId，无角色可见requestKey |
| `GET /orders/:orderId`、`GET /orders/my` | 订单可读视图添加 preparationEstimate，用户列表同样动态计算；历史骑手的原只读权限保持，但不获取新预计字段 |
| `GET /delivery-tasks/available`、`GET /delivery-tasks/mine`、成功claim响应 | 必要预计事实；受原资格、个人屏蔽、期限及角色门禁控制；仅当前承接者在mine收到预计 |

`estimatedReadyAt` 接受带Z/UTC偏移的有效日期时间，精确到最多毫秒；默认null。不限制商家合理修改次数，可提前或延后，也可如实填写已过时间（立即显示overdue），不伪造未来准确性。每个新请求在订单锁内检查合法已确认状态/未交接及独立版本，当前版本从0开始；成功写入预计字段、追加审计及MERCHANT_PREPARATION_UPDATED事件。相同键/同内容重试不重复写入；同键异内容、陈旧版本或交接/终止后拒绝。审计SQL UPDATE由trigger拒绝，无编辑/删除历史API；测试库删除整订单仍可级联清理，不宣称对DB超级用户不可删除。

数据库TIMESTAMP按UTC语义保存，JSON `estimatedReadyAt` 返回UTC ISO字符串；`estimatedReadyAtLocal` 供校园显示，同时必须带 `timeZone`（CAMPUS_TIME_ZONE，项目默认Asia/Shanghai）。所有可读角色得到同一预计事实，商家独有 `updateReminder:true`。`overdue` 由查询服务器当前时间计算：已确认/承接、尚未READY且当前时间达到预计时才为true；无预计、READY、交接和终止不提醒。不自动READY，不新建处罚、退款或金额记录，不刷新原firstPublishedAt/claimDeadline；READY仍是商家单方声明。

**主库部署限制**：本轮依任务只在新B测试实例55442、旧主库的B隔离恢复副本55443及CI应用新migration；原5432应用库保留旧schema/财务事实。不要直接对原库运行新服务或集成测试/Seed，应显式使用隔离 DATABASE_URL。真实应用库升级需要另外审核部署策略，不在本任务中擅自写主库。

验证：新增13项PG测试及2项单测，覆盖默认、旧单新增字段默认、提前/延后历史、时区偏移/非默认校园接单响应、过去时间、READY/终态、并发同键和竞争版本、全响应负向隐私、真实PG交接/READY锁竞态、服务OWNER和历史防覆盖；全量回归与提交/CI以根CODEX_REPORT.md实际记录为准。新增migration `20261013000100_merchant_preparation_estimates`；历史migration未改。`scripts/verify-round10b-migrations.ps1` 对固定独立目标验证旧副本升级/全表旧业务事实保留、空库迁移status/diff及重复Seed核心订单/资金/审计表稳定；重复执行不会重置已有空库。
