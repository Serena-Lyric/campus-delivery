# AGENTS.md

## Source of truth

Before making product or business changes, read the root files in this order:

1. `PRODUCT_DECISIONS.md` — confirmed product decisions; highest priority.
2. `IMPLEMENTATION_PLAN.md` — current implementation plan and provisional engineering defaults.
3. `CODEX_TASK.md` — current execution task, if present.
4. `AUDIT_FOLLOWUP.md` — confirmed code-audit gaps that must be fixed before the affected behavior is considered complete; subordinate to product decisions.
5. `EXCEPTION_HANDLING.md` — first-version operational/technical design for abnormal-order handling; subordinate to product decisions.
6. `ROLE_RESPONSIBILITIES.md` — role-oriented view of confirmed duties, permissions, restrictions and outcomes; derived from product decisions and must not create new rules.
7. `OPERATIONS_CONTEXT.md` — confirmed real-world operating context; background only, never overrides product decisions.
8. Topic/design working files such as `RIDER_CAPACITY_DECISIONS.md`, `ORDER_POOL_DECISIONS.md`, `DELIVERY_PRICING_DECISIONS.md` — useful discussion records, but they do not override `PRODUCT_DECISIONS.md` merely because they are newer.
9. Existing code, README, OpenAPI, tests and older design documents.

If existing code, Seed data, old design docs, or an agent recommendation conflicts with `PRODUCT_DECISIONS.md`, do not silently preserve or invent behavior. Follow the confirmed product decision, or stop and report the unresolved conflict.

Do not turn demo values, Seed values, or implementation conveniences into product decisions.

### Topic documents and decision reconciliation

A topic/design working file may contain newer discussion, a reopened question, or a provisional implementation hypothesis. Before Codex changes business behavior based on such a file:

- compare it explicitly with `PRODUCT_DECISIONS.md`;
- if it supersedes an older confirmed rule, first record which old rule is replaced or reopened;
- if the latest discussion is still awaiting real-world validation, mark it unresolved and do not choose one interpretation in code;
- do not let `IMPLEMENTATION_PLAN.md` or `CODEX_TASK.md` silently elevate a topic-file assumption above `PRODUCT_DECISIONS.md`.

If a task file conflicts with the source-of-truth hierarchy, stop implementation and report the conflict instead of following the lower-priority file.

## Working tree and continuity

- Never reset, discard, checkout away, or overwrite existing uncommitted work unless explicitly instructed.
- When resuming an interrupted task, inspect `git status`, `git diff`, recent commits, migrations and untracked files first, then continue from the current state.
- Avoid duplicate migrations for the same schema change.
- Do not force-push.
- After an interrupted task, never infer completion from the fact that only tests/report appear unfinished. Rebuild a requirement-to-runtime checklist from the current worktree and report which requirements already have actual enforcement, which are only partially implemented, and which remain absent.

## Docker / PostgreSQL preflight

Codex cannot rely on Docker Desktop GUI popups being visible.

Before any Docker-dependent migration, Seed, or PostgreSQL integration test:

1. Check Docker Desktop / engine health from the CLI (for example `docker desktop status` when supported, and `docker info`).
2. If Docker is unavailable, perform at most one safe Docker Desktop restart attempt.
3. Re-check CLI health after restart.
4. If Docker is still unavailable, collect CLI-visible diagnostics/logs when practical, stop Docker-dependent validation, and clearly report that human inspection of Docker Desktop may be required.

Never automatically use destructive recovery actions such as factory reset, clean/purge data, deleting Docker data directories, removing volumes, or similar operations merely to make tests pass.

If Docker fails while application code appears unrelated, distinguish infrastructure failure from code/test failure in the report.

## Validation

For completed implementation tasks, run the task-required typecheck, unit tests, PostgreSQL integration tests, build, migration and Seed validation when infrastructure is healthy.

If infrastructure prevents a required check, do not claim it passed. Report exactly what was blocked and why.

A locally reported passing test suite is not the same as independent CI verification. If the repository has no CI run/status for the implementation commit, reports and audits must say so rather than implying independent verification.

## Reports

When a task requests a `CODEX_REPORT.md`, generate it only after implementation and validation are complete (or clearly document blocked checks). Include starting/ending commits, migrations, tests, build results, known issues, intentional omissions and unresolved product decisions.

## Implementation truthfulness

- Do not report a feature or policy as implemented merely because an enum, field, interface, strategy input, route, or placeholder exists.
- A behavior counts as implemented only when the runtime path actually enforces or uses it, and the relevant tests demonstrate that behavior.
- In `CODEX_REPORT.md`, explicitly distinguish:
  - **enforced behavior** — currently affects runtime decisions;
  - **data/telemetry available** — facts are collected but do not yet affect decisions;
  - **policy hook / placeholder** — interface or configuration exists for future use;
  - **not implemented** — confirmed product behavior still missing.
- If a policy receives inputs that are not used in its decision logic, list those inputs as **reserved/not yet active**. Never imply that a multi-factor policy exists when runtime decisions depend on only one factor.
- If a product state exists only as a label or enum but does not yet change visibility, eligibility, limits, routing, or another relevant behavior, report it as semantic/model support only, not as the full mechanism.
- Before declaring an `IMPLEMENTATION_PLAN.md` phase complete, perform a requirement-to-code checklist. For every numbered requirement, identify the runtime enforcement point and at least one verification/test, or mark it explicitly incomplete.
- When the plan asks for separate concepts (for example entry thresholds vs recovery windows), do not substitute a weaker related mechanism (for example threshold hysteresis only) without calling out the gap.
- Metrics with names such as conversion rate, completion rate, rescue rate, or failure rate must define their numerator, denominator, and treatment of in-progress/non-terminal records. In-progress records must not silently count as failures unless the product definition explicitly says so.
- Rolling-window metrics must not accidentally discard valid historical terminal samples merely because newer in-progress records entered the window. If different metrics require different populations, use separate query populations or document the tradeoff explicitly.
- When reporting version/status protection, verify each runtime branch separately. A request schema containing `expectedVersion` is not evidence that every service branch actually checks it.
- Distinguish idempotency protection from stale-state protection: idempotency prevents duplicate execution of the same business action; version/status guards prevent an old or no-longer-valid action from executing after the workflow changed. High-risk paths often require both.
- A money source counts as funded only if the runtime can point to an actual reserved/deducted internal balance or a separately trusted/confirmed external payment fact. A rider-entered amount or bookkeeping allocation alone must not be reported as money actually paid.
- Do not create an income/settlement fact for an unsuccessful order merely to make a compensation ledger balance unless the product has explicitly decided that the income was earned.

## API role isolation

- Do not return or spread raw ORM/database entities directly into customer-, merchant-, or rider-facing API responses.
- Build explicit response DTOs/selects for each role. Treat newly added database fields as private by default until explicitly exposed.
- When claiming role/data isolation, inspect the complete serialized response, not only the newly added nested object. Existing scalar fields and relation payloads can still leak internal pricing, policy, identifiers, limits, or operational state.
- Add negative tests for sensitive fields that must be absent (for example merchant contribution, platform subsidy, internal policy/exposure details) rather than testing only that intended fields are present.
- When a response is described as using immutable snapshots, verify every displayed field. Do not mix snapshot labels with live mutable relations and then claim the whole response cannot drift.

## Role documentation maintenance

- After a product rule is confirmed, identify which of Customer, Merchant, Rider, and Admin it affects and keep `ROLE_RESPONSIBILITIES.md` synchronized.
- Role documentation must be written from the actor's perspective: what they must do, may do, may not do, and what consequence follows.
- Do not fill gaps in role documentation by inventing product behavior. Mark unresolved boundaries explicitly.
- `ROLE_RESPONSIBILITIES.md` is derived documentation; if it conflicts with `PRODUCT_DECISIONS.md`, fix the role document rather than overriding the product decision.

## Exception handling safety

- Follow `EXCEPTION_HANDLING.md` for the first-version abnormal-order workflow and `AUDIT_FOLLOWUP.md` for confirmed post-review gaps.
- AI/Jev may assist only with low-risk classification, priority and routing. Deterministic rules and authorized human actions control liability, refunds, freezes, penalties and account restrictions.
- A shared exception pool must provide exactly-one-active-handler semantics. The implementation may use an atomic conditional update, version/CAS, lease or equivalent mechanism; the safety property matters more than the mechanism name.
- High-risk resolution actions such as refund, freeze, release, compensation transfer and order termination must be idempotent and, where workflow state can change concurrently, version/status-protected so concurrent/retried/stale requests cannot execute an invalid economic action.
- ExceptionCase workflow operations must enforce legal state transitions, not merely compare versions. Terminal states must stay terminal unless the product explicitly defines an audited reopen path.
- An escalated case must not remain ordinarily resolvable by the operator who escalated it; escalation transfers the decision boundary to the super-admin path until an explicit audited reassignment/takeover occurs.
- Claim, release, transfer, takeover and escalation of an exception must be auditable.
