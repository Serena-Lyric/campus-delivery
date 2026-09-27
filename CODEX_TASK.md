# CODEX_TASK

## 当前任务：修复第三遍审核发现的异常并发与争议资金生命周期缺口

第二遍实现提交：`2c458b6349a934bec497f54ce75491a9319a74d8`。
第二遍报告提交：`152d2d7fdb5baba71e0d2fe09bad7818a11549ac`。
第三遍独立审核：`AUDIT_THIRD_PASS_2026-09-27.md`。

本轮仍不是扩展新业务，而是继续收口已经能够从现有产品规则确定的异常安全问题。开始前完整阅读并遵守：

1. `AGENTS.md`
2. `PRODUCT_DECISIONS.md`
3. `AUDIT_THIRD_PASS_2026-09-27.md`
4. `AUDIT_SECOND_PASS_2026-09-27.md`
5. `AUDIT_HANDOFF_2026-09-27.md`
6. `AUDIT_FOLLOWUP.md`
7. `EXCEPTION_HANDLING.md`
8. `ROLE_RESPONSIBILITIES.md`
9. `IMPLEMENTATION_PLAN.md`
10. 当前 `CODEX_REPORT.md`

如旧测试/旧代码与已确认安全边界冲突，以产品决策和最新审核为准。不要为了“让测试继续绿”保留已经确认的错误语义。

---

## 0. 本轮明确禁止决定的事项

不要修改或重新解释：

- 商家初始配送金额是真实成本、纯 reference 还是混合概念；
- “商品 50、配送 5、商家结算 45”的待 W 验证假设；
- 严重异常未正常送达时 rider base payout 是否 earned；
- 平台垫付后的长期追偿、future-income deduction、write-off；
- 正式商品佣金、支付通道费、税费；
- severe case 中“责任结论”和“订单操作结果”是否拆成两个字段/两个状态轴；
- stopsDelivery exception 的完整 CONTINUE_FULFILLMENT 恢复流程；
- 特殊本人交接/强制交付码场景的失联最终处理；
- 真实 Jev、动态定价、5 单后自动升降容量。

本轮只能修下面列出的、已经有明确产品依据的问题。

---

## 1. P0：序列化 severe report 与 deliver，关闭并发穿透

### 当前问题

`createSevereRiderExceptionEvent()` 虽然在一个 Prisma transaction 中验证责任 rider + PICKED_UP 并创建 event/case，但没有锁 Order/DeliveryTask。

`deliverTask()` 会按 Order → DeliveryTask 的顺序取得 `FOR UPDATE` 锁，再查询 blocking severe cases。

因此仍可能发生：severe transaction 先普通读取 PICKED_UP，但尚未提交 case；deliver transaction 随后锁 Order/Task 并看到“没有 severe case”，完成 DELIVERED；severe transaction 最后提交 OPEN severe case。

### 必须修复

- dedicated severe report 必须与 deliver 使用同一并发序列化边界。
- 在 severe report 的同一个 transaction 内，按与 deliver 相同的顺序锁定：
  1. Order；
  2. DeliveryTask。
- 锁到后重新读取 order/task 并验证：
  - actor 是当前责任 rider；
  - task 仍是 PICKED_UP；
  - 其他访问规则仍成立；
- 之后再创建 ExceptionEvent/ExceptionCase，并在事务提交前保持锁。
- 不要只做第二次普通 read；必须有行锁、serializable isolation 或等价原子序列化保证。
- 不得采用与 deliver 相反的锁顺序。

### 并发测试

必须写**可控并发**测试，不依赖运气：

1. severe report 先进入受保护临界区，deliver 并发等待；severe 提交后 deliver 必须看到 blocking case 并失败。
2. deliver 先取得 Order/Task 边界并完成，等待中的 severe report 重新验证后必须因 task 已非 PICKED_UP 而失败。
3. 两种时序最终都不得出现 `DELIVERED/COMPLETED + unresolved severe case`。

可使用 test-only barrier/fake classifier/显式 DB 协调；避免长 sleep。

---

## 2. P0：补全 DELIVERY_DISPUTE → case resolution → settlement release 生命周期

### 当前问题

`DELIVERY_DISPUTE` 当前可以把已有 RiderSettlement 的 PENDING/AVAILABLE 改成 HELD；如果 settlement 尚未生成，后续 PENDING release sweep 会检查 unresolved `ExceptionEvent`。

但 case terminal resolution 不会同步 `ExceptionEvent.resolvedAt`，也没有把仅因 `DELIVERY_DISPUTE` 进入 HELD 的 settlement 恢复。因此已经人工处理完成的争议仍可能永久卡住骑手资金。

### 已确认语义

- 争议可以**暂时**冻结与该订单相关的待结算资金；
- terminal resolved case 代表该 case 不再是 unresolved dispute；
- 解除通用 dispute hold 不等于解除 compensation reservation、write-off 或长期追偿；
- 不得无依据解除其他 hold reason。

### 必须修复

#### 2.1 Linked event resolution

- 当 ExceptionCase 真正进入 terminal resolved outcome 时，在同一业务事务里设置其 linked `ExceptionEvent.resolvedAt`。
- 至少覆盖：
  - `resolveNonEconomicCase()` 的 terminal 分支；
  - customer accepted remake 的 terminal RESOLVED；
  - `refundAndCloseExceptionCase()` 的 terminal refund resolution。
- WAITING_FOR_PARTICIPANT、OPEN、IN_PROGRESS、ESCALATED、release/transfer/takeover 等非终态不得设置 event resolvedAt。
- customer remake reject 回 OPEN/IN_PROGRESS 不得设置 resolvedAt。

#### 2.2 Dispute hold release

对 `DELIVERY_DISPUTE` terminal resolution：

- 只有当同一 order 不再存在其他 unresolved DELIVERY_DISPUTE event/case 时，才解除该订单的通用 dispute hold。
- 只自动处理 `RiderSettlement.status=HELD AND holdReason=DELIVERY_DISPUTE`；不能误解除 `COMPENSATION_OBLIGATION`、其他未来 hold reason 或未知 hold。
- 恢复状态：
  - `pendingUntil > now` → PENDING；
  - `pendingUntil <= now` 且无其他阻塞 → AVAILABLE；
- 清理 dispute `heldAt/holdReason`。
- `reservedMinor` 原样保留。即使 status 恢复为 PENDING/AVAILABLE，withdrawable 仍须继续减去 reservation；解除 dispute hold 不是解除赔付 reservation。

#### 2.3 Reconciliation / sweep

- 修改现有 settlement sweep 或增加等价幂等 reconciliation，使系统能修复：`HELD solely by DELIVERY_DISPUTE` 且实际已无 unresolved dispute 的 settlement。
- 这样即使 terminal-resolution transaction 后进程异常/历史数据遗留，也不会永久卡死。
- reconciliation 仍只处理明确的 DELIVERY_DISPUTE hold，不泛化释放所有 HELD。

### 必须测试

至少：

1. AVAILABLE → dispute → HELD → terminal resolve → AVAILABLE；
2. PENDING → dispute → terminal resolve（pendingUntil 尚未来）→ PENDING → 到期 sweep → AVAILABLE；
3. 两个 dispute cases：解决第一个仍 HELD，全部解决后才恢复；
4. dispute hold + `reservedMinor > 0`：解除 dispute 后 reservation 不变，withdrawable 仍正确；
5. WAITING / ESCALATED 等非 terminal 不设置 ExceptionEvent.resolvedAt、不释放 hold；
6. reconciliation 对历史/模拟的“HELD by dispute but event 已 resolved”可幂等恢复；
7. reconciliation 不碰其他 holdReason。

### 并发/原子性

- terminal resolution、linked event resolvedAt、直接触发的 hold recovery 必须在一致事务边界内，避免 case 已 RESOLVED 但 event/hold 半更新。
- 多 dispute 并发 resolution 时不能提前释放；必要时锁 settlement/order 或用条件查询/行锁保证最终一致。

---

## 3. P1：修正 remake reject 的 action audit 语义

### 当前问题

customer reject remake 时：

- 有 handler → case 回 IN_PROGRESS，handler 继续保留；
- 无 handler → case 回 OPEN。

但两条路径都记录 `ExceptionCaseActionType.RELEASED`。尤其前者根本没有 release handler，却在 audit log 中写 RELEASED。

### 必须修复

- participant remake reject 使用独立、准确的 action type，不冒充 admin handler release。
- 可新增类似 `REMAKE_REJECTED` / `PARTICIPANT_RESPONDED` 的 enum；命名按仓库风格选择。
- `/admin/.../release` 的 `RELEASED` 继续只表示案件/处理权真正释放。
- migration 必须新增，不能改已执行 migration。
- action metadata 保留 proposal id / resulting state 等足够审计信息。

### 测试

- handler-preserving reject 的 audit 不包含虚假 handler RELEASED；
- no-handler reject 同样记录 participant rejection 的真实 action；
- admin release 仍记录 RELEASED。

---

## 4. P1：同步普通管理员“补餐继续”角色文案

`ROLE_RESPONSIBILITIES.md` 当前普通管理员列表中的“确认补餐继续”过于宽泛。

修正为：

- 普通管理员可处理/核对补餐继续流程；
- 对 `SEVERE_FOOD_DAMAGE / FOOD_LOST`，管理员不能替代用户确认继续等待；只有用户明确接受 proposal 才形成 `REMAKE_AND_CONTINUE`。

只修 truth-source/角色表述，不引入新业务。

---

## 5. 保持第二遍已经修好的边界

回归必须保证：

- general exception endpoint/service 不能创建 severe self-report；
- dedicated severe 必须责任 rider + PICKED_UP；
- severe admin CONTINUE_FULFILLMENT 被拒；
- delivery 检查所有 severe cases；
- customer accepted REMAKE_AND_CONTINUE 才能解除 severe normal-delivery block；
- remake reject handler/state invariant；
- ESCALATED_OTHER public resolve 被拒，真实升级走 /escalate；
- WRONG_ADDRESS 只记录事实、不自动开 case；
- merchant/pickup/destination snapshots 不漂移；
- default commission=0；
- compensation reservation release 不 write-off；
- non-zero self-reported payment 不得伪造 funding；
- pause/cooldown 只阻止新 claim；
- capacity / pricing / rescue / tip / subsidy / classifier / role isolation 既有回归继续通过。

---

## 6. 本轮只记录、禁止擅自处理的设计缺口

阅读 `AUDIT_THIRD_PASS_2026-09-27.md` 第 5 节：

- severe + RESPONSIBILITY_UNDETERMINED 暴露“责任结论 vs 订单操作结果”单轴 resolution 冲突；
- stopsDelivery exception 的 CONTINUE_FULFILLMENT 目前没有完整恢复 order/task/assignment 的已确认设计。

本轮**不要**自行新增责任枚举、拆状态轴、重开 terminal case、恢复 task 或设计新的异常 outcome。报告中继续明确列为 unresolved。

---

## 7. 验证与报告

先针对性测试，再完整执行：

- `pnpm typecheck`
- unit tests
- PostgreSQL integration tests
- build
- current DB migration status
- migration/schema drift
- empty DB all migrations + idempotent Seed

Docker 继续遵守 `AGENTS.md`：最多一次安全 restart；禁止 factory reset / clean / purge / 删除项目 volume / 删除用户数据目录。

完成后：

1. 普通 commit + push `main`，不 force push；
2. 更新根目录 `CODEX_REPORT.md`；
3. 报告逐项对应任务 1–4，并给出 runtime enforcement point + test；
4. 明确本地验证不等于独立 CI；
5. 明确第 6 节两个设计缺口、merchant initial funding、severe-failure earned rider base、长期追偿等仍未决定；
6. 不自行进入下一阶段。
