import type { PrismaClient } from '@prisma/client';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { notFound } from '../shared/errors.js';
import { pricingConfigLock } from '../pricing/config.js';
import { loadReservePolicy, previewOperatingBudget, type BudgetScenario } from './reserve.js';
import { realWithdrawalStatus } from './permissions.js';

export async function getOrderFinanceProjection(prisma: PrismaClient, actor: Actor, orderId: string) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: {
    id: true, status: true,
    pricing: { select: { platformCommissionMinor: true, customerDeliveryFeeMinor: true, riderBasePayoutMinor: true,
      platformSubsidyMinor: true, merchantSettlementMinor: true, customerRefundMinor: true, pricingInputsSnapshot: true } },
    settlement: { select: { status: true, merchantPayableMinor: true, riderPayableMinor: true, platformRevenueMinor: true } },
  } });
  if (!order?.pricing || !order.settlement) throw notFound('Order finance projection');
  const p = order.pricing;
  const snapshot = p.pricingInputsSnapshot as Record<string, unknown> | null;
  const estimate = snapshot?.paymentCostEstimate as { status: string; amountMinor: number; policyVersion: number; paymentBasisMinor: number } | null | undefined;
  const estimatedFeeMinor = estimate?.status === 'ESTIMATED' && Number.isSafeInteger(estimate.amountMinor) && estimate.amountMinor >= 0 ? estimate.amountMinor : null;
  const merchandiseCommissionMinor = p.platformCommissionMinor;
  const baseDeliverySpreadMinor = p.customerDeliveryFeeMinor - p.riderBasePayoutMinor;
  const contractContributionMinor = merchandiseCommissionMinor + baseDeliverySpreadMinor - p.platformSubsidyMinor;
  const finalized = order.status === 'DELIVERED' && order.settlement.status === 'FINALIZED';
  return {
    orderId: order.id, orderStatus: order.status, settlementStatus: order.settlement.status,
    simulated: true, notVerified: true, ...realWithdrawalStatus(),
    source: 'DEVELOPMENT_ORDER_SNAPSHOTS',
    operating: { merchandiseCommissionMinor, baseDeliverySpreadMinor, platformSubsidyMinor: p.platformSubsidyMinor,
      contractContributionMinor, finalizedOperatingContributionMinor: finalized ? order.settlement.platformRevenueMinor : 0,
      estimatedNetContributionMinor: finalized && estimatedFeeMinor !== null ? order.settlement.platformRevenueMinor - estimatedFeeMinor : null },
    paymentCosts: { payer: 'PLATFORM', estimatedFeeMinor, estimatePolicyVersion: estimate?.policyVersion ?? null,
      estimatePaymentBasisMinor: estimate?.paymentBasisMinor ?? null, actualFeeMinor: null, actualStatus: 'NOT_VERIFIED', externalReceipt: null,
      laterTipAndRefundFeeAdjustments: 'NOT_IMPLEMENTED' },
    otherPlatformCosts: { externallyVerifiedRefundLossMinor: null, externallyVerifiedOperatingExpenseMinor: null },
    thirdPartyRights: { merchantContractPayableMinor: p.merchantSettlementMinor, finalizedMerchantPayableMinor: order.settlement.merchantPayableMinor,
      finalizedRiderPayableMinor: order.settlement.riderPayableMinor, customerRefundObligationMinor: p.customerRefundMinor,
      includedInPlatformIncome: false, note: 'Separate rights, not verified channel payments or available cash' },
  };
}

export async function getOperatingBudgetPreview(prisma: PrismaClient, actor: Actor, scenario: BudgetScenario) {
  requireAdminLevel(actor, ['SUPER_ADMIN']);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${pricingConfigLock})`;
    const policy = await loadReservePolicy(tx);
    return {
      ...previewOperatingBudget(scenario, policy), simulated: true, notVerified: true, ...realWithdrawalStatus(),
      source: 'CLIENT_SUPPLIED_HYPOTHETICAL_SCENARIO',
      automaticForecastFromRealOrders: false, externallyVerifiedOwnCashMinor: null,
      note: '模拟预算，未核实；不构成工资批准、资金预留、可提现余额或真实支付。',
    };
  });
}
