import { describe, expect, it } from 'vitest';
import { estimatePaymentCost, reconcilePlatformCosts, validatePaymentCostPolicy, type PlatformCostFact } from '../src/finance/costs.js';

describe('platform payment costs and isolated reconciliation contract', () => {
  it('requires explicit estimate policy, uses integer fees and never turns estimates into verified costs', () => {
    expect(estimatePaymentCost(2000, null)).toBeNull();
    expect(() => validatePaymentCostPolicy({ feeBps: 10001, fixedFeeMinor: 0 })).toThrow();
    expect(() => validatePaymentCostPolicy({ feeBps: 60 })).toThrow();
    expect(() => validatePaymentCostPolicy({ feeBps: 60, fixedFeeMinor: 0, actualFeeMinor: 12 })).toThrow();
    const estimate = estimatePaymentCost(1999, { version: 2, config: { feeBps: 60, fixedFeeMinor: 1 } });
    expect(estimate).toMatchObject({ status: 'ESTIMATED', amountMinor: 12, payer: 'PLATFORM', policyVersion: 2 });
    expect(() => estimatePaymentCost(Number.MAX_SAFE_INTEGER, { version: 2, config: { feeBps: 10000, fixedFeeMinor: 1 } })).toThrow(/overflow/);
    const fact: PlatformCostFact = { status: 'ESTIMATED', kind: 'PAYMENT_PROCESSING_FEE', amountMinor: 12, sourceKey: 'order-contract:1', orderId: 'order1', policyVersion: 2, direction: 'EXPENSE' };
    expect(reconcilePlatformCosts([fact, fact])).toMatchObject({ uniqueFactCount: 1, totals: { ESTIMATED: { PAYMENT_PROCESSING_FEE: 12 }, EXTERNALLY_VERIFIED: { PAYMENT_PROCESSING_FEE: 0 } } });
    expect(() => reconcilePlatformCosts([fact, { ...fact, amountMinor: 13 }])).toThrow(/silently rewritten/);
  });

  const external: PlatformCostFact = { status: 'EXTERNALLY_VERIFIED', kind: 'PAYMENT_PROCESSING_FEE', amountMinor: 10, direction: 'EXPENSE', orderId: 'order1',
    provider: 'ISOLATED_TEST_PROVIDER', merchantAccountId: 'PLATFORM_FIXTURE_ACCOUNT', externalTransactionId: 'fee1', externalReceipt: 'ISOLATED_FIXTURE_ONLY', fundOwner: 'PLATFORM', verifiedAt: '2026-10-11T00:00:00Z', verificationSource: 'TRUSTED_CHANNEL_RECONCILIATION' };

  it('deduplicates external transactions, separates accounts and tracks refund fee adjustments and other costs independently', () => {
    const result = reconcilePlatformCosts([external, external,
      { ...external, externalTransactionId: 'refund-adjustment1', amountMinor: 2, direction: 'REVERSAL' },
      { ...external, externalTransactionId: 'loss1', amountMinor: 50, kind: 'PLATFORM_REFUND_LOSS' },
      { ...external, externalTransactionId: 'ops1', amountMinor: 20, kind: 'OPERATING_EXPENSE' },
      { ...external, merchantAccountId: 'SECOND_PLATFORM_FIXTURE_ACCOUNT' },
    ]);
    expect(result).toMatchObject({ uniqueFactCount: 5, totals: { EXTERNALLY_VERIFIED: { PAYMENT_PROCESSING_FEE: 18, PLATFORM_REFUND_LOSS: 50, OPERATING_EXPENSE: 20 } } });
    expect(() => reconcilePlatformCosts([external, { ...external, kind: 'OPERATING_EXPENSE' }])).toThrow(/silently rewritten/);
    expect(() => reconcilePlatformCosts([external, { ...external, direction: 'REVERSAL' }])).toThrow(/silently rewritten/);
  });

  it('rejects missing receipt, untrusted evidence, third-party ownership and fractional or negative costs', () => {
    expect(() => reconcilePlatformCosts([{ ...external, externalReceipt: '' }])).toThrow(/evidence/);
    expect(() => reconcilePlatformCosts([{ ...external, verifiedAt: 'invalid' }])).toThrow(/evidence/);
    expect(() => reconcilePlatformCosts([{ ...external, amountMinor: -1 }])).toThrow();
    expect(() => reconcilePlatformCosts([{ ...external, amountMinor: 0.5 }])).toThrow();
    // Malformed upstream input at the future trust boundary, not a public write API.
    expect(() => reconcilePlatformCosts([JSON.parse(JSON.stringify({ ...external, fundOwner: 'MERCHANT' }))])).toThrow(/evidence/);
    expect(() => reconcilePlatformCosts([JSON.parse(JSON.stringify({ ...external, verificationSource: 'ADMIN_ENTERED' }))])).toThrow(/evidence/);
    expect(() => reconcilePlatformCosts([JSON.parse(JSON.stringify({ ...external, status: 'PAID' }))])).toThrow();
  });
});
