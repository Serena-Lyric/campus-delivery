# CODEX_TASK

执行仓库根目录 `IMPLEMENTATION_PLAN.md` 中“下一轮：商家履约风险、曝光策略与 24 小时骑手激励”的全部内容。

开始前完整阅读：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `IMPLEMENTATION_PLAN.md`
4. 当前 Prisma schema / migrations / Seed
5. merchant-policy、subsidy、pricing、catalog、orders、exceptions、admin config、相关测试和 README/OpenAPI

优先级：

- `PRODUCT_DECISIONS.md` 是已确认产品规则，最高优先级。
- `IMPLEMENTATION_PLAN.md` 是本轮实现范围。
- 现有代码如果与两者冲突，以产品决策和本轮计划为准。
- 不得把 Seed、旧 exposureForUsage 行为、旧 riskScore 命名或 Codex 自己的推荐方案升级成产品规则。

本轮必须完成：

- 24 小时 RiderTip 服务端窗口，包括送达后仍可在窗口内追加。
- 移除 subsidy usage → exposureState 的直接自动联动。
- 建立商家履约事实指标层。
- 独立 timeRisk / completionRisk。
- 建立可配置、带最低样本和 hysteresis 的曝光策略基础。
- 新商家 TRIAL / insufficient-data 语义。
- 管理员配置、审计和角色隔离查询。
- 必要 migration、测试、README/OpenAPI。

本轮不得擅自完成：

- 未确认的失败责任归因；
- 单一综合商家评分；
- AI 判责；
- 骑手处罚；
- 单账号多角色；
- 真实支付/退款/提现；
- 完整管理前端。

Docker/PostgreSQL 验证严格遵守 `AGENTS.md`。遇到 Docker Desktop GUI 异常时，不要假设用户能及时转发弹窗；先通过 CLI 检查/诊断。绝对禁止为了测试通过自动执行 destructive reset/cleanup。

完成后：

1. 运行计划要求的全部验证。
2. 更新 README/OpenAPI。
3. 提交并 push 到 main，禁止 force push。
4. 在根目录生成 `CODEX_REPORT.md`，逐项回答 `IMPLEMENTATION_PLAN.md` 的审核重点，记录起止 commit、migration、测试、Docker/基础设施情况、已知问题和刻意未实现内容。
5. 完成后停止，不自行开始下一阶段。
