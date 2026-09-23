# AGENTS.md

## Source of truth

Before making product or business changes, read the root files in this order:

1. `PRODUCT_DECISIONS.md` — confirmed product decisions; highest priority.
2. `IMPLEMENTATION_PLAN.md` — current implementation plan and provisional engineering defaults.
3. `CODEX_TASK.md` — current execution task, if present.
4. Existing code, README, OpenAPI, tests and older design documents.

If existing code, Seed data, old design docs, or an agent recommendation conflicts with `PRODUCT_DECISIONS.md`, do not silently preserve or invent behavior. Follow the confirmed product decision, or stop and report the unresolved conflict.

Do not turn demo values, Seed values, or implementation conveniences into product decisions.

## Working tree and continuity

- Never reset, discard, checkout away, or overwrite existing uncommitted work unless explicitly instructed.
- When resuming an interrupted task, inspect `git status`, `git diff`, recent commits, migrations and untracked files first, then continue from the current state.
- Avoid duplicate migrations for the same schema change.
- Do not force-push.

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

## Reports

When a task requests a `CODEX_REPORT.md`, generate it only after implementation and validation are complete (or clearly document blocked checks). Include starting/ending commits, migrations, tests, build results, known issues, intentional omissions and unresolved product decisions.
