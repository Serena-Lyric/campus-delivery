# AGENTS.md

## Product authority and task context

- `PRODUCT_DECISIONS.md` is the highest product authority. Plans, tasks, audits, topics/designs, derived/background docs, code, README, OpenAPI, tests and Seed cannot override it. Demo values, engineering defaults and agent recommendations are not product rules.
- Before business changes, reconcile the topic/plan/task with the product decision; record replaced/reopened rules and preserve history. Pending/provisional details remain unresolved. If a conflict needs a new product decision, stop that part and report it; do not choose in code.
- Separate confirmed, provisional, historical/superseded and pending rules from implementation status. Confirmed can be unimplemented. Check dated replacements and scope, not file recency.
- Read relevant sections and references affecting behavior/safety, not every root document.

| Task | Relevant documents |
| --- | --- |
| Wording, links, local documentation | Target document and directly related sources; product rules only if the edit affects their meaning |
| Product/business behavior | Relevant `PRODUCT_DECISIONS.md` sections, corresponding topic/design and affected `ROLE_RESPONSIBILITIES.md` sections |
| Pricing, payment, finance, settlement | Product sections + `FINANCE_OPERATIONS_DECISIONS.md` / `DELIVERY_PRICING_DECISIONS.md`; abnormal funds also require `EXCEPTION_SETTLEMENT_DESIGN.md` and `EXCEPTION_HANDLING.md` |
| Fulfillment, rider capacity/eligibility, order pool, catalog/evidence | Matching topic: `RIDER_CAPACITY_DECISIONS.md`, `ORDER_POOL_DECISIONS.md`, `MERCHANT_PICKUP_AND_RIDER_BLOCKLIST_DECISIONS.md`, `FRAGILE_PICKUP_EVIDENCE_DECISIONS.md`, `CATALOG_DISPLAY_AND_DELIVERY_CLASSIFICATION.md`; eligibility rules are in the product file |
| Roles, authorization, API visibility | Product sections + `ADMIN_ROLE_DECISIONS.md` / `ROLE_RESPONSIBILITIES.md` |
| Implementation, audit, interrupted work, phase acceptance | Relevant `IMPLEMENTATION_PLAN.md`, matching task/report and affected `AUDIT_FOLLOWUP.md` findings; open audit gaps must be fixed before claiming the affected behavior complete |

`OPERATIONS_CONTEXT.md` and research files provide background, not new rules. Completed tasks, old “this round” instructions and historical push commands do not authorize new work. Reports describe their recorded commit.

For confirmed rules, update affected Customer/Merchant/Rider/Admin responsibilities (must/may/may not/consequences). Correct conflicting derived role docs; mark unresolved boundaries, never invent rules.

## Git and continuity

- Preserve uncommitted work: no reset, discard, checkout away or overwrite without explicit instruction. Never force-push.
- Resume from `git status`, diff, recent commits, untracked files and migration history. Avoid duplicate migrations.
- After interruption, rebuild the requirement-to-runtime checklist: enforced, partial or absent. “Only tests/report remain” is not proof that implementation is complete.

## Money and migration integrity

- Funded money requires an actual reserved/deducted internal balance or separately trusted external payment fact. Rider-entered amounts and bookkeeping allocations are not proof of payment; internal settlement/AVAILABLE labels are not external cash.
- Do not create income/settlement for an unsuccessful order merely to balance compensation unless the product confirms that income was earned.
- The former first-stage split-payment preference was **superseded on 2026-10-13** by PRODUCT_DECISIONS.md section 1G: neither split nor unified payment is selected until verified legal payment entity and provider capability. Historical 48-hour merchant cooling is not a current channel commitment. Never imply control over directly paid merchant funds.
- Configurable merchandise commission, default 0%, and merchant base quote as a pricing reference without merchant funding are confirmed. Do not silently enable a nonzero rate, treat a quote as funded, or confuse delivery spread with commission or net cash/profit.
- `20260926000400_capacity_pool_pricing` rewrote pre-production demo/development semantics; it is not a production financial migration template.
- Never edit applied migrations to disguise history. Later schema/data corrections use new migrations. With production accounting data, preserve `FINALIZED` facts and previously effective historical config versions; corrections need an explicit versioned migration/event or reviewed strategy retaining the prior fact and adjustment audit.

## Role isolation and exception safety

- Use explicit role DTOs/selects; never return/spread raw ORM entities to Customer/Merchant/Rider. New database fields are private unless explicitly exposed.
- Verify complete serialized responses, including existing scalars/relations. Add negative tests for absent sensitive fields (merchant contribution, subsidy, internal policy/exposure/identifiers). Verify every displayed snapshot field; live relations can drift.
- AI/Jev may assist low-risk classification, priority and routing only. Deterministic rules and authorized human actions control liability, refunds, freezes, penalties and account restrictions.
- Shared exception handling requires exactly one active handler through atomic update/CAS/lease or equivalent. Claim, release, transfer, takeover and escalation must be auditable.
- Refund, freeze, release, compensation transfer and termination require idempotency plus version/status guards where state can change concurrently. Idempotency prevents duplicates; stale-state protection prevents actions after workflow changes. Verify every runtime branch; an `expectedVersion` schema field alone proves neither.
- Enforce legal ExceptionCase transitions, not just versions. Terminal cases stay terminal unless an explicitly approved audited reopen exists. Escalation removes the escalating operator's ordinary resolution/refund authority until lawful audited reassignment/takeover; apply the authorized superior path, not assumed Root rights for old SUPER_ADMIN.

## Validation and accurate reporting

- For implementation, run task-required typecheck, unit/PostgreSQL integration tests, build, migration and Seed validation when infrastructure is healthy. Documentation-only maintenance uses scope, content, reference and diff checks unless the task requires more; do not claim application tests ran.
- Before Docker-dependent migration/Seed/PG tests, check CLI health (`docker info`, Desktop status when supported); do not rely on GUI popups. If unavailable, try at most one safe Desktop restart and re-check. If still unavailable, collect CLI diagnostics where practical, stop dependent checks and report possible need for human inspection.
- Never factory-reset/purge Docker data, delete data directories or remove volumes to make tests pass. Distinguish infrastructure failure from application/test failure; report blocked checks and reasons.
- Local passing tests are not independent CI. Without a CI run/status for the implementation commit, say independent verification is unavailable.
- Implemented means runtime enforcement/use demonstrated by relevant tests. Enums, fields, interfaces, routes or labels alone are model support. Distinguish **enforced behavior**, **data/telemetry available**, **policy hook/placeholder**, **not implemented**; mark unused policy inputs **reserved/not yet active**, and simulations as simulations.
- For phase completion, map every numbered requirement to runtime enforcement and a verification/test, or mark incomplete. Report weaker substitutes (e.g. hysteresis instead of a separate recovery window).
- Define rates' numerator, denominator and non-terminal treatment; in-progress is not failure unless the product says so. New in-progress records must not displace valid terminal samples in rolling windows; use separate populations or document the tradeoff.
- Documentation-only design records and PRE_NEXT_ROUND_CHECKLIST.md are not authority to begin Codex round ten; require explicit user authorization.
- Create a requested report only after implementation/validation, or clearly record blocked checks. Include starting/ending commits, migrations, tests/build, known issues, intentional omissions and unresolved product decisions. Preserve historical report bodies; cite the report matching the task.
