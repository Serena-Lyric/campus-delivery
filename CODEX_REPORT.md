# CODEX_REPORT — 第十轮 B：出餐、独立异常门禁与变更告知

日期：2026-10-13（Asia/Singapore）。依据用户明确授权、续接要求、最新 PRODUCT_DECISIONS 第1H节和 CODEX_TASK.md。恢复后保留全部本地工作，从B/C未验证步骤顺序继续，未重做绿色A阶段，未重新制定任务书。

## 1. 交付结果与提交边界

A–D后端实施及E安全降级流程已通过各自实现SHA独立CI。最终本地 **64/64 unit、298/298 PostgreSQL integration（22/15个测试文件）、typecheck/build** 全部通过；独立E CI同样64/298。E仅完成整单协议记录、分离退款陈述与授权人工核查/等待资金事实，**正式终止及真实退款仍受阻**，按任务E3明示，不冒称完整支付/结案能力。

| 节点 | 完整SHA | 实际验证 |
| --- | --- | --- |
| 首次本地同步前 | 4abd382a98c0254006507322ebdc49e1a19814aa | 本地状态核对后安全fetch/ff同步，无reset/clean/覆盖 |
| 本轮授权起点 | 5f11a61ef72d048d6f938e2d59f30d2556bbd673 | 最新任务/产品权威读取，未重复执行历史任务 |
| 0 盘点及恢复证据 | f9e655b4e47b75106c067bb22f763e4fd85f2256 | 59unit/221PG基线；独立CI [38345333022](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38345333022) 成功 |
| 0 逐对象批准清理结果 | f58012cd7ddb220ee894b8224fc3bf7e67b2d8ef | 精确批准对象执行一次，主55表未变，B环境保留；CI [38346311245](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38346311245) 成功 |
| A 商家预计 | 0b14d758673964204c9033ad7ec8aaea502eed08 | 本地61unit/234PG；CI [38347218417](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38347218417) 成功 |
| B 自愿到店 | 0d68bb10c978ab3a95980969b76a67ec88e10d1d | 本地64unit/243PG；CI [38360085758](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38360085758) 成功 |
| C 暂停/恢复及待审退出 | dce1882332664dbb670203ed14ac2cc4b9146a30 | 本地64unit/263PG；CI [38371930121](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38371930121) 成功 |
| D 通知/知悉/独立风险核查 | fd172b19baa3276b413040392e57e1694dfb9b19 | 本地64unit/283PG；CI [38394905905](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38394905905) 成功 |
| E 实现终点 | 4aab935c1e3dd7335c9fe8096af4fe810bda7b66 | 本地64unit/298PG；CI [38397623421](https://github.com/Serena-Lyric/campus-delivery/actions/runs/38397623421) 成功，headSha及全部步骤核实 |

所有阶段均普通提交并正常push main，无强推、reset、clean或未提交工作丢弃。C/D/E只读复审发现的问题已修复并有对应真实PG回归；审查与独立CI分别记录，不把审查说成运行了测试。

本报告是实施/验证完成后的独立文档提交。为避免自引用，报告提交的完整SHA用 `git log -1 --format=%H -- CODEX_REPORT.md` 查询；实现结束SHA为上表E。本地/远端最终HEAD及报告提交CI在交付前再核实。第十轮A根报告原正文已完整归档于 [第十轮A报告](CODEX_REPORT_2026-10-13_ROUND10A.md)，其Git blob仍为397fb7b51d5cb44356da893853a58ee5f87fe32a，未改历史正文。

## 2. 编号需求—运行时—验证映射

测试简称：ETA=[preparation-estimate](apps/api/tests/integration/preparation-estimate.test.ts)，ARR=[rider-arrival](apps/api/tests/integration/rider-arrival.test.ts)，PREP=[preparation-control](apps/api/tests/integration/preparation-control.test.ts)，EXIT=[preparation-exit](apps/api/tests/integration/preparation-exit.test.ts)，CHANGE=[order-change](apps/api/tests/integration/order-change.test.ts)，NEG=[preparation-negotiation](apps/api/tests/integration/preparation-negotiation.test.ts)。不是仅字段/路由存在的验收。

| 任务编号 | 运行时与验收证据 | 状态/边界 |
| --- | --- | --- |
| 0.1 | Git现场、diff/未跟踪/迁移历史、最新任务/产品与历史报告/CI核对；恢复从真实代码而非旧口述进度继续 | 完成 |
| 0.2 | 主卷、共卷替代容器、A verification/shop/recovery/archive/restore及历史库均逐项盘点 | 完成；见清理记录 |
| 0.3 | 备份SHA/冷恢复/逐库指纹/活动连接核验后等待逐对象许可，C6另询；许可后精确清理一次 | 完成；B新增对象未获删除批准且全部保留 |
| 0.4 | 主5432未migration/Seed/集成测试；只用55442新测试/空库、55443恢复副本和CI PG16 | 完成；主55表最终指纹不变 |
| A.1 | 默认无预计；OWNER独立版本/键/UTC时间/追加历史；订单锁拒跨店、陈旧/额外字段及取餐竞态 | ETA：默认、提前/延后、重试/并发、权限/历史/UTC和校园时区 |
| A.2 | 查询时同步逾期/商家更新提醒；READY不继续提醒，原deadline/金额/风险不动 | ETA：过去预测如实显示、READY与原40分钟/快照；无微信/SMS实际推送 |
| A.3 | 旧订单默认、角色负测试及claim响应校园时区；本地/CI绿色 | 完成 |
| B.1 | 当前ACTIVE assignment在物理取餐前一次服务器自报到店，重试幂等；无记录仍能正常取餐 | ARR：并发双击、身份/assignment、无记录取餐 |
| B.2 | 到店→READY与READY→交接两个声明节点区间；提前READY=0，无READY中间节点缺失，换人不继承 | ARR和unit：节点/终态/异议。不是连续在店或真实现场核验 |
| B.3 | 合法异常结束保留记录；缺结束节点的旧终态返回未知结束/空总时长，不伪造持续计时 | ARR：取消/换人/异常/旧终态；无GPS、离店打卡、赔偿或自动解除 |
| C.1 | OWNER无法制作追加事件/审计，独立门禁锁内挡池/直接claim及正常READY/取餐，保留Order/assignment/原期限/资金 | PREP：池/直接claim、双向真实锁竞争、重试、角色/金额不变 |
| C.2 | 无承接且无冲突、原deadline未来才恢复；暂停过期建一个人工Case，不误算自然无人承接或自动资金义务 | PREP：原窗口、重复并发expiry、期限已过不能恢复 |
| C.3 | 正式骑手报告后恢复为提议，同一当前assignment明确接受才继续；拒绝/冲突保持承接转人工 | PREP：回应版本/角色/锁等待/升级/双案件；EXIT：批准才正式解除 |
| C.4 | 可靠人工升级；原市场deadline升级与骑手回应超时分开；重复扫描幂等 | **自动回应超时升级未启用**：recoveryTimeoutSeconds=null/automaticEscalationEnabled=false；用户未确认时长，无默认接受/拒绝 |
| C.5 | 归属用户/OWNER/当前骑手可查独立状态、说明和等待回应；商家不能自行清人工门禁 | PREP：完整DTO负测、人工恢复事实/handler/版本；仅站内查询/事件 |
| D.1 | OWNER只追加取餐前通知/三态自报；通知不自动改商品、金额、结算或原风险 | CHANGE：商品/价格/风险/task全事实比对、数据库UPDATE保护 |
| D.2 | 冻结商家身份名称、服务器时间/版本；池/详情/持单必要消息及风险可读，风险池claimable=false | CHANGE：池及角色隔离、历史稳定、原骑手新通知/时间线不泄露 |
| D.3 | 每notice/当前assignment自愿知悉一次，新通知/换人不继承；不是同意或弃权，不作为取餐条件 | CHANGE：并发、换人、无知悉正常取餐、知悉后仍可举报 |
| D.4 | 原/orders/:id/exceptions新增GOODS_CHANGE_OBJECTION，绑定当前assignment/可选通知/证据，共享Case | CHANGE：报告重试、实际证据保留、覆盖事件一并核查解决；不自动解除/判责/赔偿 |
| D.5 | 新增/未核定核心风险独立sticky门禁，后续无风险声明不能自己清；当前handler双版本核查；未知价值继续HOLD | CHANGE：直接claim/取餐/送达/旧退款/终止旁路、照片+短码并行、真实锁竞争、双域和待审退出组合。既有漏报/交接保护可用，但不清本门禁或按旧低价放行未知新增风险 |
| E.1 | 原共享Case的单处理人/合法状态/领取升级；三版本+键+Order→Task→Case锁；SUPER_ADMIN也不得跳过handler | NEG：handler、升级、终态、陈旧/即时重试、真实Order锁等待 |
| E.2 | 整单提议/双方独立确认/异议与退款进度分离追加；新提议失去旧确认，金额冲突/承接历史走普通核查 | NEG：双方确认、争议金额、历史承接、后续事实令review失效。**正式终止未完成**，仅简化事实核查/等待可信资金流 |
| E.3 | 所有真实资金标志保持false，旧REFUND_AND_CLOSE不能用于新未完成控制单；不造收入、余额、补偿或到账 | NEG：price/Settlement完整不变、无RiderSettlement/CompensationObligation；按任务允许安全降级验收 |
| E.4 | 请求只允许wholeOrderUnavailable=true；当前骑手拒协议入口，历史权益保持；不改原商品和账、不开新窗口 | NEG：部分范围/注入字段/角色/原承接快照负测；无部分退款、价差或用户免审批结案 |
| F.1 | 64/298完整回归；六迁移隔离升级/空库/status/diff/双Seed；主55表不变 | 完成，旧59/221未回退 |
| F.2 | frozen install、generate、typecheck、unit、PG integration、build实际执行；A–E实现SHA CI全部成功 | 完成；独立日志也确认E64/298 |
| F.3 | 主产品导航、专题/角色、README、OpenAPI/API说明和本报告更新；历史A报告保留 | 完成；报告提交另做文档及CI检查 |
| F.4 | 无新增支付/自动关店/Root/UI/库存/资金规则；B新增数据保留，完成交付后停止 | 遵守 |

续接新增容量确认已运行：待审退出只释放个人容量，所有ACTIVE且未正式解除承接仍占该骑手的统一硬上限（第一版10，既有版本配置保留）。驳回后个人可能超限，原合法单不取消，只阻新claim。EXIT真实10单/个人额度恢复/合法handler/多案件测试通过。当前新待审申请入口限取餐前出餐异常；不把它泛化成所有举报自动无责，原有限个人原因取消/冷却与已核定漏报保护保持。

## 3. 迁移、Seed与数据保护

新增迁移只有以下六条，Git对起点的迁移差异全部为新增，没有修改已应用历史SQL：

| 迁移 | 实际用途 |
| --- | --- |
| 20261013000100_merchant_preparation_estimates | 可空预计/独立版本/历史 |
| 20261013000200_rider_arrival | assignment一次自报到店时间 |
| 20261013000300_preparation_control | 独立出餐控制/来源与追加审计 |
| 20261013000400_pending_exit_capacity | 待审退出状态/个人容量临时释放及约束 |
| 20261013000500_order_change_notices | 三态通知/assignment知悉/变更审计/UPDATE保护 |
| 20261013000600_preparation_negotiation | 整单协商版本/陈述/核查追加记录，整数分约束 |

[scripts/verify-round10b-migrations.ps1](scripts/verify-round10b-migrations.ps1)只指向固定B隔离目标。升级副本先后比对所有旧业务行投影（排除本轮新增字段及_prisma_migrations）；新列默认不回补虚假出餐/到店/付款事实。新空库campus_round10b_empty及_b/_c/_d/_e分别完成全迁移、status、diff无漂移、双Seed；原订单/价格/结算/审计等稳定表均保持。旧主库30条成功迁移与2条历史回滚记录未改，新增迁移只应用于隔离环境。

主库campus-delivery-postgres-1 / campus-delivery_postgres-data / 5432保持健康，全部55表最终行数/内容MD5与本轮起点相同。**主库未升级**，现有.env未改；新代码必须使用明确的本轮隔离DATABASE_URL，正式主库部署/迁移需另外安排审批与数据保护，不能直接拿当前默认旧schema运行新版本。

## 4. Docker实际清理与仍保留对象

精确对象、命令、依赖、备份SHA/恢复及执行结果见 [清理记录](docs/round10b-cleanup-plan.md)。用户先逐对象批准C1–C5、V1–V5、H1–H19、A1–A23、S1–S2、O1–O2，后另行批准C6。实际先重新核实与备份/恢复，再删除原集群19历史测试库、C1–C6旧容器及V1–V5旧卷（含已批准A/S/O库）；没有DROP FORCE、prune、删除主卷或仓库外备份。

第十轮A verification冷归档SHA256为E23DB8C7DE56B59B5CFE60E2B946E6D9E6F63F0736AA7CAB18EBF3AFF823B179，先在B新卷恢复23库并逐表核验。原逻辑备份及独立shop物理/逻辑恢复证据均保留，A repeat Seed造成的一个镜像与原库差异已单独记录，不当成无用重复。恢复现场未重复执行已删除对象清理。

| 明确保留 | 最终用途/状态 |
| --- | --- |
| campus-delivery-postgres-1 / campus-delivery_postgres-data | 主应用库与postgres保留，健康；55表原事实不变 |
| campus-round10b-test / campus-round10b-test-data | 55442独立开发验证；campus_round10b_test与_empty/_b/_c/_d/_e全保留 |
| campus-round10b-restore / campus-round10b-restore-data | 55443，恢复的23库保留；campus-delivery副本只做升级演练，其他恢复内容不Seed/删除 |
| campus-round10b-restore-archive | 本轮停止的恢复辅助容器保留，不扩展旧C6删除许可 |
| 仓库外备份目录 | D:\Application\ClaudeCode\backups\campus-round10b-20261013及原A备份保留，限制ACL，无备份入Git |

B新测试库、恢复卷和辅助容器没有逐对象删除授权，本轮未删除，也不通过停止/清理范围外资源来修复测试。

## 5. 实际验证与修复过程

本地Node v24.15.0、pnpm11.5.1、Docker Server29.8.2/PG16。frozen install成功、无锁文件/依赖改动。最终typecheck、64unit、build、298PG及六迁移验证成功；远端每阶段真实run/完整SHA见第1节，CI使用全新PG16 service，完成迁移、Seed、测试、schema drift与重复Seed，不能与本地通过混为一谈。

关键失败与闭环均留原日志：C案件锁/旧普通案件清后续出餐门禁/双案件恢复绕过，D旧异常自动终止受控承接/双域与待审退出互锁/追加异议未解决/原骑手时间线泄漏，E旧核查显示未失效/退款进度金额冲突/无参与者记录却可核查，均有真实RED或复审复现并补PG回归。E最后新增“空协商不能核查”测试使一次完整运行297通过/1失败，守卫修复后重跑最终298/298。前期未实现入口RED、测试夹具40分钟约束/错误取消路由、TS库不支持findLast和AJV尝试union时删除字段的问题也修正；没有为通过测试重置数据或修改已应用迁移。

全部证据保存在上述仓库外目录：stage-c-complete-*、stage-d-final-*、stage-e-complete-*及stage-*-ci.json/watch/full.log、stage-*-migrations.log、各RED/GREEN日志和campus-delivery-final.jsonl。该目录只存本轮取证，不作产品规则。C/D/E复审为只读代码审查；D一次代理额度限制后恢复并完成审查，没有将失败代理或未运行检查称作验证通过。

最终收口只改文档：64条本地文档链接、内容/范围及diff检查通过；报告复核独立读取CI/迁移/主指纹取证确认无重大夸大。未因文档改动重跑本地应用测试，最终提交仍按任务验证独立CI。

## 6. 四档实施状态及未完成事项

| 分类 | 本轮真实状态 |
| --- | --- |
| enforced | OWNER/assignment/handler/版本/合法状态门禁；原期限、暂停与真实锁序；个人/统一容量；风险核查、照片/短码并行；协议/金额冲突与陈旧核查拒绝 |
| data/telemetry | 自报预计、到店、声明节点经过时长、追加通知/知悉、各方协商/退款陈述、审计与人工核查记录；均不是现场/支付/责任证明 |
| reserved/placeholder | recoveryTimeoutSeconds=null、automaticEscalationEnabled=false；未选正式自动回应超时参数，没有启用分钟数或默认接受 |
| not implemented/blocked | 正式协议后终止、可信支付/退款适配器、真实退款批准/发起/到账、支付/分账/提现、Root/L1/L2及强认证、实际媒体可信防伪、微信/SMS外发、完整UI、自动关店、数量库存、部分履约/差价重算 |

E正式终止阻断来自任务E3允许的安全分离缺口及未确认可信支付渠道；不能拿双方口述当到账，不能复用旧REFUND_AND_CLOSE为未送达订单创造骑手收入。本轮新控制单挡住旧危险入口，**未全面关闭历史严重异常财务审计缺口**，不把新流程保护说成旧四本账已全部修复。

真实新增核心易损的价值/安全取证或替换风险重算不明确时保持人工HOLD，不猜金额或降低原要求。恢复回应自动升级时长、协议撤销后的合法重开、真实退款/金额授权及安全终止流程仍需后续决策/单独任务。当前API仍为开发x-user-id认证，绿色CI不是生产认证或资金运营许可。

本轮按上述已验证范围及E3安全降级交付，保留受阻子项与数据，报告提交/推送/CI核实后停止，不自动进入下一轮。
