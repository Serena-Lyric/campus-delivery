# CODEX_TASK

请执行仓库根目录 `IMPLEMENTATION_PLAN.md` 中“下一轮：市场报价、接单时限与策略纠偏”的全部内容。

开始前必须完整阅读：
1. `PRODUCT_DECISIONS.md`
2. `IMPLEMENTATION_PLAN.md`
3. 当前 Prisma schema、migration、README、相关 service/policy/tests

优先级：
- `PRODUCT_DECISIONS.md` 是已确认产品规则，优先级最高。
- `IMPLEMENTATION_PLAN.md` 是本轮工程执行方案。
- 现有代码与旧设计文档若与上述两份文件冲突，以根目录两份文件为准。
- 不得把 Seed、旧实现或 Codex 自己的推荐方案升级为新产品规则。

本轮重点：
- 修正当前“骑手接单后可主动 abandon 回池”的偏差：正常流程接单即承诺，不提供主动反悔/放弃。
- 商家确认后即可进入骑手池，商家备餐/可取只是信号，实际 pickup 才是重要交接事实。
- 商家订单级报价、15 秒第一版改价冷却、报价历史、接单瞬间原子价格快照。
- 用户骑手激励独立记账：接单前可调整/撤回；接单后仍可追加；100% 归骑手；平台不抽成。
- 40 分钟第一版接单时限，固定 firstPublishedAt / claimDeadline。
- 平台补贴改为独立、可追溯、逐步追加，不再使用 targetRiderPayout 自动补满。
- 实现补贴资格 / 时点 / 增量三个策略边界，以及自然接单样本与补贴后样本隔离。
- 普通正常订单的照片 Evidence 恢复为可选；风险订单、失联等场景再按规则强制。
- 管理员业务配置与审计基础按计划实现，不要求完整管理前端。
- 不修改单账号单角色模型；该问题仍未决。
- 国内校园默认时区语义改为 Asia/Shanghai 或要求显式配置。

约束：
- 不实现未确认的复杂评分、自动判责、自动处罚、自动派单、路线规划、AI 规则。
- 所有金额保持整数最小货币单位。
- 所有价格承诺、报价变更和资金来源必须可追溯。
- 并发修改报价、接单、补贴时必须保证服务端原子性和数据库一致性。
- 需要正式 migration，不得只改开发数据库。

完成后：
1. 运行全部 unit/integration tests、typecheck、build。
2. 验证 migration 可从当前数据库升级，也可从空库完整执行。
3. 更新 README/OpenAPI。
4. 提交并 push 到 main，禁止 force push。
5. 在仓库根目录生成 `CODEX_REPORT.md`，逐项回答 `IMPLEMENTATION_PLAN.md` 最后的审核重点，并记录起止 commit、migration、测试结果、已知问题和刻意未实现内容。
6. 完成后停止，不自行开始下一阶段。
