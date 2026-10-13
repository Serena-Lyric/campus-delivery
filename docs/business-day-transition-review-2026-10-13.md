# 第十轮 A：每日营业确认过渡复核

最高规则为 PRODUCT_DECISIONS.md 第1E节；本次只复核第九轮既有实现、增加回归和解释现有字段，不开发自动关店或新的改时限制。

## 过渡与验证

当前服务器在配置锁内读取实际时间。新生效点取“当前已公布的下一实际边界”和“新HH:mm下一本地边界”的较晚者；等待生效时保留原实际营业日起点及原有效策略。替换pending配置不会提前已公布的边界。第一次新营业日从实际effectiveAt开始，然后恢复新HH:mm；日期标签不代替实际UTC起点。

| 场景 | 现有行为及回归证据 |
| --- | --- |
| 04:00→08:00 | 当天已确认日延长到次日08:00；旧04:00不会中途撤销接单权；原PG回归保留 |
| 08:00→02:00 | 首个新日从既有次日08:00起，后续按02:00；首个新日可不足24h；原PG回归保留 |
| 反复覆盖pending | 新PG测试：10/13当地04:00开始的已确认日，先改08:00，再在10/14 06:00改10:00，在10/14 09:00改02:00，最终延长至10/15 02:00，共46h；不覆写首次确认、不改旧订单 |
| 跨午夜/有效点 | 46h区间内读DTO、预览、创建一致；边界到达后预览及旧quote创建均409，真人再次确认后恢复准入；实际起点为确认唯一键 |
| America/New_York DST | 原单位测试检验缺失分钟取随后首个有效分钟、重复分钟取首次出现；新增真实PG/API测试检验03/08春季缺口、11/01秋季重复时段的改时、偏好、有效配置DTO、确认、下单及后续过期 |
| 管理员改时/确认/checkout竞态 | 新PG测试分别覆盖preview/create：持有商家锁，实际管理API替换pending，然后确认与checkout排队；推进到配置生效点后释放锁，确认读取新实际日及版本，checkout读取同一合法确认；原六组config/merchant/product锁后跨日拒单、confirm/disable-first及已准入订单与关店竞争仍保留 |

没有增加最长营业日、改时频率上限或强制关店规则。46h是可验证的既有非回溯策略，不是“每天固定营业46h”的新产品要求；若需要限制延长，必须重新取得产品决定。未修改生产代码、schema、migration或资金事实。

## 当前DTO字段及展示边界

本人 `GET /merchant/daily-confirmation` 和营业状态视图提供解析后的以下字段；这些字段不是管理员GET的顶层字段。

| 字段 | 实际含义 |
| --- | --- |
| 顶层version | 本店确认偏好的CAS版本；与operatingVersion、平台配置版本各自独立 |
| 顶层effectiveAt | 开启偏好时保存的最早营业日起点阈值；平台后来延长当前日时不会回写它，实际生效看active及实际日起点 |
| active / pendingActivation | 已启用且实际日起点达到阈值 / 仍等待后续实际日起点；不是单看墙钟超过顶层effectiveAt |
| businessDay / businessDayStartsAt | 本地日期标签 / 当前**实际UTC起点**；实际起点用于唯一确认，不是自然日00:00 |
| nextBusinessDayStartsAt | 下一**实际UTC边界**，pending时可能比常规HH:mm更晚 |
| schedule.time / version | 当前有效HH:mm与其平台策略版本；默认04:00/version0，即使已提交version3也可能仍有效version0 |
| schedule.effectiveAt | 当前有效平台策略开始时间，SYSTEM_DEFAULT为null；不是偏好effectiveAt |
| schedule.configuredTime / configuredVersion | 最新已提交HH:mm和CAS版本；等待期间不代表已生效 |
| schedule.pending / configuredEffectiveAt | 最新平台策略是否等待生效 / 其实际生效UTC时刻；false时configured和有效策略一致 |
| confirmation.policyVersion / switchingTime / businessDayStartsAt | 首次真人确认时的策略快照和实际起点；后续改时不回写历史 |

管理端 `GET /admin/business-configs/MERCHANT_DAILY_CONFIRMATION` 当前返回 `{config, audit}`；PUT返回新config本身。`config.version` 是最新已提交版本，`config.payload.time` 是待生效或已生效的设置；`payload.effectiveAt` 是此设置生效点，`payload.previous` 是等待时应继续使用的有效策略快照，`payload.transitionDayStart` 是保留的当前实际起点。GET尚未配置时404，本人视图仍提供SYSTEM_DEFAULT。

管理员GET目前没有上述解析后的营业日视图，也没有完整响应OpenAPI schema；无真实管理UI。这是既有接口/展示限制，本轮通过文档明确，不宣称管理员页面已实现。将来UI应按服务器当前时间区分有效和pending、展示实际边界；不可把config.version/time直接标为“当前有效”，也不可只根据偏好effectiveAt推断active。该UI或新增管理视图不在本轮范围。

测试入口：`apps/api/tests/business-day.test.ts`、`apps/api/tests/integration/daily-confirmation.test.ts`。只在隔离PG库执行，完整执行次数、SHA及CI结果见根第十轮A报告；第九轮历史报告仍指 `CODEX_REPORT_2026-10-12_DAILY_CONFIRMATION.md`。
