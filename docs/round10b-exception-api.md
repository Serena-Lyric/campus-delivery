# 第十轮B：独立暂停、人工恢复与待审退出

依据主产品第1H节及2026-10-13续接确认。C运行时实施与后续D/E范围见 [第十轮B报告](../CODEX_REPORT.md)；E正式终止/真实退款按E3受阻。本文件不新增支付、处罚、Root身份或最终等待分钟数。

| 入口 | 主体/行为 |
| --- | --- |
| `POST /merchant/orders/:id/preparation/unable` | 本店OWNER；expectedVersion/requestKey/reason；追加声明，锁内暂停新claim，不终止订单 |
| `POST /merchant/orders/:id/preparation/recover` | OWNER恢复提议；expectedVersion/requestKey；没有当前骑手、其他冲突且原deadline未来才恢复招募；有正式骑手报告必须等同assignment明确回应 |
| `POST /orders/:id/exceptions` type=MERCHANT_PREPARATION_UNAVAILABLE | 当前骑手的正式报告；description/assignmentId/expectedVersion/requestKey，复用原ExceptionEvent/共享Case，不直接解除 |
| `POST /delivery-tasks/:id/preparation-recovery-response` | 当前同assignment骑手；accept+版本/键；同意恢复原履约，拒绝留承接转人工 |
| `GET /orders/:id/preparation-control` | 归属用户/OWNER/当前骑手/原合法开发SUPER_ADMIN；必要状态、版本、说明，不含内部案件/来源ID |
| `POST /orders/:id/preparation-escalate` | 受影响用户/OWNER/当前骑手可请求人工处理；版本/键/原因；无默认接受或自动解除 |
| `POST /admin/orders/:id/preparation-review` | 必须已合法领取/接管的当前处理人；版本/Case版本/键/原因；可保持暂停、要求当前骑手再明确回应，或核查本店恢复提议后放行原期限内无承接且无冲突订单 |
| `POST /delivery-tasks/:id/request-preparation-exit` | 当前骑手在取餐前的出餐异常流程提出待审退出；只临时释放个人占用，assignment仍ACTIVE，不回池、不自动无责 |
| `POST /admin/orders/:id/preparation-exit-review` | 当前合法处理人；assignmentId/expectedVersion/expectedCaseVersion/requestKey/approve/reason；驳回恢复个人占用，批准才正式解除该assignment，订单仍保留人工门禁，不自动招募或造赔偿 |

状态与OrderStatus独立：NORMAL、UNABLE、RECOVERY_PENDING、MANUAL_REVIEW。Order→Task锁与版本/键/追加审计保护声明、恢复与回应；涉及容量的申请/审查采用Rider→Order→Task→Case，与claim保持一致。商家不能通过重复无法出餐/恢复声明自解人工门禁；案件已升级时普通恢复等待合法接管。人工恢复不能冒充商家提议或骑手同意。

后续正式出餐异议拥有本次出餐类型的来源Case；旧普通案件只处置自身事实，不能清除新的出餐门禁。人工要求骑手再回应、骑手最终接受均在Order锁内核对其他未决Case；另一冲突未处理时不恢复。公共可承接池不展示内部暂停原因原文；有关用户/OWNER/当前骑手仍能查询当前必要说明。

暂停隐藏公共池，直接taskId claim也在锁内拒绝；取餐确认与READY受门禁阻断。暂停过程中原deadline到达只建立一个共享人工案件和SYSTEM升级事件，Order仍保留原履约状态；不计为自然无人承接失败、不自动退款/罚款，不修改firstPublishedAt/claimDeadline/金额/已冻结收益/风险。后台重复扫描、同步查询均幂等。未被骑手承接前的报价/待确认订单也能报告无法制作，恢复前不允许借confirm发布新招募窗口。

**等待时长尚未确定**：recoveryTimeoutSeconds=null、automaticEscalationEnabled=false；没有选定正式分钟数或启用演示倒计时。本轮提供可靠人工升级入口，原市场deadline的升级和骑手恢复回应超时是不同概念。Case领取/转交/释放/升级/接管继续使用既有共享池CAS和审计，不把旧SUPER_ADMIN当Root。

**待审退出容量**：个人计数=ACTIVE且未临时释放的assignment；全局计数=所有ACTIVE、尚未正式解除的assignment（包括处于异常任务状态的未结束承接）。真实claim同时检查个人额度与版本化全局硬上限，第一版10；remainingCapacity取两种剩余数的较小非负值。审核驳回后可出现个人超限，已有合法承接不取消。审核退出与原每天2次个人原因取消/冷却、已有漏报拒取分开；不增加自动取消名额。其他既有合法结束路径会清除临时占用标记，防止已正式结束还占容量。

**资金/终止边界**：本轮出餐控制订单不能通过旧管理员exception入口越权终止，未完成订单不能借另一Case调用旧REFUND_AND_CLOSE创建未赚取骑手收入。恢复后的取餐后配送异常保持既有订单/assignment，另用MANUAL_REVIEW暂停业务推进；合法处理人明确核查继续后才恢复，不自动终止。来源Case与恢复在Order→Task→Case锁内核对，案件升级先提交时普通回应不能放行。本阶段不执行真实退款、不改FINALIZED。正式无骑手协商及简化审核/等待资金事实流仍待E，不把“批准退出一个assignment”说成正式终止整单。

新migration：20261013000300_preparation_control、20261013000400_pending_exit_capacity。已应用SQL不改写；可空审计actor模型显式Restrict，与实际migration一致。新字段默认NORMAL/0/NONE/false，不回补虚假申请/出餐事实。旧副本/空库、完整PG/并发/角色测试及真实SHA/CI见执行报告与连续进度记录。
