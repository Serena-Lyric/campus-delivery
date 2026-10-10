import { describe, expect, it } from 'vitest';
import { previewOperatingBudget, reserveRequiredMinor, validateReservePolicy, type BudgetScenario } from '../src/finance/reserve.js';
import { realWithdrawalStatus, requireRealWithdrawalApproval } from '../src/finance/permissions.js';
import type { Actor } from '../src/auth/auth.js';

const policy = { version: 1, config: { fixedFloorMinor: 100, forecastDays: 7, forecastMultiplierBps: 10000 } };
const scenario: BudgetScenario = {
  hypotheticalCashBeforeObligationsMinor: 1000, hypotheticalLegalEarningsBeforeReserveMinor: 600, forecastDays: 7,
  obligations: [
    { sourceId: 'merchant1', kind: 'MERCHANT_PAYABLE', amountMinor: 100, alreadyDeductedFromCash: false, alreadyDeductedFromEarnings: true },
    { sourceId: 'rider1', kind: 'RIDER_INCOME', amountMinor: 50, alreadyDeductedFromCash: false, alreadyDeductedFromEarnings: true },
    { sourceId: 'refund1', kind: 'CUSTOMER_REFUND', amountMinor: 50, alreadyDeductedFromCash: false, alreadyDeductedFromEarnings: true },
    { sourceId: 'ops1', kind: 'COMMITTED_OPERATING_COST', amountMinor: 100, alreadyDeductedFromCash: false, alreadyDeductedFromEarnings: true },
    { sourceId: 'salary1', kind: 'APPROVED_SALARY_RESERVATION', amountMinor: 100, alreadyDeductedFromCash: false, alreadyDeductedFromEarnings: false },
  ],
  forecast: [
    { sourceId: 'futureRefunds', kind: 'REFUND_LOSS', amountMinor: 50 },
    { sourceId: 'futureSubsidy', kind: 'SUBSIDY', amountMinor: 50 },
    { sourceId: 'futureFees', kind: 'PAYMENT_FEE', amountMinor: 50 },
    { sourceId: 'futureOps', kind: 'SHORT_TERM_OPERATING_COST', amountMinor: 50 },
  ],
};

describe('simulated operating reserve and cash/earnings bounds', () => {
  it('takes the higher reserve and the lower nonnegative cash/earnings bounds after all obligations', () => {
    expect(reserveRequiredMinor(100, 200)).toBe(200);
    expect(reserveRequiredMinor(300, 200)).toBe(300);
    expect(previewOperatingBudget(scenario, policy)).toMatchObject({ reserveRequiredMinor: 200, cashObligationDeductionMinor: 400, earningsObligationDeductionMinor: 100,
      cashBoundMinor: 400, earningsBoundMinor: 300, simulatedDistributableUpperBoundMinor: 300 });
    expect(previewOperatingBudget({ ...scenario, hypotheticalCashBeforeObligationsMinor: 500 }, policy)).toMatchObject({ simulatedDistributableUpperBoundMinor: 0 });
    expect(previewOperatingBudget({ ...scenario, hypotheticalLegalEarningsBeforeReserveMinor: 50 }, policy)).toMatchObject({ simulatedDistributableUpperBoundMinor: 0 });
    expect(previewOperatingBudget(scenario, { ...policy, config: { ...policy.config, fixedFloorMinor: 500 } })).toMatchObject({ reserveRequiredMinor: 500, simulatedDistributableUpperBoundMinor: 0 });
  });

  it('does not double subtract refund, rider income, salary reservations or forecasts for known obligations', () => {
    const deduplicated = { ...scenario, obligations: [...scenario.obligations, scenario.obligations[1]!, scenario.obligations[2]!, scenario.obligations[4]!],
      forecast: [...scenario.forecast, scenario.forecast[0]!, { sourceId: 'refund1', kind: 'REFUND_LOSS' as const, amountMinor: 50 }, { sourceId: 'ops1', kind: 'SHORT_TERM_OPERATING_COST' as const, amountMinor: 100 }] };
    expect(previewOperatingBudget(deduplicated, policy)).toEqual(previewOperatingBudget(scenario, policy));
    const alreadyProtected = { ...scenario, hypotheticalCashBeforeObligationsMinor: 600, hypotheticalLegalEarningsBeforeReserveMinor: 500,
      obligations: scenario.obligations.map((o) => ({ ...o, alreadyDeductedFromCash: true, alreadyDeductedFromEarnings: true })) };
    expect(previewOperatingBudget(alreadyProtected, policy)).toMatchObject({ cashObligationDeductionMinor: 0, earningsObligationDeductionMinor: 0, simulatedDistributableUpperBoundMinor: 300 });
    expect(() => previewOperatingBudget({ ...scenario, obligations: [...scenario.obligations, { ...scenario.obligations[1]!, amountMinor: 1 }] }, policy)).toThrow(/conflicting/);
    expect(() => previewOperatingBudget({ ...scenario, forecast: [...scenario.forecast, { sourceId: 'rider1', kind: 'REFUND_LOSS', amountMinor: 50 }] }, policy)).toThrow(/relabeled/);
    expect(() => previewOperatingBudget({ ...scenario, forecast: [...scenario.forecast, { ...scenario.forecast[0]!, amountMinor: 1 }] }, policy)).toThrow(/conflicting/);
  });

  it('has no invented config defaults, validates period and inputs, rounds forecast up and rejects overflow', () => {
    expect(previewOperatingBudget(scenario, null)).toMatchObject({ status: 'UNCONFIGURED', reserveRequiredMinor: null, simulatedDistributableUpperBoundMinor: null });
    expect(() => validateReservePolicy({ fixedFloorMinor: 100 })).toThrow();
    expect(() => validateReservePolicy({ ...policy.config, realWithdrawalEnabled: true })).toThrow();
    expect(() => previewOperatingBudget({ ...scenario, forecastDays: 3 }, policy)).toThrow(/period/);
    expect(() => previewOperatingBudget({ ...scenario, hypotheticalCashBeforeObligationsMinor: -1 }, policy)).toThrow();
    expect(() => previewOperatingBudget({ ...scenario, hypotheticalCashBeforeObligationsMinor: 0.5 }, policy)).toThrow();
    expect(previewOperatingBudget({ ...scenario, forecast: [{ sourceId: 'one', kind: 'PAYMENT_FEE', amountMinor: 1 }] }, { ...policy, config: { ...policy.config, fixedFloorMinor: 0, forecastMultiplierBps: 1 } })).toMatchObject({ dynamicForecastMinor: 1 });
    expect(() => previewOperatingBudget({ ...scenario, forecast: [{ sourceId: 'huge', kind: 'REFUND_LOSS', amountMinor: Number.MAX_SAFE_INTEGER }] }, { ...policy, config: { ...policy.config, forecastMultiplierBps: 10001 } })).toThrow(/overflow/);
    expect(previewOperatingBudget({ ...scenario, hypotheticalCashBeforeObligationsMinor: Number.MAX_SAFE_INTEGER, hypotheticalLegalEarningsBeforeReserveMinor: Number.MAX_SAFE_INTEGER, forecast: [], obligations: [] }, { ...policy, config: { ...policy.config, fixedFloorMinor: 0 } })).toMatchObject({ simulatedDistributableUpperBoundMinor: Number.MAX_SAFE_INTEGER });
  });

  it('denies every role including legacy super-admin and forged Root without any amount/config bypass', () => {
    const actors: Actor[] = [{ id: 'customer', role: 'CUSTOMER' }, { id: 'merchant', role: 'MERCHANT' }, { id: 'rider', role: 'RIDER' },
      { id: 'operator', role: 'ADMIN', adminLevel: 'OPERATOR' }, { id: 'super', role: 'ADMIN', adminLevel: 'SUPER_ADMIN' }, JSON.parse('{"id":"forged-root","role":"ADMIN","adminLevel":"ROOT","strongAuth":true}')];
    for (const actor of actors) expect(() => requireRealWithdrawalApproval(actor)).toThrow(/disabled for every identity/);
    expect(realWithdrawalStatus()).toMatchObject({ realWithdrawalEnabled: false, realWithdrawableMinor: 0 });
  });
});
