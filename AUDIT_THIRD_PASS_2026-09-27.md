# AUDIT_THIRD_PASS_2026-09-27

> 第三遍独立审核对象：实现提交 `2c458b6349a934bec497f54ce75491a9319a74d8`，报告提交 `152d2d7fdb5baba71e0d2fe09bad7818a11549ac`。
> 本文件记录实际 runtime / state / money lifecycle 审核结论，不创造新的商业规则。产品边界仍以 `PRODUCT_DECISIONS.md` 为最高依据。

## 0. 审核结论

本轮 `CODEX_TASK.md` 中第二遍审核列出的 1–9 项，代码层面基本都已真实落地：

- general exception route 与 service 都拒绝 `SEVERE_FOOD_DAMAGE / FOOD_LOST`；
- dedicated severe route 限制责任骑手 + PICKED_UP；
- severe `CONTINUE_FULFILLMENT` 不再替代 customer-confirmed `REMAKE_AND_CONTINUE`；
- delivery 检查全部 severe cases，不再只看最新一条；
- remake reject 不再产生 `OPEN + handler` 卡死状态；
- public resolve 已封住 `ESCALATED_OTHER` 伪升级；
- rider pool 恢复了不可漂移的 merchant-name snapshot；
- `WRONG_ADDRESS` 只记录事实，不自动进入 admin pool；
- pause/cooldown 与 wrong-address 的产品文档漂移已同步。

因此第二遍任务本身不是“大面积未实现”。但第三遍沿并发与资金生命周期继续审核后，仍发现两个会破坏已确认安全边界的实质问题，当前仍不能删除 `CODEX_REPORT.md` 或把异常闭环判定为完全验收。

另外，报告中的 typecheck / unit / PostgreSQL integration / build / migration / seed 均是 Codex 本地验证自报；当前实现/报告提交没有可见的独立 GitHub Actions combined status，不能表述为独立 CI 复验。

---

## 1. P0：severe report 与 deliver 仍存在并发穿透窗口

### 当前代码

`createSevereRiderExceptionEvent()` 已经把“责任骑手 + PICKED_UP + 创建 event/case”集中到同一个 Prisma transaction，这是对上一版先查后另事务创建的改进。

但该事务只普通读取 `Order/DeliveryTask`，没有像 `deliverTask()` 那样对 Order 与 DeliveryTask 取得行锁。

`deliverTask()` 当前顺序是：

1. `SELECT Order ... FOR UPDATE`；
2. `SELECT DeliveryTask ... FOR UPDATE`；
3. 重新读取 task；
4. 查询 severe cases；
5. 若无 blocking case，则完成 DELIVERED。

severe report transaction 没有参与这组锁，因此仍可能发生：

1. severe report 读取 task=PICKED_UP，但尚未创建/提交 case；
2. deliver 锁住 Order/Task，查询 severe cases，此时看不到未提交或尚未创建的 severe case；
3. deliver 正常提交 DELIVERED；
4. severe report 随后创建并提交 OPEN severe case。

最终得到 `Order/Task 已正常完成 + 仍有未处理 severe case`，违反“严重餐损/丢失必须在继续送达前处理完”的已确认规则。

### 必须修复

- dedicated severe report 必须与 `deliverTask()` 对同一订单采用一致的并发序列化边界。
- 推荐最小方案：在 severe report 的同一 transaction 中，按与 deliver 相同的顺序锁定 **Order → DeliveryTask**，然后重新读取并验证 responsibility/status，再创建 ExceptionEvent/ExceptionCase。
- 如果 deliver 先拿锁并完成，severe report 等待后必须重新看到 task 已非 PICKED_UP 并拒绝；如果 severe report 先拿锁并提交 case，deliver 等待后必须看到 blocking severe case 并拒绝。
- 不要只增加一次普通 re-read；没有锁/等价串行化时仍存在竞态。
- 注意保持固定锁顺序，避免引入 Order/Task 反向锁导致死锁。

### 必须测试

增加可控并发回归，不要只写两个顺序调用：

- severe report 持有相同 Order/Task 保护边界时并发发起 deliver，最终不能出现 DELIVERED + unresolved severe；
- deliver 先完成时，随后/等待中的 severe report 必须因 stage 改变而失败；
- severe report 先提交时，deliver 必须因 blocking severe case 失败。

可以使用测试 barrier/fake classifier/显式 transaction 协调并发，不依赖随机时序或长 sleep。

---

## 2. P0：DELIVERY_DISPUTE 冻结只有“进入”，没有“解决后退出”

### 当前代码

`createExceptionEvent()` 对 `DELIVERY_DISPUTE`：

- 若 RiderSettlement 已经存在且为 PENDING/AVAILABLE，会把它改为 `HELD`，写 `heldAt` 与 `holdReason=DELIVERY_DISPUTE`。

`releaseAvailableRiderSettlements()`：

- 只扫描 `status=PENDING` 的 settlement；
- 只有当订单不存在 `DELIVERY_DISPUTE + resolvedAt=null` 的 ExceptionEvent 时，才会释放为 AVAILABLE。

但目前 `resolveNonEconomicCase()`、`refundAndCloseExceptionCase()` 等 case 终结路径只更新 `ExceptionCase.resolvedAt/status`，没有同步设置关联 `ExceptionEvent.resolvedAt`；也没有把 `holdReason=DELIVERY_DISPUTE` 的 HELD settlement 恢复到 PENDING/AVAILABLE。

结果：

- 争议在骑手结算生成前发生：后续 settlement 会一直因为 linked dispute event `resolvedAt` 仍为 null 而无法从 PENDING 释放；
- 争议在 settlement 已存在后发生：settlement 会进入 HELD，而当前后台 sweep 根本不扫描 HELD，因此管理员把 case 处理完后资金仍可永久卡住。

这与已确认的“争议可以**暂时**冻结相关待结算资金；最终人工处理可审计”不一致。

### 已确认边界

本轮不需要决定新的赔付比例、长期追偿或钱包规则。这里只需要让“争议是否仍 unresolved”与 settlement hold 的生命周期一致。

### 必须修复

1. 当一个 ExceptionCase 真正进入 terminal resolved outcome 时，在**同一业务事务**中同步把其关联 `ExceptionEvent.resolvedAt` 标为 resolved（等待/升级/退回池时不能误标）。
2. 对 `DELIVERY_DISPUTE`：只有当该订单**不存在其他未解决 DELIVERY_DISPUTE** 时，才允许解除该 dispute 带来的通用 settlement hold。
3. 只自动解除 `holdReason=DELIVERY_DISPUTE` 的 hold；不得误解除 compensation、其他高风险原因或未来新增 hold。
4. 恢复状态必须尊重原结算时间：
   - 若仍未到 `pendingUntil`，恢复为 PENDING；
   - 若等待期已经到期且没有其他阻塞，允许 AVAILABLE；
   - 已有 `reservedMinor` 继续作为 reservation 生效，解除 dispute status hold 不等于解除赔付 reservation。
5. 清理对应 `heldAt/holdReason` 时保持审计/状态可解释。
6. 最好让后台 settlement sweep 具备幂等 reconciliation 能力：即使某次同步释放因进程异常未完成，后续 sweep 也能识别“HELD solely by DELIVERY_DISPUTE but no unresolved dispute”并恢复，避免永久卡死。
7. 多个 dispute case 并存时，一个 case resolved 不得提前释放；全部相关 dispute 都 resolved 后才释放。

### 必须测试

至少覆盖：

- AVAILABLE settlement → DELIVERY_DISPUTE → HELD → case terminal resolve → AVAILABLE；
- PENDING settlement → DELIVERY_DISPUTE → resolve 且仍未到 pendingUntil → PENDING，之后正常 sweep → AVAILABLE；
- 两个 DELIVERY_DISPUTE 并存，只解决一个时仍保持 hold；全部解决后才恢复；
- dispute + compensation reservation 并存时，解除 dispute hold 不清零 `reservedMinor`，withdrawable 仍受 reservation 限制；
- WAITING/ESCALATED/non-terminal case 不得把 linked event 标为 resolved 或释放资金。

---

## 3. P1：remake reject 的 action audit 语义仍不准确

`respondToRemake(... accept=false)` 现在正确地：

- 有 handler → 回 IN_PROGRESS 并保留 handler；
- 无 handler → 回 OPEN。

但两种路径仍统一写 `ExceptionCaseActionType.RELEASED`。

当 handler 被保留时，case 并没有被 release 到共享池；审计日志却记录 RELEASED，容易让后台审计或以后自动化误判“处理人释放了案件”。

### 建议修复

- 为 participant remake reject 使用不冒充 handler-release 的明确 action（例如新增 `REMAKE_REJECTED` / `PARTICIPANT_RESPONDED`；具体枚举命名可按现有风格选择）。
- admin `/release` 继续独占“案件/处理权释放”的 `RELEASED` 语义。
- 如果 reject 后无 handler 而 case 回 OPEN，可以通过 metadata/state 表达“重新回池”，也不要把 customer action 伪装成 admin handler release。
- 增加 action audit 回归。

该项是审计语义一致性，不改变业务结果。

---

## 4. P1：角色文档仍有一句容易误解 severe customer-confirmation 边界

`ROLE_RESPONSIBILITIES.md` 普通管理员章节仍写“确认补餐继续”。单看该句容易理解为管理员可以替用户确认，而当前产品与 runtime 已明确：严重餐损/丢失的 remake-and-continue 必须由用户明确接受。

同步成更准确的角色表述，例如：

- 普通管理员可以处理/核对补餐继续流程；
- 对严重餐损/丢失，管理员不能替代用户作出继续等待确认，只有用户明确接受后才形成 `REMAKE_AND_CONTINUE`。

不改变 runtime。

---

## 5. 已发现但本轮不要让 Codex自行决定的产品/模型缺口

以下问题是真实存在的，但会触及尚未完全确认的异常 outcome 模型，本轮只记录，不自动设计：

### 5.1 severe + RESPONSIBILITY_UNDETERMINED 的单轴 resolution 冲突

当前普通 admin 可以把 severe case terminal resolve 为 `RESPONSIBILITY_UNDETERMINED`。但 `deliverTask()` 又只允许 severe case 为 `REMAKE_AND_CONTINUE` 才继续送达；terminal case 之后也不能再改成 refund/remake。

因此可能得到：case 已 RESOLVED，但订单仍 PICKED_UP 且永远不能正常 deliver；同一 case 也不能继续做经济/履约结果选择。

这暴露了一个模型问题：**“责任判断结果”与“订单操作结果（remake/refund/end/continue）”目前被塞进同一个 resolutionType。**

产品此前已确认“责任无法确定/证据不足可以是有效人工判断结果”，同时 severe 订单仍需要明确的用户履约/退款结果。后续应专门设计两者是否分轴保存，而不是让 Codex临时挑一个语义。

### 5.2 stopsDelivery exception 的 CONTINUE_FULFILLMENT 恢复语义

`CUSTOMER_UNREACHABLE`（不允许无人放置）或 `RIDER_DELIVERY_EXCEPTION` 会把 Order/DeliveryTask/Assignment 推进 EXCEPTION；但通用 `CONTINUE_FULFILLMENT` 当前只 resolve case，不恢复 task/order/assignment。

这意味着“CONTINUE_FULFILLMENT”对这类真正停止了 delivery 的 case 并不能真的继续履约。

特殊本人交接失联边界、原骑手无法继续后的具体平台流程仍有未决内容，因此本轮先记录，不自行恢复状态机。

---

## 6. 第三遍验收口径

在第 1、2 两个 P0 修复并通过实际代码审核前：

- 保留 `CODEX_REPORT.md`；
- 不将异常订单/争议资金闭环标为完全验收；
- 不进入依赖 W 的 merchant initial funding 设计；
- 不让 Codex自行处理第 5 节的 outcome 模型缺口。

第 3、4 项建议本轮一并收口，避免继续积累审计/文档歧义。
