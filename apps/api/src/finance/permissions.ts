import type { Actor } from '../auth/auth.js';
import { forbidden } from '../shared/errors.js';

export function realWithdrawalStatus() {
  return { realWithdrawalEnabled: false as const, realWithdrawableMinor: 0 as const,
    blockingReasons: ['NO_TRUSTED_OWN_CASH_EVIDENCE', 'ROOT_STRONG_AUTH_NOT_IMPLEMENTED', 'PAYMENT_CHANNEL_NOT_IMPLEMENTED', 'DISTRIBUTABLE_EARNINGS_NOT_VERIFIED'] };
}

// Reserved execution boundary, deny everyone until a separately reviewed Root/channel design.
export function requireRealWithdrawalApproval(_actor: Actor): never {
  throw forbidden('Real platform withdrawal and salary approval are disabled for every identity, including legacy SUPER_ADMIN');
}

export function unverifiedRiderBalanceView(amountMinor: number, reservedMinor: number) {
  return { amountMinor, reservedMinor, internalUnreservedMinor: Math.max(0, amountMinor - reservedMinor),
    withdrawableMinor: 0, realWithdrawableMinor: 0, realWithdrawalEnabled: false,
    simulated: true, notVerified: true, source: 'DEVELOPMENT_INTERNAL_SETTLEMENT' };
}
