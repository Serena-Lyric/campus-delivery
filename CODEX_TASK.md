# CODEX_TASK

执行仓库根目录 `IMPLEMENTATION_PLAN.md` 中“下一轮：审核修正 + 骑手容错 + 异常订单池 + 管理员分权”的全部内容。

开始前完整阅读并按优先级理解：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `IMPLEMENTATION_PLAN.md`
4. `EXCEPTION_HANDLING.md`
5. `ROLE_RESPONSIBILITIES.md`
6. `OPERATIONS_CONTEXT.md`
7. 当前 Prisma schema / migrations / Seed / README / OpenAPI
8. merchant-risk、catalog、orders、delivery、pricing、settlements、exceptions、admin config/auth 等相关代码与测试

## 优先级

- `PRODUCT_DECISIONS.md` 是产品规则最高依据。
- `IMPLEMENTATION_PLAN.md` 是本轮执行范围。
- `EXCEPTION_HANDLING.md` 定义第一版异常运营/技术工作流，但不得覆盖产品决策。
- `ROLE_RESPONSIBILITIES.md` 是角色视图，不能创造新规则。
- 旧代码、Seed、旧测试或你自己的推荐方案如与以上冲突，必须以已确认规则为准。

## 本轮执行顺序

### 第一阶段：先修上轮 6 个已知审核缺口

必须先完成并测试：

1. TRIAL 真正灰度曝光；
2. 曝光策略真实使用已确认的 completion/no-rider + subsidy health 因素，不再伪装多因素；
3. recovery minimum sample/window；
4. subsidy rescue metric terminal denominator；
5. customer catalog/raw ORM 数据泄漏；
6. rolling terminal/live metric 样本集合分离。

不要在这些已知问题未修正时继续堆新功能然后在报告里写“后续再处理”。

### 第二阶段：骑手未取餐无责取消与限制

实现：

- pre-pickup responsibility-free cancel；
- assignment 历史保留；
- 订单重新入原池；
- firstPublishedAt / claimDeadline 绝不刷新；
- 单日第 1 次记录、第 2 次 warning + 当日暂停新接单；
- 7 天 2-warning → 2 天 cooldown；
- 尚未触发第 2 次 warning 时，7 天累计 4 次取消 → 2 天 cooldown，不补记第二 warning；
- 全部阈值版本化配置；
- pause/cooldown 只阻止新 claim，不破坏已持订单；
- super-admin restriction override + audit。

### 第三阶段：严重餐损/丢失 + 赔付资金模型

实现：

- severe damage/loss report；
- remake-and-continue proposal；
- customer confirm/reject；
- refund-and-close；
- RiderTip 与订单退款独立；
- compensation obligation；
- 本单未提现资金 reservation；
- 其他未提现余额 reservation；
- rider voluntary payment/transfer 记录；
- platform advance / outstanding 记录；
- 每笔来源和用途可审计；
- 并发下同一余额不能被重复 reserve。

不要实现真实支付网关，不要实现无限负余额、未来收入自动追债或未确认的自动停接单规则。

### 第四阶段：异常订单池与管理员分权

实现：

- ExceptionCase/work queue；
- 普通管理员自行领取；
- exactly-one-active-handler 等效安全保证；
- release/transfer/takeover/escalate audit；
- refund/freeze/release/close 幂等或 version protection；
- ADMIN 内部分 OPERATOR / SUPER_ADMIN，不改变普通业务账号多角色问题；
- 普通管理员可以实际完成日常人工判断和标准异常处理；
- 复杂、高风险、权限不足的 case 升级 super admin；
- super admin 管理全局 config / admin rights / high-risk overrides；
- 审计现有所有 `/admin/**` endpoint 并给出权限矩阵。

### 第五阶段：AI/Jev 分类边界

- 建立 `ExceptionClassifier` 或等价 typed adapter；
- 保存分类 source/version/result/confidence，与最终人工处理结论分离；
- 提供 deterministic/manual/no-op fallback；
- 不要求真实 Jev 网络调用；
- AI 不得执行 liability/refund/freeze/penalty/restriction。

如果没有真正调用 Jev，报告必须写 `adapter/hook ready, not active`，不能写成“Jev 已实现/上线”。

## 重要约束

- 严格遵守 `AGENTS.md` 的 implementation truthfulness、API role isolation、Docker 和 exception safety 规则。
- 不把进行中订单静默计入失败/救援失败分母。
- 不把所有 exception 自动归责商家或骑手。
- 不做单一综合风险分。
- 不让 ordinary admin 直接绕过 ledger 任意输入扣款。
- 不返回 raw ORM 到 customer/merchant/rider API。
- 所有钱使用整数 minor unit。
- 所有关键资金、限制、handler ownership 变化可审计。
- 所有高风险动作需要 transaction + idempotency/version/unique invariant 等安全保护。
- 不修改单账号单业务角色模型。

## Docker

Docker Desktop 已更新，但仍严格按 `AGENTS.md`：

- Docker/PostgreSQL 验证前 CLI health check；
- 失败最多一次安全 restart；
- 再失败收集 diagnostics/logs 并报告；
- 禁止 factory reset、clean/purge data、删除 volumes/data 等破坏性恢复。

## 完成条件

1. 完成 `IMPLEMENTATION_PLAN.md` 全部范围；
2. 更新必要 README/OpenAPI；
3. typecheck；
4. unit tests；
5. PostgreSQL integration tests；
6. build；
7. current DB migration status/drift；
8. current DB migrate；
9. empty DB full migration；
10. Seed 连续至少两次；
11. 并发领取、重复退款/冻结、余额 reservation 等安全测试通过；
12. 提交并 push 到 `main`，禁止 force push；
13. 根目录生成 `CODEX_REPORT.md`，逐项回答 `IMPLEMENTATION_PLAN.md` 的 19 个审核问题，提供起止 commit、migration、权限矩阵、测试结果、Docker 情况、已知问题、刻意未实现内容；
14. 完成后停止，不自行进入下一阶段。
