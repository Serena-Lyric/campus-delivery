# CODEX_TASK

## 当前状态：暂停新的业务代码实现

上一轮实现提交：`d0edaf1031ccdcc5f3835ae0dbff5e8b37a90de7`。
上一轮报告提交：`ae406cf62831edeb7f776324a0dec2e25181d9f8`。

代码审核尚未完全通过。开始任何新实现前，必须完整阅读：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `AUDIT_FOLLOWUP.md`
4. `DELIVERY_PRICING_DECISIONS.md`
5. `RIDER_CAPACITY_DECISIONS.md`
6. `ORDER_POOL_DECISIONS.md`
7. `ROLE_RESPONSIBILITIES.md`
8. `EXCEPTION_HANDLING.md`
9. `OPERATIONS_CONTEXT.md`
10. `CODEX_REPORT.md`

### 当前禁止自行继续的事项

在用户与 ChatGPT 完成下一轮产品确认前，不要修改 business code、Prisma schema、migration、Seed 或 pricing/settlement/compensation runtime。

尤其不要自行决定：

- 商家初始配送金额到底只是 pricing reference，还是从商品结算中实际扣除的商家出资；
- 是否把当前 reference-only pricing 继续扩展为最终模型；
- 商家 pre-claim 初始配送金额能否降低；
- 严重异常未正常送达时 rider base payout 是否仍视为已 earned；
- rider voluntary payment 如何真正对应可提现余额/外部付款；
- 商品佣金、支付费率、税费或其他收入规则。

这些边界已经在 `AUDIT_FOLLOWUP.md` 中列明，其中商家初始配送费结算方式需要结合 W 的实际运营经验验证。

### 已审核方向

以下方向无需回滚，但后续修改仍须保持兼容：

- 单日未取餐无责取消真正封顶；
- ExceptionCase terminal/status/version/idempotency 安全边界；
- 骑手容量第一版 1 → 首单正常完成后同日 2 → 下一校园自然日 5；
- 第一版平台全局绝对容量 10，SUPER_ADMIN 可做单 rider override；
- 降低容量只阻止新 claim，不破坏已持订单；
- rider order-pool 至少提供保证收益、取餐点、目的地、物品粗分类、数量/携带量事实；
- Jev/AI 物品分类保持低风险辅助，失败不能阻塞业务，也不能直接影响资金、责任、容量、处罚或接单资格；
- 用户红包 100% 给骑手；
- 商家在无人接单后的**新增救单出资**第一版 100% 传给骑手；
- 平台补贴独立记账并消耗平台风险预算/贡献。

### 下一步

等待用户/ChatGPT 新一轮明确任务。收到新任务前只允许读取和分析，不自行开始修复。
