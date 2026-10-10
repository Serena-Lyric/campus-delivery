import type { Prisma, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { badRequest, conflict } from '../shared/errors.js';
import { addMinor, assertMinor } from '../shared/money.js';

const Money = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const reservePolicyKey = 'FINANCE_RESERVE_POLICY';
export const ReservePolicySchema = Type.Object({
  fixedFloorMinor: Money,
  forecastDays: Type.Integer({ minimum: 1, maximum: 366 }),
  forecastMultiplierBps: Type.Integer({ minimum: 0, maximum: 1000000 }),
}, { additionalProperties: false });
export type ReservePolicy = Static<typeof ReservePolicySchema>;
export function validateReservePolicy(payload: Prisma.JsonValue): ReservePolicy {
  if (!Value.Check(ReservePolicySchema, payload)) throw badRequest('INVALID_BUSINESS_CONFIG', 'Explicit fixed floor, forecast period and multiplier required; no business default is supplied');
  return payload;
}
export async function loadReservePolicy(prisma: PrismaClient | Prisma.TransactionClient) {
  const row = await prisma.businessConfig.findFirst({ where: { key: reservePolicyKey, isActive: true }, orderBy: { version: 'desc' } });
  return row ? { version: row.version, config: validateReservePolicy(row.payload) } : null;
}

export const BudgetScenarioSchema = Type.Object({
  hypotheticalCashBeforeObligationsMinor: Money,
  hypotheticalLegalEarningsBeforeReserveMinor: Money,
  forecastDays: Type.Integer({ minimum: 1, maximum: 366 }),
  obligations: Type.Array(Type.Object({
    sourceId: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    kind: Type.Union((['MERCHANT_PAYABLE', 'RIDER_INCOME', 'CUSTOMER_REFUND', 'COMMITTED_OPERATING_COST', 'APPROVED_SALARY_RESERVATION'] as const).map((kind) => Type.Literal(kind))),
    amountMinor: Money,
    alreadyDeductedFromCash: Type.Boolean(),
    alreadyDeductedFromEarnings: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 1000 }),
  forecast: Type.Array(Type.Object({
    sourceId: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    kind: Type.Union((['REFUND_LOSS', 'SUBSIDY', 'PAYMENT_FEE', 'SHORT_TERM_OPERATING_COST'] as const).map((kind) => Type.Literal(kind))),
    amountMinor: Money,
  }, { additionalProperties: false }), { maxItems: 1000 }),
}, { additionalProperties: false });
export type BudgetScenario = Static<typeof BudgetScenarioSchema>;

export function reserveRequiredMinor(fixedFloorMinor: number, dynamicForecastMinor: number) {
  return Math.max(assertMinor(fixedFloorMinor), assertMinor(dynamicForecastMinor));
}

// Simulated inputs only; flags describe the scenario's accounting basis, not verified balances.
export function previewOperatingBudget(scenario: BudgetScenario, policy: { version: number; config: ReservePolicy } | null) {
  if (!Value.Check(BudgetScenarioSchema, scenario)) throw badRequest('INVALID_BUDGET_SCENARIO', 'Only explicit simulated budget inputs are accepted');
  if (!policy) return { status: 'UNCONFIGURED' as const, reserveRequiredMinor: null, simulatedDistributableUpperBoundMinor: null };
  validateReservePolicy(policy.config);
  if (scenario.forecastDays !== policy.config.forecastDays) throw conflict('FORECAST_PERIOD_MISMATCH', 'Scenario forecast must use the configured period');
  const obligations = new Map<string, BudgetScenario['obligations'][number]>();
  for (const obligation of scenario.obligations) {
    const previous = obligations.get(obligation.sourceId);
    if (previous && (previous.kind !== obligation.kind || previous.amountMinor !== obligation.amountMinor
      || previous.alreadyDeductedFromCash !== obligation.alreadyDeductedFromCash || previous.alreadyDeductedFromEarnings !== obligation.alreadyDeductedFromEarnings)) {
      throw conflict('OBLIGATION_SOURCE_CONFLICT', 'One obligation source cannot have conflicting amount, kind or accounting basis');
    }
    obligations.set(obligation.sourceId, obligation);
  }
  const forecasts = new Map<string, BudgetScenario['forecast'][number]>();
  for (const component of scenario.forecast) {
    const previous = forecasts.get(component.sourceId);
    if (previous && (previous.kind !== component.kind || previous.amountMinor !== component.amountMinor)) throw conflict('FORECAST_SOURCE_CONFLICT', 'One forecast source cannot have conflicting amounts or kinds');
    const known = obligations.get(component.sourceId);
    if (known && (known.amountMinor !== component.amountMinor
      || !((known.kind === 'CUSTOMER_REFUND' && component.kind === 'REFUND_LOSS')
        || (known.kind === 'COMMITTED_OPERATING_COST' && ['SUBSIDY', 'PAYMENT_FEE', 'SHORT_TERM_OPERATING_COST'].includes(component.kind))))) {
      throw conflict('FORECAST_OBLIGATION_CONFLICT', 'Known obligations must be reconciled, not relabeled as forecasts');
    }
    forecasts.set(component.sourceId, component);
  }
  const cashObligationDeductionMinor = addMinor(...[...obligations.values()].filter((o) => !o.alreadyDeductedFromCash).map((o) => o.amountMinor));
  const earningsObligationDeductionMinor = addMinor(...[...obligations.values()].filter((o) => !o.alreadyDeductedFromEarnings).map((o) => o.amountMinor));
  const forecastByKind = { REFUND_LOSS: 0, SUBSIDY: 0, PAYMENT_FEE: 0, SHORT_TERM_OPERATING_COST: 0 };
  for (const component of forecasts.values()) {
    if (obligations.has(component.sourceId)) continue; // Already protected; do not also reserve it.
    forecastByKind[component.kind] = addMinor(forecastByKind[component.kind], component.amountMinor);
  }
  const forecastBaseMinor = addMinor(...Object.values(forecastByKind));
  // Round predictions upward so a fractional minor unit never reduces the safety forecast.
  const dynamic = (BigInt(forecastBaseMinor) * BigInt(policy.config.forecastMultiplierBps) + 9999n) / 10000n;
  if (dynamic > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('MONEY_OVERFLOW', 'Dynamic reserve overflowed');
  const dynamicForecastMinor = Number(dynamic);
  const reserve = reserveRequiredMinor(policy.config.fixedFloorMinor, dynamicForecastMinor);
  const cashMargin = BigInt(scenario.hypotheticalCashBeforeObligationsMinor) - BigInt(cashObligationDeductionMinor) - BigInt(reserve);
  const earningsMargin = BigInt(scenario.hypotheticalLegalEarningsBeforeReserveMinor) - BigInt(earningsObligationDeductionMinor) - BigInt(reserve);
  const cashBoundMinor = Number(cashMargin > 0n ? cashMargin : 0n);
  const earningsBoundMinor = Number(earningsMargin > 0n ? earningsMargin : 0n);
  return {
    status: 'SIMULATED' as const, policyVersion: policy.version, policy: policy.config,
    uniqueObligationCount: obligations.size, forecastByKind, forecastBaseMinor, dynamicForecastMinor,
    reserveRequiredMinor: reserve, cashObligationDeductionMinor, earningsObligationDeductionMinor,
    cashBoundMinor, earningsBoundMinor, simulatedDistributableUpperBoundMinor: Math.min(cashBoundMinor, earningsBoundMinor),
  };
}
