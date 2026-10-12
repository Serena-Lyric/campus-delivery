# 第七轮商家营业与商品三态实施计划

> **For agentic workers:** Use executing-plans to implement this plan inline, task by task.

**Goal:** OWNER 管理本店手动营业和商品三态，服务端并发保护新单且保留历史事实。

**Architecture:** 复用 Merchant.isOpen；增加独立营业 version 与审计。商品以受数据库约束的 saleStatus 为权威，保留 isAvailable 作为旧客户端/旧写入兼容投影；false 历史回填为 OFF_SHELF。checkout 延续 config→merchant→catalog→locations 锁顺序。

**Tech Stack:** Fastify / TypeBox / Prisma / PostgreSQL / Vitest。

**Spec:** CODEX_TASK.md A/B/C；PRODUCT_DECISIONS.md 1B/1C；MERCHANT_OPERATIONS_AND_STOCK_DECISIONS.md。

## Global Constraints

- A 绿色、独立提交并普通推送后才能进入 B；B 同样后才能进入 C。
- 不改应用库历史订单/资金/履约快照，不修改已应用迁移；迁移前备份，测试使用隔离库。
- 无每日调度、数量库存、次日恢复、真实支付；API 支持不能称为 UI 上线。
- OWNER 来源为认证用户的 merchant 绑定，并在事务内验证 ownerId；请求不能指定归属/曝光状态。

## Review Focus

- 额外字段拒绝：请求 merchantId、ownerId、exposureState、风险或价格字段不得被静默接受。
- 重放/无变化：相同当前版本不产生重复事件，陈旧版本必须拒绝。
- 两个方向的竞态：写先提交则新单失败；checkout 先持锁则先成立、随后关店/售罄不修改旧单。
- 旧 false 仍隐藏；旧 bool 写入与枚举不能矛盾；旧客户端完整编辑不得无意恢复售罄。
- 重复 Seed 保留手动营业/商品状态、版本、审计和历史资金。

## A：营业 API 与服务端保护

**Files:** prisma/schema.prisma、增量迁移、src/catalog/operating-status.ts、src/catalog/routes.ts、prisma/seed.ts、tests/integration/merchant-operations.test.ts、ROLE_RESPONSIBILITIES.md。

**Interfaces:** GET/PUT /merchant/operating-status；PUT {isOpen, expectedVersion, reason}；返回 {id,isOpen,operatingVersion,acceptingOrders,operatingStatusLabel,changed?}；独立审计旧→新/actor/reason/time。

- [x] 写 API OWNER/输入/版本/可见性/关店前后报价与创建/历史不变/Seed 的失败集成测试，运行并观察预期失败。
- [x] 新增营业版本及审计迁移，开关操作 merchant FOR UPDATE + owner 校验 + CAS；无变化不加版；目录增加休息/接单字段。Seed 更新不重开已存在店铺。
- [x] db:generate/typecheck/test/test:integration/build 全通过；应用库/旧副本/空库 migrate；备份可恢复及财务指纹不变。
- [x] 审查 diff，提交并普通推送 main，SHA 由 Git 本阶段提交确定。

## B：商品三态与兼容

**Files:** schema.prisma、新增商品迁移、src/catalog/service.ts、routes.ts、product-status.ts、orders/quote.ts、orders/service.ts、seed.ts、tests/integration/merchant-operations.test.ts。

**Interfaces:** PUT /merchant/catalog/products/:id/sale-status {saleStatus,expectedVersion,reason}；ON_SALE/SOLD_OUT/OFF_SHELF；public 显式 DTO 返回 status/label/purchasable（营业状态与商品状态合成）；商家目录三态。

- [x] 写售罄可见不可买/下架隐藏/越权/快捷操作保留风险价格/旧编辑兼容/锁竞态/Seed 的失败测试并运行。
- [x] 增量迁移历史 true→ON_SALE、false→OFF_SHELF；数据库兼容触发器维护 bool 投影，约束矛盾；状态专用 CAS 审计，不改风险/营销/价格；旧完整编辑相同 bool 保持 SOLD_OUT。
- [x] checkout 拒绝非 ON_SALE，公共菜单只隐藏 OFF_SHELF；db:generate/typecheck/test/test:integration/build；三个库迁移、旧库可见性/空库/重复 Seed 验证。
- [x] 审查 diff，提交并普通推送 main，SHA 由 Git 本阶段提交确定。

## C：兼容验收与报告

**Files:** tests/integration/merchant-operations.test.ts、迁移验收脚本、README.md、ROLE_RESPONSIBILITIES.md、CODEX_REPORT.md。

- [x] 补充真实 PostgreSQL 双向锁竞态、旧写入/快照/资金/易损取证回归；先观察新增行为测试的失败再修补必要缺口。
- [x] 最终五命令通过；新旧空库迁移/状态/drift、重复 Seed 及完整历史指纹核验；逐项映射 A1–A5/B1–B5/C。
- [ ] 保留历史报告正文归档；更新实际结果、迁移/备份/兼容、阶段 SHA、已执行/仅 API/未实现和独立 CI 限制。
- [ ] 独立提交并普通推送 C，最终核对远端一致后停止。

## 执行记录

- 起点 d450d6d，工作区干净；fetch + ff-only 到 c7744f4；应用库 24 条迁移已完成，Docker CLI/Desktop 健康，无需恢复。
- 已有 checkout Merchant/Product FOR SHARE 与预分类版本核验；旧商品公共过滤 isAvailable=true。复用而非另建营业真相。
- 用户已授权顺序开发/验证/提交/push，本计划直接执行，不增加审批步骤。
- A：7 条新 API 测试先因路由缺失失败，随后通过；补充真实 PG 锁等待三个方向，共10项。完整 unit 55 / PG 167 通过，generate/typecheck/build通过。早期 PG 两轮各有旧目录计数1项失败，因新夹具泄漏；补清理后全绿。review 无严重问题，Minor 指纹范围已补全。旧副本与空库各连续 Seed 两次通过；应用库未执行可重写演示资料的 Seed，Seed行为在副本/空库和隔离集成测试验证。
- A 已普通推送 bb7b15d。
- B：4项三态失败测试红→绿；补实际 Product 锁等待竞态与完整编辑额外字段201→400红→绿（首轮全套也记录该1项失败）。最终 unit55 / PG174全绿，generate/typecheck/build通过；应用/旧副本/空库无drift，既有表指纹保持。旧副本历史false样本升级仍OFF_SHELF、version1、公共API隐藏；旧副本/空库各重复Seed两次保留三态、营业、18类历史/审计表摘要。review 最新快照无问题。
- B 已普通推送 5586db0。
- C：新增 OWNER 服务层伪绑定、旧 ORM bool 兼容、preview→售罄锁等待和真实完整履约/FINALIZED不变回归，新文件共21项，全套PG178、unit55通过，generate/typecheck/build通过。初次生命周期测试的商家资金隔离断言过宽和夹具DeliveryTask清理顺序已修正，无运行时代码改动。原备份恢复24迁移基准库，47张既有表与最终应用库原字段指纹完全一致；新空库从零26迁移、首轮Seed+两轮重复Seed通过。最终独立代码审查无问题；GitHub B实现提交无CI运行，独立CI不可用。C交付先提交推送，报告随后记录其实际SHA再单独提交；避免报告自引用提交哈希。
