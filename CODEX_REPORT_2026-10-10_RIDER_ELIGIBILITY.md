# CODEX_REPORT — 第 3 轮：学生骑手资格、学期续签和毕业到期

日期：2026-10-10（Asia/Singapore）。仅执行本轮 CODEX_TASK.md 的 A、B 和验收/报告，没有开展其他任务。

## 1. 结论、额度与提交

阶段 A、B 均已完整实现并通过各自验证、独立提交和普通推送。**全局资格拦截尚未启用**：没有真实校历和逐人核定资料，不能把演示日期或未知历史资料当成学生审核事实。当前只能在管理员明确启用门槛后，宣称新 claim 受毕业/学期资格约束。

- 同步前本地 main：`f935404`；工作区干净。安全 fetch、fast-forward 到本轮任务起点 `8bdefb4a3547672511e27283052ca69fb434afa3`。
- 初始评估：A 为中等规模的模型/API/审核/提醒闭环；B 是较小但必须完整验证的 claim、迁移兼容及并发改动。主要风险为旧骑手事实缺失、校历未知、旧管理员身份语义、锁等待跨过资格到期，以及已有订单/收入被错误改写。
- 额度工具快照：开始五小时剩余约 40%、周剩余约 91%；A 最终通过并推送后五小时剩余约 26%；B 推送后约 20%、周约 88%。这些是账户共享额度快照，不是可精确预测的工作时长。本轮没有使用额度重置或信用额度。
- A 初始实现：`5c7dc462043b6670866e3159addda19f2986015c`。
- A 首次推送遇到远端并行文档更新，普通推送被拒绝。检查后合并至 `9558d11`，保留远端 `e0ed306` 及其人工学生核验细则，没有 reset/rebase/force push。新增细则与本轮方向一致；补齐必填核验方式后重跑全部测试。
- A 最终完成及推送：`e8d81eb66a244158927e4e2c83e7ba9170659c0a`，含核验方式必填及审计验证。
- B / 实现结束：`c0a9d5abb78cbfa718fd0b477446b82ed209285a`。
- `git ls-remote --heads origin main` 已核验 B 推送后的远端 SHA 为 `c0a9d5abb78cbfa718fd0b477446b82ed209285a`，报告前工作区干净。报告最后独立提交并推送；报告自身结束 SHA 通过 `git log -1 -- CODEX_REPORT.md` 查询，最终同步以该推送后的核验为准。
- 上轮报告已归档在 `CODEX_REPORT_2026-10-10_PICKUP_AND_BLOCKLIST.md`，没有重新实施黑名单、交接争议、短码或分类/定价任务。

## 2. 产品规则与数据边界

按 PRODUCT_DECISIONS.md 的学生资格、准入分工及新增人工核验规则实施；ADMIN_ROLE_DECISIONS.md 的 Root 保护、正式 RBAC 与统一登录边界未修改。新增 API 暂由旧 SUPER_ADMIN 承担一级运营审核职责，**没有将其升级为 Root，也没有实现正式 L1/L2/Root 迁移**。

新增五个模型：

- AcademicTerm：单校园后端的显式学期、一个续签窗口、预提醒时点、时区、配置者/理由/时间。时间输入要求显式偏移，时区由 Intl 校验；日期和窗口顺序在服务和数据库校验。学期与续签窗口分别防重叠，边界采用 `[开始, 结束)`。
- RiderEligibility：仅保存管理员核定的预计毕业生效时间、毕业提醒时间及版本。没有记录代表未知，迁移不插入“已毕业”或“学生已审核”结论。
- RiderTermQualification：每骑手/学期唯一的当前人工审核结论及有效区间，不同学期独立保存，批准区间不能超出本学期。
- RiderRenewalRequest：本人 CONTINUE / DECLINE / GRADUATE_EXCEPTION 意愿；本人/学期和本人/requestKey 唯一。它不是资质来源，也不批准毕业例外。
- RiderEligibilityReview：运行时仅追加审核日志，保存操作人、动作、时间、适用学期、请求、理由、核验方式、前后事实和版本。审核纠正更新当前事实，但保留过去的审计记录；没有公开更新/删除历史审核的 API。未声称数据库特权用户无法直接修改日志。

不新增身份证、学号原件或学生证/学籍图片存储字段。人工核验方式由管理员如实填写，不调用学校系统，也不把截图或骑手自报日期自动变成可信事实。核验方式保存在审核日志的 request.verificationMethod 中。

## 3. 阶段 A：要求到运行时与验证

| 要求 | 运行时执行点 | 验证 |
| --- | --- | --- |
| A1 资格与账号/在线/冷却/容量独立 | 独立资格模型；reviewEligibility 不写 User、Rider.status、restriction、assignment 或资金 | AVAILABLE 仍可派生 NONE/REJECTED/GRADUATED；权限测试；B 的已有履约和收入测试 |
| A2 一个配置窗口、合法时间、未知不推断 | createAcademicTerm / validateTerm；事务 advisory lock；日期 CHECK 和两个范围排斥约束 | 并发重复配置、校历/窗口重叠、非法时区/日期、假期窗口、相邻学期 |
| A3 查询提醒与继续意愿 | getMyEligibility / submitRenewal；显式 reminderStartsAt / graduationReminderAt；窗口可申请提示 | 窗口开始前/开始时、毕业前提醒、CONTINUE/DECLINE、重复与并发申请 |
| A4 毕业到期事实 | qualificationState 在核定毕业时间优先派生 GRADUATED；批准不能跨已核定毕业时间，也不能给已毕业者作普通批准 | 毕业前 1ms 和精确生效时点；申请例外后仍 GRADUATED；账号和 AVAILABLE 保留。新 claim 的实际拦截在 B 且依赖启用开关 |
| A5 每学期审核与不可自审 | reviewEligibility：SUPER_ADMIN、Rider 行锁、expectedVersion、requestKey、每学期当前结论及追加日志 | 服务/路由权限；骑手/商家/用户/OPERATOR 无审批权；重试、变更重试、陈旧版本、并发审核、跨学期独立与有审计纠正 |
| A6 毕业例外仅保留请求 | GRADUATE_EXCEPTION 仅登记意愿；APPROVE 不能覆盖有效毕业事实 | 例外申请不改变 GRADUATED，不产生批准 |
| A7 真实状态、原因、待办 | readEligibility 返回 NONE/UNDER_REVIEW/VALID/NOT_YET_VALID/RENEWAL_REQUIRED/GRADUATED/REJECTED/CALENDAR_UNCONFIGURED 和窗口/原因/nextAction | 未知老数据、未来有效区间、过期/未续签/拒绝、自报日期无效、完整序列化负向隐私检查 |
| 最新人工核验细则 | ReviewInput 必填非空 verificationMethod，审核请求原样记入审计 | 缺方式/空白方式失败；日志保留方式；OpenAPI 路径存在 |

提醒仅是查询时返回的提示，不存在微信订阅消息、短信或后台推送。身份事实未知没有专门 UNKNOWN 枚举：由不存在的资格记录、null 毕业日期及 NONE/CALENDAR_UNCONFIGURED 明确表达，不能解释为已审在读。

骑手接口：`GET /riders/me/eligibility`、`POST /riders/me/renewal-requests`。本人身份来自鉴权，不接受代填 riderId。Fastify 会移除未知请求字段；测试证明自填 validUntil / expectedGraduationAt 被忽略且不创建资质事实。

临时一级审核接口：`GET/POST /admin/academic-terms`、`GET /admin/riders/:riderId/eligibility`、`POST /admin/riders/:riderId/eligibility/reviews`。审核动作是 APPROVE、REJECT 和 SET_GRADUATION；最后一项用于有审计地录入/纠正经核实日期。重复成功请求返回原审计结果；变更重试内容和陈旧版本失败。

骑手 DTO 仅显式返回本人资格、日期、待办和学期显示事实；完整响应负向验证无 actorId、createdById、riderId、userId、requestKey、审核历史或前后内部快照。管理员才可查看核验历史。新增模型没有被 spread 到既有客户/商家/骑手订单响应。

## 4. 阶段 B：门槛、并发与历史兼容

| 要求 | 运行时执行点 | 验证 |
| --- | --- | --- |
| B1 新 claim 实时校验 | claimTask → assertQualificationCanClaim → qualificationSnapshot；启用时仅 VALID 可进入原有接单路径 | AVAILABLE 的未知/待审核/未到有效期/过期/拒绝/毕业均拒绝；直接 taskId 无绕过；精确有效期开始允许接单 |
| B2 订单池一致 | listAvailableTasks 在 RepeatableRead 查询同一资格判定；启用且非 VALID 返回空数组 | 未知/拒绝/毕业不可见；批准后可见；原黑名单和分页回归仍通过。具体原因通过资格 GET 查询 |
| B3 到期和竞争 | Rider → 开关 shared advisory lock → Order → Task；锁等待后获取统一 now，再读资格、期限及执行 claim；审核也锁 Rider | 锁等待跨毕业时点后拒绝；审核/claim 竞争；首个开关版本竞争；两名已显式核验骑手竞争同一 task 只有一个有效 assignment |
| B4 旧用户安全过渡 | RIDER_ELIGIBILITY_POLICY 未配置时 enforced=false/version=0；不补毕业日期，不补审核；明确管理员版本化启用 | 默认未知仍可合法 claim；启用后未知被拒绝；Seed 不写资格、不关闭已启用开关 |
| B5 既有履约/收入 | 门槛只接入 available/claim，不接入取餐、送达或结算路径；审核只写资格表及审计 | 先合法接单再毕业，已 PICKED_UP 仍正常送达；旧已得 RiderSettlement 与持单 OrderPricing 逐字段不变；账号保留，无自动取消/删除 |

普通 claim 的业务错误是 `RIDER_QUALIFICATION_REQUIRED`（409），含状态、策略版本、统一判定时间、学期和下一步提示。资格 GET 同时明确 claimGateEnforced、enforcementConfigVersion、qualificationAllowsNewClaims 和未启用过渡提示；最后一项资格许可不替代在线、容量、冷却和订单期限等其他条件。

开关修改复用 `PUT /admin/business-configs/RIDER_ELIGIBILITY_POLICY`：只接受 `{ enforced: boolean }`，此 key 必填 expectedVersion，首次是 0；修改理由、操作者、前后配置和版本均审计。启用前必须有当前学期。事务 exclusive advisory lock 与 claim 的 shared lock 协作，包含第一次配置无行可锁的情况；旧版本重试失败且不新增配置/审计，这不是另一个 requestKey 幂等接口。其他业务配置原有不传 expectedVersion 的调用仍兼容。

审核与 claim 的串行语义：claim 先取得 Rider 锁则该时点合法承接成立，后续拒绝/到期不撤销它；审核先取得锁则之后 claim 使用新事实。开关和 claim 同样按取得锁的先后生效。查询列表是请求时的一致快照，真正接单始终服务端复核。

## 5. 实际生效、事实记录和未实现内容

- **enforced behavior**：角色守卫、校历/日期/窗口校验、防重叠、申请唯一/幂等、审核方法必填、版本/重试保护、逐学期批准区间、毕业不能普通续签批准、查询时状态及提醒计算均已作用于运行时。资格门槛代码已完整接入并有正负向/竞争测试，**只在管理员启用时拦截新单**。
- **data/telemetry available**：人工核验方法/结果/人员/时间/理由、继续或不继续意愿、毕业例外申请、版本和历史快照。意愿不授予资格；DECLINE 不自动撤销已审资格或取消既有订单。
- **policy hook / placeholder**：GRADUATE_EXCEPTION 只有请求记录，批准标准/批准路径尚不存在；不能当成已实现毕业继续配送。未配置开关的过渡状态也不是学生认证证明。
- **not implemented**：正式 Root/L1/L2 RBAC 迁移、正式登录、学校身份接口、真实材料上传/临时保留与删除、微信/短信推送、小程序 UI、毕业特批、教职工/校外类别、准入法规和确切资料保留期限。

有意保持最小范围：校历按当前单校园后端维护；已创建学期/窗口无公开修改删除接口，后续配置新学期，不静默追改已审核区间。没有另造宽限期；当前资格区间限制在配置学期内。每人每学期一个不可变意愿提交，变更意愿会返回冲突；意愿修订和校历纠错流程需后续另行设计。提醒展示最多 10 个未关闭的窗口，后台历史最多 100 条，未实现专门历史分页。未扩大到用户/商家准入或其他财务治理。

## 6. 迁移与验证结果

新增一个正式、纯增量迁移：`20261010000100_rider_eligibility`。没有修改已经应用的旧迁移，也没有回填老 Rider。B 没有 schema 改动或新增迁移；开关首次版本只能由明确管理员操作创建。

| 实际命令/验证 | 结果 |
| --- | --- |
| Docker Desktop CLI / docker info / compose ps | running，engine 29.8.0，PostgreSQL 容器 healthy；无需 restart，无破坏性恢复 |
| `pnpm db:generate` | A/B 均成功，Prisma 6.19.3 |
| `pnpm typecheck` | A/B 最终均 exit 0 |
| `pnpm test` | A 43/43；B 最终 44/44（16 文件） |
| `pnpm test:integration` | A 最终 132/132；B 最终 140/140（6 文件，约 180 秒） |
| `pnpm build` | A/B 最终均 exit 0 |
| 当前库 `pnpm db:migrate` / migrate status | 新迁移已应用；23 个迁移，up to date，无 pending |
| 升级前旧库备份恢复到隔离库后 migrate deploy | 成功；升级前后 41 张既有业务表全部行数及按行内容排序的 MD5 摘要相同，包含订单、资金、骑手、审计及既有交接数据；新增资格/审核记录数均 0 |
| 空库全部 migrate deploy | 全部 23 个迁移成功 |
| `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` | 当前库、旧库升级隔离库、空库均 No difference detected / exit 0 |
| 连续两次 Seed | 当前库、旧库升级隔离库、空库均实际成功；无资格回填。额外测试证明 Seed 不关闭明确启用的资格开关 |
| OpenAPI/权限/隐私 | 新路径存在；非 SUPER_ADMIN 审核和开关写入拒绝；完整骑手资格 DTO 负向检查通过 |
| 既有行为回归 | 原有 124 项 PG 测试全部保留并通过，涵盖黑名单、取消冷却、容量、商家取餐、交接争议、退款、资金及定价快照 |
| git diff --check | 通过 |

初次 A 集成测试发现 advisory lock 的 void 返回值不能用 Prisma queryRaw 反序列化，改用 executeRaw 后完整重跑；负向自报字段测试调整为符合 Fastify 移除额外字段的实际行为。B 初次针对性测试发现跨学期状态从 NONE 精化为 RENEWAL_REQUIRED，更新相应预期并增加真实 claim 验证后重跑；以上失败没有被当成通过。

两个隔离验证数据库 `campus_eligibility_upgrade_20261010`、`campus_eligibility_empty_20261010` 在验证后已删除，仅删除本轮创建的临时库。升级前备份仍位于 PostgreSQL 容器 `/tmp/campus_eligibility_before.dump`；验证临时脚本未进入 Git。没有删除应用数据库或 Docker volume。

对 B 提交 `c0a9d5a` 实际查询 GitHub：combined statuses=0、check runs=0、Actions runs=0；仓库 workflows=0。上述通过结果均为本地实际执行，**没有独立 CI 通过证据**。

## 7. 交付状态与启用所需参数

报告前实际查询当前库：active RIDER_ELIGIBILITY_POLICY 版本数=0，AcademicTerm=0，RiderEligibility=0，RiderTermQualification=0；测试记录已清理，Seed 未伪造审核。故当前 enforced=false / version=0；**全局未启用时，已登记的毕业/过期事实也不会自动拦截 claim**。这是任务明确允许、等待正式数据的过渡方案，不是无限期免审的产品承诺。

正式启用前，运营管理员需要：

1. 按真实校历配置学期开始/结束、时区、一个续签窗口、预提醒时点；不得直接复制测试 fixture 日期。没有隐含宽限期。
2. 逐人核验在读事实，记录核验方式和理由，并审核当期 validFrom/validUntil；如已核定预计毕业时间，录入生效时间及明确的提醒时间。未知资料保持未知，不能批量伪造通过。
3. 查验待核实名单与已持单风险，再以明确理由和 expectedVersion=0 写入 `{ enforced: true }`；后续开关变更需当前版本。此操作只影响后续新 claim。
4. 查看资格查询接口的状态/窗口/待办；没有真实消息推送，应另行安排实际运营提示。

A、B 与报告完成后停止。毕业例外、材料留存、校历纠错和正式分权等未决/未实现项留待用户另行授权，不自行继续。
