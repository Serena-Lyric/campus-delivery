# 第十轮B：整单无法制作协商与安全人工核查

本轮按 CODEX_TASK E3 实施安全降级：协议及简化事实核查/等待可信资金事实可用，**正式终止和真实退款不可执行**。没有可信外部支付/退款适配器，旧REFUND_AND_CLOSE不能安全地与内账/未赚取骑手收入分离；不能为了结案构造退款成功。主产品1H/1G与异常财务边界优先。

| 入口 | 当前行为 |
| --- | --- |
| POST /orders/:orderId/preparation-negotiation/statements | 仅本单用户/OWNER；expectedVersion/requestKey/text；服务端身份和时间；PROPOSE/CONFIRM/DISPUTE与退款进度分开，追加不可覆盖 |
| GET /orders/:orderId/preparation-negotiation | 本单双方及既有开发SUPER_ADMIN查询必要陈述、协议是否成立、核查状态；骑手和无关者拒绝，无内部actorId/请求键/CaseId |
| POST /admin/orders/:orderId/preparation-negotiation-review | 当前合法处理人；expectedVersion/expectedCaseVersion/expectedPreparationVersion/requestKey/outcome/reason；核查后仍WAITING_FOR_PARTICIPANT，不终止或处分资金 |

PROPOSE须明确wholeOrderUnavailable=true及整数分refundMinor，基于商家当前本单无法制作声明；CONFIRM/DISPUTE绑定最新proposalVersion。必须双方分别明确CONFIRM同一提议、同一金额，才agreementEstablished=true；提出提议本身不冒充双方确认。新提议使旧确认失效，后续异议撤回当前确认但保留原陈述。原订单商品/金额未修改，reportedRefundMinor不证明已支付。

REFUND_SENT只允许OWNER自述，REFUND_RECEIVED只允许用户自述；仍属自报，不能将其变成渠道提交或成功。不实现部分退款动作；有不同金额陈述保留并走普通核查。

SIMPLIFIED_WAITING_FOR_FUNDS仅表示有权限人员对整单协议基础事实做简化核查：双方最新确认一致、等于原整单商品款+用户配送费+当前用户骑手红包、退款进度无金额冲突、无任何assignment历史及其他未决案件、商家未改为恢复提议。当前有骑手不能使用此协议入口；曾经承接后正式退出的历史仍保留，只允许普通核查，不抹去骑手权益。REGULAR_REVIEW用于分歧、金额或事实冲突及其他不满足条件的记录；没有资金授权额度或责任规则被自动决定。

三版本、真实Order→Task→Case锁、当前handler与合法案件状态保护核查，普通SUPER_ADMIN不能绕过handler。升级先提交时普通核查拒绝，终态不重开。即时同键重试幂等，后续协议/准备/Case事实改变则拒绝旧核查重试；显示reviewCurrent=false/REVIEW_STALE，原reviewHistory仍留存。新普通冲突也使简化核查失效。普通出餐恢复不能自解已进入的协商/资金事实门禁，撤销协商后如何合法重开未由本轮另定产品规则，保持人工处理。

所有返回均明确refundBusinessApproved=false、refundInitiated=false、trustedExternalRefundConfirmed=false、formalTerminationAvailable=false。协议成立、事实核查、退款业务授权、渠道提交、可信成功、正式履约终止是不同事实。本轮只完成前两类及待处理路由，未批准或执行后三类；没有Settlement/FINALIZED调整、补偿、余额、骑手收入或新支付主体/渠道选择。

管理员共享Case详情可查陈述与时间/版本，参与者不看到内部案件标识。OpenAPI记录各请求约束；没有真实微信/SMS通知、完整客户端、Root/L1/L2认证或自动关店。006迁移只在本轮独立测试、恢复副本和空库验证，主库未升级。
