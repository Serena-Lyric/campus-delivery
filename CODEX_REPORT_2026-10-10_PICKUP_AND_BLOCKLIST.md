# CODEX_REPORT — 第 2 轮：个人商家黑名单、商家取餐确认与交接争议

日期：2026-10-10（Asia/Singapore）。执行当前 `CODEX_TASK.md` 的 A、B1/B2/B3 和 C 验证要求；没有重新实施上一轮商品分类/取证/更正 A/B/C。上一轮报告仍保留在 `CODEX_REPORT_2026-10-10_FRAGILE_ABC.md`。

## 1. 提交与交付

- 同步前本地 main：`4f09f53`，工作区干净。fetch 后 fast-forward 到最新 main，没有 reset、覆盖用户工作或 force push。
- 本轮起点：`d1203ff9663519e3ed75b5a88a978ac8d64775b2`。
- 阶段 A：`9cdb1c8537b4a4ae5fd603c96a93564a9e98961f` — 骑手个人黑名单、按本人过滤订单池、接单串行化。
- 阶段 B / 实现结束：`73030e095abfea4a2a51ddd1e38fe054141330e5` — 商家确认、骑手短码、交接争议、受控事实纠正及漏报支路原子恢复。
- A 独立提交后才推进 B。B1/B2/B3 同一实现提交、完整通过后一次推送，没有激活缺少反向申诉的商家确认路径。
- A/B 已正常 push 到 `origin/main`；`git ls-remote --heads origin main` 已核验远端为 `73030e095abfea4a2a51ddd1e38fe054141330e5`。
- 报告生成前 `git status --short --branch` 为 `## main...origin/main`，没有未提交文件。本报告最后独立提交/推送；报告自身 SHA 可用 `git log -1 -- CODEX_REPORT.md` 查询，最终同步与工作区以报告推送后的 CLI 核验为准。
- 对 B 提交查询 GitHub：Actions runs = 0，check runs = 0，combined statuses = 0（state 为 pending）；仓库 workflows = 0。以下均为本地实际执行结果，**没有独立 CI 通过证据**。

## 2. 产品规则与实现选择

以 PRODUCT_DECISIONS.md 的 2026-10-10 交接方向为准，明确替换此前普通骑手确认取餐方向。新商家确认是正常业务推进声明，不是独立的物理交货或责任证明；照片与电话短码也不自动判责。

保留原创建时冻结的 PHOTO / PICKUP_CODE 和核心易损 REQUIRED 义务，未修改金额阈值、分类规则、价格/保证收益快照。40 分钟仅限制新的 claim：截止前有效承接可以在截止后取餐和配送；纠正后释放承接再回池时仍用原截止时间。

事实纠正采用**获分派案件的管理员核实**路径。商家承认误点只增加双方事实材料，不自动解除争议。未交货、已交货和证据不足分开记录；没有自动责任、罚款、补偿、债务或账号限制政策。

## 3. 阶段 A 要求到运行时清单

| 要求 | 实际执行点 | 验证 |
| --- | --- | --- |
| A1 本人持久屏蔽/解除、唯一与幂等 | RiderBlockedMerchant 复合主键 riderId/merchantId；blocklist.ts requireRider、upsert/deleteMany；鉴权 Actor 提供 riderId | blocklist 单测；重复 PUT/DELETE、跨身份、两个骑手隔离 |
| A2 本人订单池、先过滤后分页 | listAvailableTasks 接收 Actor；SQL relation predicate merchant.blockedBy.none(riderId)，然后 take/skip | 两页各有合法单、另一个同名商家不被屏蔽、商家更名后仍按 ID 屏蔽 |
| A3 服务器再次检查及并发语义 | claimTask 在现有 Rider → Order → Task 锁下读黑名单；屏蔽修改共享 Rider 行锁 | block vs claim 并发；屏蔽成功后后续直接 taskId claim 被拒绝 |
| A4 仅未来偏好、不更改其他事实 | 屏蔽只写个人关系表，不触碰持单、商家风险或资金 | 既有 CLAIMED/assignment 保留，其他骑手仍可见，无取消/收入记录 |
| A5 独立验证/提交 | A typecheck、38 单测、build、21 个迁移及 drift；原 101 PG 回归通过，新增 3 PG 测试修正清理顺序后全部通过 | 独立提交 9cdb1c8；最终完整 PG 124 项通过 |

串行化语义：屏蔽先取得 Rider 锁则之后 claim 拒绝；claim 先取得锁则该合法承接成立，随后屏蔽仅约束未来，不撤销它。列表读取反映请求时数据库可见的偏好。

API：`GET /rider/blocked-merchants`、`PUT /rider/blocked-merchants/:merchantId`、`DELETE /rider/blocked-merchants/:merchantId`。仅 RIDER，本人身份由鉴权确定，无代改 riderId 参数。保存当前偏好及 createdAt；没有额外构建屏蔽撤回历史流水或平台商家惩戒。

## 4. 阶段 B 完整安全闭环

| 要求 | 实际执行点 | 验证 |
| --- | --- | --- |
| B1 本单商家推进有效承接 | confirmRiderPickup，Order → Task 锁，当前 ACTIVE assignmentId、expectedRevision、CLAIMED 双状态校验 | 普通单无需骑手二次点击；跨商家/跨角色、无人承接、暂停、陈旧承接/版本和终态失败 |
| B1 一次推进和历史审计 | requestKey 幂等；PickupHandoff 与 OrderEvent 关联，保存操作者、承接、版本、方式、证据/验证码 ID；orderId/revision 唯一 | 并发重试同一 handoff/event；换 key 不能再次取餐；变更重试字段拒绝 |
| B1 原窗口语义 | 商家确认不使用 claimDeadline 拒绝已经有效承接的订单 | 模拟原截止后确认成功，firstPublishedAt/claimDeadline 相同 |
| B1 旧入口停用 | pickUpTask 始终返回 MERCHANT_PICKUP_CONFIRMATION_REQUIRED；旧发码与骑手验码均拒绝并在 OpenAPI deprecate | 旧 rider POST 409、旧 merchant 发码 409、旧 rider 验码 409，非 rider 403 |
| B2 改变短码信任方向 | issueRiderPickupCode 只向当前骑手返回六位码；protocolVersion=1，绑定订单/assignment/revision，商家确认时检查；scrypt 盐/哈希仅内部存储 | 他人/商家/Customer/Operator 发码失败；旧、过期、重发、跨单/承接码拒绝；正确码记录 issuer Rider / verifier Merchant |
| B2 有效期、次数及一次使用 | TTL 为现有版本化配置与 10 分钟工程上限的较小值；承接 10 分钟窗口最多 5 次签发、5 次错误；重发使旧码失效；成功消费和推进同事务 | 并发猜码累计真实 failedAttempts；重新签发不清零；第六次签发、锁定后正确码拒绝；更正后旧码拒绝 |
| B2 电话可用、明文隔离 | merchant 只传六位 code 也可查到本次唯一有效码；codeId 可选；普通详情/时间线不返回码或 hash/salt | 不传 UUID 的确认与重试成功；商家响应敏感字段负向测试 |
| B2 原照片与额外 REQUIRED 并行 | PHOTO 或 REQUIRED 查当前骑手 RIDER_PICKUP_PHOTO、同单、CLAIMED、当前承接时间、assignmentId 与交接 revision；图片 MIME 和 Mock storage 引用；CODE 再并行检查 | 原 PHOTO、CODE+核心照片；仅码/仅照片失败；跨单、错人/角色/阶段/类型、非图片、无引用、旧承接照片回归 |
| B3 即时异议与共享人工案件 | disputePickup 绑定 handoff/assignment/原商家事件；同 handoff 唯一；保存原因、证据、可选 catalogRiskClaim，创建 PICKUP_CUSTODY_DISPUTE case | 他人/伪造承接拒绝；并发一次案件；相同陈述幂等、改变陈述冲突；mine 中当前骑手有可用入口 |
| B3 未决行为暂停 | assertNoPickupDispute 在 Order → Task 锁内用于 deliver、确认、发码、异常状态处分与退款/赔付；包括通过本单其他 case 退款 | OPEN/INCONCLUSIVE 无法送达、重新确认、退款/通用结案；其他 case 不能绕过；deny vs deliver 只能一条成功 |
| B3 商家一致事实材料 | acknowledgePickupMistake 校验本单商家/争议版本，单独保留误点及商品在店声明 | 商家承认后仍保持 PICKED_UP/争议；陈旧确认失败；日志保留 |
| B3 专用核实及更正 | resolvePickupDispute 先锁 case，再 Order → Task；当前处理人、合法案件状态、争议及 case 双版本；requestKey 幂等 | 未领取、陈旧任一版本、普通已升级 handler 拒绝；SUPER_ADMIN 经 takeover 后可核实；冲突并发结论一次生效 |
| B3 未交货/已交货/证据不足 | NOT_HANDED_OVER 专用审计回到 CLAIMED，revision+1，保留原 handoff/assignment/event；HANDED_OVER 保留保管并恢复正常配送；INCONCLUSIVE 继续 WAITING_FOR_PARTICIPANT 和阻断 | 更正后新证据/新码才能再确认；原事件保留；已交货后正常 deliver；终态不可自由回退，无补偿债务 |
| B3 漏报支路 | 未交货核实同时存在 catalogRiskClaim 时，在同事务复用 recordCatalogRiskReport：结束原承接、释放持单、RISK_REVIEW；实际操作人为管理员，原举报骑手保留在 metadata | 商家确认后仍可提出漏报异议；核实前不能机械拒取；核实后自动风险暂停，原订单/窗口保留、不计普通取消，不能被再次确认抢先覆盖 |
| C 回归及角色隔离 | 原 4 个集成文件通过新的 merchantPickup helper 继续测试原风险/资金断言；角色 DTO 显式 selects，Customer 无 assignment/handoff 内部信息、历史骑手不看到另一有效承接的 handoff | 原 37 单测+101 集成均保留；新增 A/B 单测与 PG；完整序列共 40+124，通过 |

### API 与请求边界

- `POST /delivery-tasks/:taskId/pickup-code`：当前 RIDER；assignmentId；201 仅此响应有明文 code。
- `POST /merchant/orders/:orderId/confirm-rider-pickup`：本单 MERCHANT；assignmentId、expectedRevision、requestKey；可选 photoEvidenceId、code、codeId。
- `POST /delivery-tasks/:taskId/dispute-pickup`：RIDER；assignmentId、handoffId、reason；可选 evidenceIds、catalogRiskClaim（orderItemId、CAKE/SUNDAE）。
- `POST /merchant/orders/:orderId/acknowledge-pickup-mistake`：本单 MERCHANT；disputeId、expectedVersion、note。
- `POST /admin/pickup-disputes/:disputeId/resolve`：当前案件处理人；expectedVersion、expectedCaseVersion、requestKey、outcome、note。
- 旧 `/delivery-tasks/:taskId/pick-up`、`/delivery-tasks/:taskId/verify-pickup-code`、`/orders/:orderId/pickup-code` 保留路径但明确拒绝，客户端必须迁移，不能当作成功兼容转换。

merchant 详情可读 activeAssignmentId、pickupProtocol.revision 和最近 handoff/争议；rider mine 可读本人当前承接的 handoff、争议状态和 canDisputePickup。普通用户只读商家确认模式，没有额外暴露验证码、盐、hash 或承接标识。原时间线继续保留备餐、商家交付声明、骑手否认、商家更正说明与管理员核实事件。

短码错误返回在事务**提交失败计数后**才抛出 HTTP 错误；不会因回滚导致限次形同虚设。重发限次和错误计数按当前承接跨 code 记录聚合；10 分钟/5 次是安全工程默认，不是新惩罚产品政策。

## 5. 状态、并发和资金边界

- 普通 state machine 仍不允许 PICKED_UP → CLAIMED；只有专用人工核实动作可作更正，必须保持当前承接、案件处理人/状态和双版本前置条件。DELIVERED 等终态不能通过此更正恢复。
- 交接争议用独立 PickupCustodyDispute，OPEN/INCONCLUSIVE 真正阻断运行时；没有把可恢复暂停写为不可恢复 OrderStatus.EXCEPTION。
- 旧 severe 报告和 deliver 的 Order → DeliveryTask 顺序保留。通用异常新增同顺序锁；refund 在既有 case 锁后加 Order → Task 的争议检查并重读订单事实，再进入原资金逻辑；原 RiderSettlement 排序锁、reservedMinor、HELD 释放不改。
- 本轮确认、否认、商家承认、管理员核实不创建 RiderSettlement、CompensationObligation 或付款事实，不扣既得收入，不自动罚款/封禁。核实已交货后的正常 deliver 才走既有正常收入路径。
- 漏报支路复用原风险更正及再发布，保留 sold items、OrderPricing、保证收益、rescue/tip/subsidy 和其他订单已得余额；新测试直接比较本单 pricing 和另一单含 reservedMinor 的 settlement 前后相等。
- 无法取得强制照片仍只提供有审计的上报，**不能放行**。物理交接照片内容与电话参与码均不自动认定责任。
- 没有重写旧退款/严重异常赔付的 earning、四类独立账务、商家初始配送款或历史财务迁移。既有未完成订单退款路径的收入/赔付语义仍属于已文档化待决范围；本轮争议阻断不能被理解为旧资金模型已经整体满足全部新分责产品规则。

## 6. 迁移、Seed 与验证

新增迁移，仅追加，没有编辑已应用迁移：

1. `20261010000400_rider_merchant_blocklist`：个人关系表、复合主键、关系索引。
2. `20261010000500_merchant_pickup_custody`：PickupHandoff、PickupCustodyDispute、独立争议 enum/type、Order.pickupHandoffRevision；VerificationCode.assignmentId/protocolVersion/handoffRevision/failedAttempts，唯一及外键约束；失效旧未用 merchant PICKUP 码，非负次数/版本约束。

| 实际执行 | 结果 |
| --- | --- |
| Docker CLI `docker desktop status` / `docker info` / compose ps | running，engine 29.8.0，PostgreSQL healthy；没有重启或破坏性恢复 |
| `pnpm db:generate` | 成功；最终完整验证再次生成 |
| `pnpm typecheck` | A、B 及最后一轮通过 |
| `pnpm test` | A 38；最终 40，15 个文件全部通过 |
| `pnpm test:integration` | 最终 124，5 个文件全部通过（原 101 + 本轮 23） |
| `vitest run tests/integration/pickup-protocol.test.ts` | 最终全量中 23 项通过；A 3 + B 20 |
| `pnpm build` | A 与最终 B 通过 |
| `pnpm db:migrate` / `prisma migrate status` | 当前库 22 个迁移完成，无待执行迁移 |
| `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` | 当前库、空库、旧库升级后均 No difference detected，exit 0 |
| 独立空库 full migrate | 22 个迁移从零成功 |
| 独立旧库 20 → 22 | 使用起点 schema/20 个迁移及旧 Client 建库，插入 FINALIZED settlement、历史 inactive BusinessConfig、sold item 和旧未用 PICKUP code 后升级成功 |
| 旧库只读快照比较 | Order、OrderItem、OrderPricing、Settlement、RiderSettlement、DeliveryAssignment、BusinessConfig、Product、OrderEvent 共 9 类原始事实相等；只排除新 Order revision 字段；旧码失效、protocolVersion=0、assignmentId=null |
| 空库连续两次 seedDatabase（pnpm db:seed 同一实现） | 语义摘要相等：users 6、merchants 1、products 2、orders 8、assignments 5、configs 1、guaranteed payout 合计1670 |
| 当前库连续两次 seedDatabase | 语义摘要相等：users 10、merchants 2、products 174、orders 10、assignments 5、configs 2、guaranteed payout 合计2260；保留已有测试商品/商家，不把统计值当产品规则 |
| OpenAPI / 权限 / 完整 DTO | 新路径存在、旧入口 deprecated、跨角色/归属及字段缺失负向断言通过 |
| `git diff --check` | 通过 |

Seed 为演示场景，不制造历史商家交接声明；新取餐协议/照片/短码/争议由真实 API 与 PostgreSQL 事务集成测试验证。旧已 PICKED_UP 历史保留，不追溯猜造商家确认；旧照片缺少本次承接/交接 revision 时需重新上传，旧商家码或旧验证 Evidence 不能替代新骑手码。

开发中曾遇到测试清理顺序、错误响应结构/幂等重试断言及旧库 fixture 使用非法 config version=0 的准备错误，均已修正并实跑。最终无遗留失败或被阻塞的必要检查。生成专用旧 Client 时工具自动添加的根依赖已撤销，并用 frozen/offline install 恢复原依赖声明；最终没有新增依赖。

## 7. 能力状态、保留与未实现

| 分类 | 当前事实 |
| --- | --- |
| **enforced behavior** | 个人黑名单与 claim 串行化；商家唯一正常确认；承接/revision/幂等保护；仅骑手可见数字码、持久限次、旧码隔离；独立照片并行；即时否认及案件；未决交接阻断送达/资金处分；有权限人工更正、继续配送或等待；漏报免取消支路原子衔接 |
| **data/telemetry available** | 原商家声明、承接/证据/短码参与者、失败尝试、双方陈述、漏报声明、处理人及核实结论、原始/纠正事件；不等于自动责任或处罚事实 |
| **policy hook / placeholder** | 已有 purpose/protocolVersion/assignment/revision 能承载未来扫码验证语义；没有生成或验证 QR token，也没有扫码实现。原 Jev 仍为低风险建议边界 |
| **not implemented** | QR/微信客户端 UI、真实相机和对象存储真实性验证、外部推送/短信、替代照片放行、争议期限/复杂费用/重做政策、商家处罚、Root/管理员等级/认证迁移、真实支付提现与完整分责四本账 |

照片仍为 `MOCK_REFERENCE_ONLY`、authenticityVerified=false；短码证明验证参与而非实物当面交接。优惠分摊、治理风险阈值、处罚、赔付费用与管理员授权新体系没有擅自补定。核实有相互冲突的 severe 保管事实时安全拒绝未交货回退，不擦去严重事件或替管理员猜责任。

临时验证材料已移出 Git 工作区，保留在 `C:/Users/Serena Lyric/.codex/visualizations/2026/10/10/01a12331-e546-7fd3-900d-3977b985a574/round2-validation`，含旧库 before.json 及旧 schema/Client。验证数据库 `campus_round2_old`（首次 fixture 尝试）、`campus_round2_legacy_final`、`campus_round2_empty` 保留，不影响业务库与 Git 提交。

**自动审批限制**：DROP 验证数据库和删除临时目录的组合清理命令被自动审批拒绝，仅返回 “blocked by policy”，未提供具体理由。没有绕过该删除限制；改为保留验证数据库及材料，并可逆地移动材料以保持 Git 工作区干净。功能、验证、提交与推送不受该清理限制影响。

本轮完成后停止，不进入未授权新阶段。
