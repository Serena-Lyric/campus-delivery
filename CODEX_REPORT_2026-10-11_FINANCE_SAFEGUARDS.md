# CODEX_REPORT — 第五轮财务安全基础

日期：2026-10-11（Asia/Singapore）。仅执行 CODEX_TASK.md 第五轮 A/B/C；三阶段分别完整验证、commit、普通 push main。实现及验证已完成，本报告随后独立提交推送，然后停止。

## 1. 结果与提交

商品佣金默认0%，非零费率只影响新订单；预计平台支付手续费独立快照、独立投影，不减少商家或骑手款项、不增加用户收费。动态储备与工资安全上限提供只读模拟。真实提现/工资批准/支付入口均未开放，旧 SUPER_ADMIN 没有 Root 提现权。

| 阶段 | 完整 SHA | 内容 |
| --- | --- | --- |
| 同步前 | 5df8019（第四轮报告） | 工作区干净，main |
| 本轮起点 | de3909b8560039db9331baa9bf9010ee00ab3979 | fetch后fast-forward最新main及第五轮任务 |
| A | 6b41e0a1b7b9fe7fb39685e6b671850a7a307282 | 佣金变更版本保护、费率快照、双模式结算/退款回归、整数精度 |
| B | aad250c329c8e832d2428eed4002802b3224f933 | 平台预计手续费、独立只读投影、外部费用隔离测试契约 |
| C／实现终点 | b3dfc12c52850b5667d2321f7e1e00b9109abef5 | 动态储备模拟、全员真实提现关闭、骑手内账/真实额度分离、角色和API文档 |

A/B/C均已推送origin/main。没有force-push、reset或丢弃未提交工作。第四轮任务与报告使用原归档文件；没有重复改双侧比例、商家未来报价或救单流程。

## 2. 决策对照与开发前审查

按根文档层级阅读产品决策、实施计划、任务、审计、异常处理及角色/运营背景，并阅读FINANCE_OPERATIONS_DECISIONS.md、ADMIN_ROLE_DECISIONS.md、DELIVERY_PRICING_DECISIONS.md和第四轮归档报告。

PRODUCT_DECISIONS.md第6节2026-10-11确认允许版本化商品佣金、默认0%，明确平台手续费和动态储备边界。旧计划/专题中的“佣金未确认、仅hook”历史描述不能禁止此次明确授权的配置保护；**具体非零正式费率仍未决定**。本轮没有选择正式费率、储备金额、期间或系数。Root权限是未来边界，不等于已有Root账户或强认证。

开发前佣金已有ORDER_POLICY校验、BusinessConfigAudit、创建计算、金额/版本快照、商家结算扣减与送达平台收入累计，Seed为0。缺口是费率变更可省略expectedVersion、JSON缺少明确佣金BPS、双模式完整保护测试。本轮复用现有配置接口，没有新增佣金控制API。

B/C无需新迁移：费用估算使用既有OrderPricing JSON，预算由纯函数/只读输入计算，配置审计使用BusinessConfig / BusinessConfigAudit。没有新托管钱包、实际支付回执表或资金来源。不重解释历史价格、已FINALIZED结算或历史配置，不改变既有交易实收/退款、收益归属、冻结/暂缓、赔付/垫付四类内账事实。历史migration未修改。

## 3. 要求到运行时与测试清单

| 要求 | 运行点与结果 | 验证 |
| --- | --- | --- |
| A1 复用佣金 | merchant-policy/policies.ts、admin/config-service.ts、orders/service.ts、delivery/service.ts | 原能力审查；默认0不扣商品款 |
| A2 未来独立生效 | 创建JSON新增platformCommissionBps；已有pricingPolicyVersion及金额不回写 | LEGACY/REFERENCE_BPS两模式证明旧FINALIZED价格、商家权利、骑手收入不变；新订单1250bps仅fixture |
| A2 不对增量抽佣金 | 原救单/红包/补贴不重算商品佣金或基础价差 | 商品2000、佣金250；救单100→商家1650，红包100/补贴50全给骑手，配送贡献50、最终平台收入300；取消仍退原用户合同全额 |
| A3 CAS/审计/权限 | 配置锁内佣金费率变更强制expectedVersion；复用原API | 未传version拒绝；并发同version一成一败；前后费率/版本/actor/原因审计；OPERATOR拒绝，未新增Root |
| B1 来源独立 | finance/service.ts显式DTO分开佣金、基础配送价差、补贴、手续费与第三方权益 | 未完成订单经营确认额0；已送达FINALIZED才确认内账贡献；商家2000/骑手220不计平台收入 |
| B2 预计/实际隔离 | PAYMENT_COST_ESTIMATE显式配置；创建ESTIMATED平台承担快照；actualFeeMinor=null、NOT_VERIFIED | 2320初始合同、60bps→13；各方款项不变；改100bps旧估算13、新23；伪造actual/status拒绝 |
| B2 外部幂等/结构 | finance/costs.ts纯函数契约，未接渠道或持久化实际事实 | fixture验证provider/account/transaction去重、变更冲突、退款费用冲正、退款损失/运营支出独立；缺回执/第三方owner/管理员自报拒绝 |
| B3 不创造钱包 | GET /admin/finance/orders/:orderId/projection只读 | POST投影/回执/费用/余额404；业务角色响应不泄漏费用/内部策略；旧订单不回填 |
| C1 显式配置/审计 | FINANCE_RESERVE_POLICY校验、CAS与审计，无Seed默认 | 初始UNCONFIGURED；并发一成一败；前后/版本/actor审计；Seed保留明确配置 |
| C2 储备取高、上限取低 | finance/reserve.ts纯函数 | 固定100/动态200→200；现金1000/收益600，现金义务400/收益义务100→模拟上限300；固定升500→0；边界/精度/溢出拒绝 |
| C2 不重复扣义务 | sourceId去重；明确各基数alreadyDeducted flags；已知义务从预测额排除 | 骑手收入/退款/已批工资重复不重复扣；金额/类型/基数冲突拒绝；已扣不再扣；期间不一致拒绝 |
| C3 只读模拟 | POST /admin/finance/budget-preview只接hypothetical场景 | simulated/notVerified/关闭提现；预览前后审计数、订单数、pricing、settlement不变；无配置返回null |
| C4 Root未启用全拒 | finance/permissions.ts真实状态关闭；预留requireRealWithdrawalApproval始终403；无执行路由 | SUPER_ADMIN/OPERATOR/三业务角色/伪造ROOT全拒；最大模拟额、x-root、回执/认证字段不能开启；工资/提现POST404 |
| C 内账不冒充可提现 | orders/service.ts和settlements/service.ts共用显式unverifiedRiderBalanceView | 订单详情/骑手列表withdrawableMinor及realWithdrawableMinor=0；internalUnreservedMinor保留amount−reserved；冻结赔付回归通过 |

只完成第五轮具体要求，不宣布整个旧IMPLEMENTATION_PLAN已完成，不把全量回归当作所有待实现产品行为已上线。

## 4. 金额、预测与可信边界

预计手续费=floor(初始合同总额×feeBps/10000)+fixedFeeMinor，由平台承担，不修改用户报价、商家应结、骑手收入或FINALIZED Settlement。创建读取配置并在原共享配置锁内保存估算快照，后续配置不重算旧单。基数为初始商品款加用户基础配送费，**不覆盖后续红包或真实退款费用调整**。佣金及费用BPS使用BigInt精确整数计算。

订单“预计净贡献”仅为已送达FINALIZED内账平台收入减本次费用估算，未知真实退款损失、运营成本等不包含，**不是完整净利润、合法可分配收益或现金余额**。其他平台实际成本为null；用户退款义务单列，不将全部应退款直接当平台实际损失。无实际渠道扣费事实。

动态预测为同一显式期间四类模拟估计额：退款/损失、补贴、支付费用、短期运营成本。按sourceId去重并排除已保护义务，合计乘forecastMultiplierBps/10000向上取整；reserveRequired=max(fixedFloor,dynamicForecast)。forecastDays用于期间一致性和标识，**没有从近期真实订单自动生成预测**。风险分群、真实样本、系数校准和滚动更新未实现。

模拟现金基数在义务扣减之前，模拟合法收益基数在储备扣减之前。已知义务注明是否已分别扣入现金/收益，包括商家应款、骑手收入、退款、承诺运营支出、已批未执行工资预留，同一来源仅扣一次。现金/收益分别减去尚未计入的义务（含工资预留）和储备，取两者较小非负值。全部为模拟输入，不核实合法性或实际资金；客户端不得声明真实余额或Root认证。

没有外部自有现金证据、渠道、正式Root强认证及合法收益核验。即使模拟上限=Number.MAX_SAFE_INTEGER，真实提现额也固定0；预览不批准工资、不占用或支付真实资金。

## 5. 四档生效状态与应用配置

| 分类 | 范围 | 当前状态 |
| --- | --- | --- |
| **enforced** | 佣金创建快照、变更CAS、未来生效、角色隔离、明确估算配置、真实余额0/提现入口不存在、骑手内账与可提现额分离 | 应用ORDER_POLICY版本2，佣金0；未自动启用非零；旧SUPER_ADMIN无Root资金权 |
| **only simulation** | 经营/预计费用投影、配置后新合同费用估算、动态储备和工资预算上限 | simulated=true/notVerified=true；应用PAYMENT_COST_ESTIMATE与FINANCE_RESERVE_POLICY均未配置；预算UNCONFIGURED，不用fixture参数 |
| **hook** | 外部成本类型、provider/account/transaction/receipt/owner/核验来源、去重/冲正纯函数；全员拒绝未来执行守卫 | 仅隔离fixture验证；没有可信adapter、实际费用持久化或外部写API。守卫未连接执行器，因为执行器不存在 |
| **not implemented** | 正式Root/L1/L2、强认证/恢复、真实支付/退款/分账/费用回执、可信现金/收益对账、工资批准/预留/执行/交接、真实订单自动预测、完整财务UI | 未开发，模拟不等于真实发薪/提现 |

应用DELIVERY_PRICING_POLICY不存在，仍默认LEGACY_ORDER_POLICY；RIDER_ELIGIBILITY_POLICY不存在，资格gate默认关闭。创建仍CREATED开发合同，无PAID或真实收款确认。未调用微信支付、创建平台/Root个人收款账户、工资收款人或自动薪酬规则。

既有骑手AVAILABLE仍是内部状态，不证明外部到账。两个DTO原正数withdrawableMinor现固定0，原值由internalUnreservedMinor表达；收入/预留/冻结和数据库状态不变。**这是API显示语义变化**，调用方应显示“内账未预留额”，不能显示为真实可提现款。README及ROLE_RESPONSIBILITIES.md已同步。

## 6. 实际运行验证

| 检查 | A | B | C最终 |
| --- | --- | --- | --- |
| pnpm db:generate | 通过 | 通过 | 通过 |
| pnpm typecheck | 通过 | 通过 | 通过 |
| pnpm test | 16文件48/48 | 17文件51/51 | 18文件55/55 |
| pnpm test:integration | 6文件153/153 | 6文件155/155 | 6文件157/157 |
| pnpm build | 通过 | 通过 | 通过 |
| migration/Seed | 隔离空库24条迁移、Seed通过 | 无pending、Seed与配置保留测试通过 | 应用/旧库副本/独立空库deploy/status/drift通过；空库首轮及追加连续两轮Seed六表指纹一致 |
| OpenAPI/权限 | 原配置回归 | 只读投影及伪造写入口拒绝 | 预算只读描述、角色拒绝、无提现/发薪路径 |

PG回归覆盖原40分钟、商家短码/交接争议、核心易损证据、取消冷却、学生资格gate、个人屏蔽、退款冻结、赔付预留和补贴。媒体仍为mock reference，不代表真实相机/微信媒体。

修复过的失败：A初次测试补贴函数参数与取消body错误；C新增测试helper unknown payload导致TS错误。修正后完整重跑；最后骑手withdrawable语义修正后再跑完整C。表中均为最终绿色结果，没有被基础设施阻塞的检查。

Docker CLI Desktop running、docker info正常、PostgreSQL healthy；未restart、factory reset、purge、删卷或应用DB reset。会清理数据的集成测试均在本轮隔离库。

**独立CI未验证**：无跟踪的.github workflow，本轮未取得独立CI通过证据。表中是本地实际运行结果，不称为独立CI验证。

## 7. 迁移、历史一致性和备份

新增迁移0，现有24条不修改。应用库deploy无pending/status up to date，对迁移目录shadow diff无漂移。原dump恢复至旧库副本后deploy/status/schema diff正常；独立空库全量迁移/Seed/schema diff正常。

原应用库、dump恢复副本、最终应用库六表指纹相同：

| 表 | 数量 | MD5 |
| --- | ---: | --- |
| OrderPricing | 2 | 2d587eb3888bc64da2110f45597385d6 |
| Settlement | 2 | 31c7ed73395b297f5a44af3b9ecbadb2 |
| DeliveryAssignment | 0 | d41d8cd98f00b204e9800998ecf8427e |
| RiderSettlement | 0 | d41d8cd98f00b204e9800998ecf8427e |
| BusinessConfig | 2 | 0bcef6c0031d7d9f0435437e7184801d |
| BusinessConfigAudit | 1 | aba90bf63c9779d06e070b60d8adad52 |

原库没有历史骑手收入样本，零记录指纹不能证明完整场景；另以两模式集成测试生成FINALIZED和骑手收入，证明后续费率/配置不漂移。

空库首轮及追加连续两次Seed指纹相同：OrderPricing8行(f01fdde8051ac281fef6985d86444192)、Settlement8行(02517419d933c5081a8c654e30e3e724)、DeliveryAssignment5行(0f28e210ae28b749aeafbbf6f6dd7594)、RiderSettlement1行(3a5d773f57303c77a35396c366f6dc67)、BusinessConfig1行(3b4afba91aace6eefe189e0ad29d3408)、BusinessConfigAudit0行。默认佣金0，无新费用/储备/双侧/资格配置。另有集成测试证明明确费用与储备配置不被Seed覆盖。

备份保留容器/tmp及本机目录：

`C:\Users\Serena Lyric\AppData\Local\campus-delivery\validation\2026-10-11-round5\`

- campus_finance_round5_before.dump：186723字节，原应用库验证前备份。
- campus_finance_round5_seedfirst.dump：174781字节，空库首轮Seed备份。

验证后仅删除本轮创建的四个隔离库：campus_finance_round5_test_20261011、campus_finance_round5_upgrade_20261011、campus_finance_round5_empty_20261011、campus_finance_round5_shadow_20261011。应用库及Docker卷保留。

## 8. 未完成与停止线

- 正式非零佣金、费用费率、最低储备、预测期间和系数仍未确定；两项财务配置未在应用库启用。
- 实际费用持久化、可信交易验证/对账/退款费用调整、完整净利润和合法可分配收益确认未实现。receipt-shaped fixture不构成真实核验。
- 真实近期订单自动风险预测、差异化权重、储备自动滚动更新未实现；当前仅显式参数的模拟计算。
- 正式Root强认证、合规支付资质/账户、真实微信/银行支付、商家真实48小时提现、工资审批/实际预留/执行/交接、个人分红算法未实现。
- 旧异常业务待完善边界不在本轮重构，不从回归通过推定所有产品规则均已落地。代买、真实登录/媒体和完整前端未开展。

完成A/B/C及报告提交推送后停止，不继续下一轮，不启用真实付款或提现。
