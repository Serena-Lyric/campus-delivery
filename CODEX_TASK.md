# CODEX_TASK

> **当前没有已授权的 Codex 实现任务。** 上一轮异常并发与争议结算生命周期修复已在 2026-09-27 完成验收，见提交 `349dc2668edcc38098305e2e49094ed5ef2ad4c6`。不要重复执行旧的第三遍审核修补任务。

## 当前阶段：资金责任与异常结算产品设计

- 最新已确认原则：`PRODUCT_DECISIONS.md`（2026-10-08 异常处置分离、骑手责任未完成配送、商家责任已正常送达、平台单笔收入可审计减免）。
- 易损商品取证分级：`FRAGILE_PICKUP_EVIDENCE_DECISIONS.md`（同订单全部易损商品行金额快照合计，严格 >15 提示、>50 强制；折扣分摊、有效媒体及例外仍待细化）。
- 管理员方向：`ADMIN_ROLE_DECISIONS.md`（系统级受保护且不能由后台改变的 Root + 可扩展普通运营层级；首版一级运营、二级暂定客服，现有 OPERATOR/SUPER_ADMIN 不可直接粗暴迁移）。
- 商家货架/履约类别分离、真实交接争议、漏报无责拒取与同一订单更正再入池：`CATALOG_DISPLAY_AND_DELIVERY_CLASSIFICATION.md`；分类候选表见 `FRAGILE_CATEGORY_RESEARCH_2026-10-09.md`，管理员处罚细则未定。
- 详细设计与未决事项：`EXCEPTION_SETTLEMENT_DESIGN.md`。
- 关联运营/角色说明：`EXCEPTION_HANDLING.md`、`ROLE_RESPONSIBILITIES.md`。
- 商家初始配送费资金语义仍等待 W / 真实运营验证：`DELIVERY_PRICING_DECISIONS.md`。

目前**只记录产品决策，未批准业务代码、schema 或 migration 变更**。不得将新的取餐拍照门槛或可扩展管理员权限视为已实现；易损金额已确认按易损商品行金额合计，仍不得擅自选择优惠分摊规则、根账号凭证/恢复细节或财务审批阈值。特别禁止自行调整赔付算法、创建未赚取 rider settlement、推断微信支付冻结能力、决定最长冻结期、自动跨订单扣款或实现未经确认的扣罚。

新的实现需求必须待产品规则收敛后，由本文件重新写入经审核的具体任务、测试、兼容迁移及验收条件。

## 历史任务

2026-09-27 第三遍审核修复已经完成并验收。历史审计详情保留于：
- `AUDIT_THIRD_PASS_2026-09-27.md`
- `AUDIT_SECOND_PASS_2026-09-27.md`
- `AUDIT_HANDOFF_2026-09-27.md`
