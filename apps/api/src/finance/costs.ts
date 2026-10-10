import type { Prisma, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { badRequest, conflict } from '../shared/errors.js';
import { addMinor, assertMinor, basisPoints } from '../shared/money.js';

export const paymentCostPolicyKey = 'PAYMENT_COST_ESTIMATE';
export const PaymentCostPolicySchema = Type.Object({
  feeBps: Type.Integer({ minimum: 0, maximum: 10000 }),
  fixedFeeMinor: Type.Integer({ minimum: 0, maximum: 2147483647 }),
}, { additionalProperties: false });
export type PaymentCostPolicy = Static<typeof PaymentCostPolicySchema>;

export function validatePaymentCostPolicy(payload: Prisma.JsonValue): PaymentCostPolicy {
  if (!Value.Check(PaymentCostPolicySchema, payload)) throw badRequest('INVALID_BUSINESS_CONFIG', 'Payment cost estimate requires explicit feeBps and fixedFeeMinor; this is not an actual channel fee');
  return payload;
}

export async function loadPaymentCostPolicy(prisma: PrismaClient | Prisma.TransactionClient) {
  const row = await prisma.businessConfig.findFirst({ where: { key: paymentCostPolicyKey, isActive: true }, orderBy: { version: 'desc' } });
  return row ? { version: row.version, config: validatePaymentCostPolicy(row.payload) } : null;
}

export function estimatePaymentCost(paymentBasisMinor: number, policy: { version: number; config: PaymentCostPolicy } | null) {
  assertMinor(paymentBasisMinor);
  if (!policy) return null;
  return {
    status: 'ESTIMATED' as const, fundOwner: 'PLATFORM' as const, payer: 'PLATFORM' as const,
    policyVersion: policy.version, feeBps: policy.config.feeBps, fixedFeeMinor: policy.config.fixedFeeMinor,
    paymentBasisMinor, amountMinor: addMinor(basisPoints(paymentBasisMinor, policy.config.feeBps), policy.config.fixedFeeMinor),
    basis: 'INITIAL_CONTRACT_TOTAL_EXCLUDING_LATER_TIPS' as const,
  };
}

export type CostKind = 'PAYMENT_PROCESSING_FEE' | 'PLATFORM_REFUND_LOSS' | 'OPERATING_EXPENSE';
type CostBase = { kind: CostKind; amountMinor: number; direction: 'EXPENSE' | 'REVERSAL'; orderId: string | null };
export type PlatformCostFact = CostBase & (
  { status: 'ESTIMATED'; sourceKey: string; policyVersion: number }
  | { status: 'EXTERNALLY_VERIFIED'; provider: string; merchantAccountId: string; externalTransactionId: string;
      externalReceipt: string; fundOwner: 'PLATFORM'; verifiedAt: string; verificationSource: 'TRUSTED_CHANNEL_RECONCILIATION' }
);

// Pure reconciliation contract only. No HTTP writer or trusted channel adapter exists.
// Receipt-shaped input alone does not establish trust; the future adapter must authenticate it.
export function reconcilePlatformCosts(facts: readonly PlatformCostFact[]) {
  const seen = new Map<string, string>();
  const totals = {
    ESTIMATED: { PAYMENT_PROCESSING_FEE: 0, PLATFORM_REFUND_LOSS: 0, OPERATING_EXPENSE: 0 },
    EXTERNALLY_VERIFIED: { PAYMENT_PROCESSING_FEE: 0, PLATFORM_REFUND_LOSS: 0, OPERATING_EXPENSE: 0 },
  };
  for (const fact of facts) {
    assertMinor(fact.amountMinor);
    if (!['PAYMENT_PROCESSING_FEE', 'PLATFORM_REFUND_LOSS', 'OPERATING_EXPENSE'].includes(fact.kind)
      || !['EXPENSE', 'REVERSAL'].includes(fact.direction)) throw badRequest('INVALID_COST_FACT', 'Invalid cost kind or direction');
    let key: string;
    if (fact.status === 'ESTIMATED') {
      if (!fact.sourceKey?.trim() || !Number.isSafeInteger(fact.policyVersion) || fact.policyVersion <= 0) throw badRequest('INVALID_COST_FACT', 'Estimate requires a source and policy version');
      key = JSON.stringify([fact.status, fact.sourceKey, fact.kind, fact.direction]);
    } else if (fact.status === 'EXTERNALLY_VERIFIED') {
      if (fact.fundOwner !== 'PLATFORM' || fact.verificationSource !== 'TRUSTED_CHANNEL_RECONCILIATION'
        || !fact.provider?.trim() || !fact.merchantAccountId?.trim() || !fact.externalTransactionId?.trim()
        || !fact.externalReceipt?.trim() || !Number.isFinite(Date.parse(fact.verifiedAt))) throw badRequest('EXTERNAL_EVIDENCE_REQUIRED', 'Actual cost requires trusted platform-owned channel evidence');
      // A transaction cannot be counted twice under another cost kind or direction.
      key = JSON.stringify([fact.status, fact.provider, fact.merchantAccountId, fact.externalTransactionId]);
    } else throw badRequest('INVALID_COST_FACT', 'Estimate and actual verification are separate states');
    const canonical = JSON.stringify([fact.kind, fact.amountMinor, fact.direction, fact.orderId,
      fact.status === 'ESTIMATED' ? fact.policyVersion : [fact.externalReceipt, fact.fundOwner, fact.verifiedAt, fact.verificationSource]]);
    if (seen.has(key)) {
      if (seen.get(key) !== canonical) throw conflict('COST_FACT_CONFLICT', 'The same cost source cannot be silently rewritten');
      continue;
    }
    seen.set(key, canonical);
    const total = totals[fact.status][fact.kind] + (fact.direction === 'EXPENSE' ? fact.amountMinor : -fact.amountMinor);
    if (!Number.isSafeInteger(total)) throw badRequest('MONEY_OVERFLOW', 'Cost projection overflowed');
    totals[fact.status][fact.kind] = total;
  }
  return { totals, uniqueFactCount: seen.size };
}
