# 第十轮B：订单变更告知与独立风险核查

依据 PRODUCT_DECISIONS 第1H节2026-10-13续接确认。通知只传递自报事实，不审批商家与用户的替换，不修改原商品、金额、结算、风险快照，也不证明付款或物理交接。

| 入口 | 实际约束 |
| --- | --- |
| POST /merchant/orders/:orderId/change-notices | 本单OWNER、取餐/终止前；content/riskDeclaration/expectedVersion/requestKey；只追加版本历史和商家名称快照 |
| GET /orders/:orderId/change-notices | 本单用户、OWNER、合法当前承接骑手、既有开发SUPER_ADMIN；必要文本、时间、声明及门禁状态，内部处理人/键/来源案件不公开 |
| POST /delivery-tasks/:taskId/change-notices/:noticeId/acknowledge | 当前assignment；一次服务器知悉时间，重试幂等；新通知/新承接不继承，不要求知悉才能取餐 |
| POST /orders/:orderId/exceptions，type=GOODS_CHANGE_OBJECTION | 现有举报入口；当前assignment、expectedVersion/requestKey、description、可选noticeId/evidenceIds；原共享ExceptionCase中人工核查，不自动解除或判责 |
| POST /admin/orders/:orderId/goods-change-review | 当前合法处理人、Case/变更双版本、键、原因；记录无新增核心易损的核查事实或继续保留未知/新增风险，原保护仍并行 |

声明值：NO_ADDITIONAL_CORE_FRAGILE（明确无新增核心易损）、ADDITIONAL_CORE_FRAGILE（存在新增核心易损）、UNASSESSED（无法确定/未核定）。后两态马上设独立goodsChangeReviewPending门禁并创建共享风险案件；后续无风险声明不能自己清除门禁。公共池仍展示必要通知与原风险，claimable=false；直接claim、商家取餐确认、READY和正常送达在同一Order锁内拒绝；原deadline到达不冒充自然无人愿接单退款。

NO_ADDITIONAL_CORE_RISK_CONFIRMED是有权限人员核查“没有新增核心易损”的事实，不是审批替换、核定新价格或许可绕过照片/交接码。其他未决冲突、陈旧通知/Case版本或已升级案件不能借此恢复履约。可以先核实本域事实，同时保留独立的出餐/待审退出门禁；这不取消退出请求或放行取餐，随后仍须合法处理其案件。实际新增核心易损、实际价值不明、证据不能安全确定继续HOLD_UNRESOLVED_RISK；本轮没有新的估价/资金规则、替换风险重算或安全取证例外放行。原漏报风险报告/纠正、未实际交接异议及已核定无责拒取仍可用，它们不能清除本门禁，也不能利用原低价格放行未知新增风险。

通知、知悉和变更动作有追加审计及UPDATE保护。骑手知悉不是同意替换、放弃举报/取证或无责权利；原核心易损REQUIRED照片与PICKUP_CODE仍须同时满足。离开承接的原骑手不再获取新通知或代新assignment知悉。站内轮询/订单和持单查询即时可用，没有真实微信/SMS推送或完整小程序UI。

005迁移仅隔离测试、恢复副本与空库验证；主库未升级。实现SHA/本地和CI证据以连续记录与最终报告为准。
