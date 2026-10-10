# CODEX_TASK — 第 2 轮：商家确认取餐、骑手交接争议与个人商家黑名单（2026-10-10）

> **用户明确批准继续实现，立即开始编码。** 本轮基于上一轮 A/B/C 已完成的产物工作，绝不再重复上一轮完整重构或静态审计。先完成独立的黑名单，再实施商家主导取餐的完整安全闭环。用户仍在另一个 ChatGPT 对话继续产品设计，本任务不得自主实施其余未明确授权的资金或处罚政策。
>
> **强制安全前提**：商家单方一键推进 `PICKED_UP` 必须与“骑手立即否认/举报、暂停争议行为、审计和合法事实纠正”组成**可完整测试的闭环**。不能只交付可单方标记骑手已接货的 B 阶段却没做反向申诉。如果额度不足，保留已完工的黑名单及非激活代码，不上线存在该漏洞的新确认路径。

## 0. 首先核实最近提交与工作区

- 遵循 `AGENTS.md`，先 `git status`、`git log`、`git diff` 和远端状态；安全同步，不要覆盖未提交改动，不可 force-push/reset。
- 上一轮 A/B/C 代码：`f844f19c`、`4a449757`、`0abb8197`；上轮报告已另存 `CODEX_REPORT_2026-10-10_FRAGILE_ABC.md`。本次要读当前 `CODEX_REPORT.md` 和 `MERCHANT_PICKUP_AND_RIDER_BLOCKLIST_DECISIONS.md`，并先查 `PRODUCT_DECISIONS.md` **2026-10-10 新的交接方向取代之前“普通骑手确认取餐”方向**。
- 现有：`apps/api/src/delivery/service.ts:pickUpTask` 为 rider 确认并转 `PICKED_UP`，`verification/service.ts` 是商家发码、骑手验码，`catalog/risk-correction.ts:reportCatalogRisk` 只支持 CLAIMED 未取餐，`OrderStatus.EXCEPTION` 目前是终态不能恢复；`PickupEvidenceLevel.REQUIRED` 需额外 RIDER_PICKUP_PHOTO（目前 Mock 媒体引用而非真实相机）。
- 因本轮调整正常取餐权限，**现有 /delivery-tasks/:taskId/pick-up 不能继续成为绕过商家确认或强制取证的第二个合法取餐主入口**；若兼容旧客户端必须清楚 deprecate/拒绝/安全转换，不得静默允许原 RIDER 任意改状态。

## A. 骑手个人商家黑名单（优先，独立可交付）

**功能：**

1. 每个骑手自主按 `merchantId` 屏蔽/取消屏蔽商家，持久保存与本人绑定，唯一索引/idempotent；提供 `GET /rider/blocked-merchants`、`PUT /rider/blocked-merchants/:merchantId`、`DELETE /rider/blocked-merchants/:merchantId` 等一致风格 API。修改均校验 Rider 身份；不得允许其他 Rider 或 Merchant/Customer 操作。可记录必要的新增/撤回审计。
2. `GET /delivery-tasks/available` **按当前鉴权骑手**过滤该 Rider 黑名单商家的开放订单。当前这个路由可能未把 Actor 传给 listAvailableTasks：必须一并修复。分页应先过滤再 take/skip，避免某页为空而下一页有合法订单；合理索引避免每行 N+1。
3. `POST /delivery-tasks/:id/claim` 服务端再次检查黑名单，避免骑手绕过 UI 通过 taskId 直接抢单；使用现有 Order→Task 锁/有效配置，避免 blacklist 同时修改与 claim 的竞态导致违反最终系统规则。并发下应有明确合理的串行化语义。
4. 屏蔽不改商家的平台级曝光/评分/经营权限，不代替举报，不自动撤销已 claim 的该店订单、补贴、订单收入或其他 Rider 能见内容。解除后开放未过期且符合其他条件的订单。
5. 测试两个骑手互不影响、跨身份失败、屏蔽后看不见也 claim 不了、解除后可见、商家改名但 ID 不变、已有任务不取消、分页/并发/幂等行为。完成后独立提交。

## B. 新取餐协议 + 即时异议（**原子交付、缺一不可**）

### B1. 商家一键确认代替骑手普通取餐确认

- 针对有效 active assignment 的订单，商家在**真实交货后**通过 `POST /merchant/orders/:orderId/confirm-rider-pickup`（具体路径可遵循仓库风格）确认；服务端必须鉴权仅该订单商家且合法承接与取餐状态，取得 Order→DeliveryTask 锁后将订单与 Task 正常从 CLAIMED→PICKED_UP，并记 merchant 操作、时间、关联 rider/assignment、证据/验证方式等完整 `OrderEvent`，不自动创收或判定责任。
- 普通低风险/没有额外配置验证的订单，商家点击即可成功，Rider 不需再点。仍保留“商家备餐已完成”与“商家声称交付”不同的操作日志，不要求普通订单双向确认。
- 老 `pickUpTask` RIDER API 在新模式下不可独立推进订单。旧客户端须收到明确迁移提示/错误，而不是成功绕过 merchant。
- 双击/重试幂等；不同商家/未领取/过期/已报告风险暂停/已经 DELIVERED/已取消、不同 assignment、多名商家并发点击等须安全拒绝，不出现两次 PICKED_UP 或两个真实接单骑手。
- 商家单次确认只是**正常业务流程的状态推进**，不是可单凭按钮就自动判断实物已交接和骑手承担损失的证据。

### B2. 数字交接短码、扫码可扩展验证

- 普通低风险订单默认无强制验证；需要加强交接的订单，使用**六位或相似用户可读的数字短码**（可通过电话告知），或未来 QR 扫码。当前后端先交付数字短码和安全校验，QR 可以复用 token/purpose 的设计并预留协议，不需要实现微信扫一扫 UI。
- **旧信任方向要改变**：当前 `VerificationPurpose.PICKUP` 由商家签发、骑手核验；现在最后推进状态的是商家，不能“商家自己签发再自己验码”。应由系统为当前有效骑手/承接签发仅骑手可见的短码，商家输入以校验，记录双参与者与当前 assignment；限制有效时间、错误尝试/防穷举、一次使用/重新领取失效，避免商家可从自己的权限读到明文或重放历史码。
- 若要做扫码，二维码和数字短码可共享服务端验证语义；**不得假设电话传码等同实物当面交接证明**。外部扫码客户端仍待单独实现。
- 原有 `PickupVerificationMode.PICKUP_CODE`、PHOTO 的快照需保留且转换为商家确认前置条件；同时对风险升级商家/特殊单支持可配置验证要求，不凭 Codex 自定历史风险阈值。特别：订单 `PickupEvidenceLevel.REQUIRED` **必须**由当前骑手提前上传、绑定本次 CLAIMED 阶段的 RIDER_PICKUP_PHOTO 并达到上一轮后端验收标准，merchant 一键、数字码/扫码都不能代替照片；原 PHOTO + PICKUP_CODE 若被配置为互斥策略须保持既有可兼容语义，额外 REQUIRED 照片始终独立。
- 普通商家权限不可读全平台短码或他人订单码，不泄露码 hash/salt，旧商家签发的未使用码应在迁移/逻辑中避免被当作本轮骑手签发码接受。
- 无法取证时仍走原有有审计上报、安全阻断流程；不额外实现未经确认的无条件放行。

### B3. 骑手“未实际取餐”入口和交接事实纠正（**B1 同步上线**）

- 商家已确认进入 PICKED_UP 后，当前 assignment 的 Rider 仍可通过明确的 `POST /delivery-tasks/:taskId/dispute-pickup`（或一致命名）上报“未实际取餐”，附 reason、合理证据、受影响的商家交接记录 id / assignment id；需要幂等、跨 Rider/旧 assignment 拒绝、记录事件时间线与独立争议案件。骑手可从 `mine`/任务详情看到可用入口及争议状态。
- 争议后必须保护配送及财务安全：不能继续普通 deliver/结算、不能直接向其他人重复开放/推断 Rider 已领商品，更不能根据商家单方点击自动对 Rider 罚款/赔付。**不要为可恢复争议误用不可恢复的终态 `OrderStatus.EXCEPTION`**；建议引入独立 claim/pickup custody dispute 标志或不破坏历史的案例状态。必须保持现有 severe/dispute 锁顺序和已有结算路径。
- 骑手单方否认**不是**自动“确认实物未交”/解除责任；保留商家原始确认事件、骑手陈述、其他证据/短码记录、事实冲突，交二级客服（旧运行时暂用 OPERATOR）按当前已实现权限核实；处罚政策未确定不得在争议入口自动处罚或扣款。
- 明确**双方事实一致：商家确实误点、商品还在店里**的场景，提供有审计、可验证双方确认或经授权管理员修正的受控恢复路径，记录校正事件但**不删除原 PICKED_UP 或原 assignment 历史**，恢复合法的待交接/待正常配送状态。任何另一次重新商家确认仍必须重新满足本次有效证据、验证码和幂等约束。
- 双方冲突时维持不可自动放行的争议状态，允许授权管理员审理并标记核实结论；**不要凭某方单方面选择“纠正”就删历史**。如管理员确认确实已交货，保留 rider 责任与安全续派的合法决策路径；仅有证据不足时可以运营结案但不得虚构赔偿债务，复杂费用/重做仍按既有规则或待定。
- **和原漏报无责拒取相容**：商家单方已标 PICKED_UP 后，真实未接手商品的骑手仍能提交“核心易损漏报/虚假取餐”报告或交接异议，不能因状态字段直接封死；但不是机械放宽 `reportCatalogRisk` 检查让真拿货的人无条件释放。先核验实物交接事实，再执行经审计的漏报无责解除、商家更正、原 `firstPublishedAt`/`claimDeadline` 不重置。若无法在本轮完成该完整支路，请保证 Rider 仍可提交异议、案件可人工处理且不会立刻归责/计普通取消次数，明确记录未完成自动恢复部分。
- 任何 `OrderStatus.PICKED_UP`→`CLAIMED` 的**更正性质**转移不能在普通 state machine 暴露为无限自由回退；应通过受约束的专用审计动作、版本校验与核实权限。拒绝已 DELIVERED / 实物已被认定完成配送后的无审计回退。

## C. 验证与安全验收

- **分阶段提交**：A 独立绿提交；B1/B2/B3 虽可多个开发提交，但不允许在推送的默认运行时激活商家确认而没有 B3 的纠错入口。需要切换开关时确保 B 完整绿后再启用默认商家确认。
- 至少针对：商家主动推进正常状态、Rider 不再需要二次点击、旧 rider POST 被禁、跨商家伪造、任务无人接单/被举报暂停/过期、并发确认恰好一次、原照片 REQUIRED 阻止商家绕过、原 PICKUP_CODE 验证方向调整、动态短码错误/过期/重用/跨 assignment/穷举、Rider 否认有权上报及重复幂等、争议中禁止 deliver 和付款、商家误点纠正、与 CatalogRiskReport 相容、原订单 40 分钟不刷新、blacklist 只影响当前 Rider 且 claim 服务器端校验的单元/PG 集成测试。
- `pnpm db:generate`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm build`，最新库/旧库升级/全新数据库 migrations 与 drift/seed idempotency，保留前轮 37+101 tests 和资金/severe 竞态回归。测试只报告真实执行结果，缺 Docker/Postgres/CI 不冒充通过。
- 资金边界：不自动产生未完成订单 rider 已赚取收入，不顺手实现商家罚款/黑名单惩戒，不影响 reservedMinor、平台垫付账、争议 HELD 释放、退款策略、救单红包补贴和已认领单的保证收益快照。
- 详细开发输出更新 `CODEX_REPORT.md`（上一轮已归档为 `CODEX_REPORT_2026-10-10_FRAGILE_ABC.md`）：写逐阶段 commit SHA、精确路由/schema、状态机/兼容说明、已验证测试、迁移/并发/资金结果、尚未支持的二维码 UI/真实相机和决策缺口；最后独立提交/推送报告并停止。本轮不要无限审核循环。

## 明确排除

- 不实现新三层/多层管理员模型、Root 微信绑定、用户登录；暂用旧权限确保安全，仅按已批准功能添加最小必要路由权限。
- 不设计商家罚款/封禁/惩戒金额、骑手到店补偿、自动 AI 判责、强制面对面扫码、真实媒体可信拍照、微信支付、赔付四本账全面重构。
- 不允许旧 `EXCEPTION` 终态作为暂时暂停可恢复订单，不重写 `OrderPricing` / `RiderSettlement` / `CompensationObligation` 责任归因。
- 不把 Rider 个人商家黑名单用于平台降权或商家全局风险分数。
