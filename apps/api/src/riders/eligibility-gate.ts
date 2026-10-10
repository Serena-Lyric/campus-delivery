import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, badRequest } from '../shared/errors.js';
import { qualificationSnapshot } from './eligibility-policy.js';

export const eligibilityPolicyKey = 'RIDER_ELIGIBILITY_POLICY';
export const eligibilityPolicyLock = 17201011;

export function validateEligibilityPolicy(payload: Prisma.JsonValue) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || typeof payload.enforced !== 'boolean') {
    throw badRequest('INVALID_ELIGIBILITY_POLICY', 'Qualification policy requires exactly { enforced: boolean }');
  }
  return { enforced: payload.enforced };
}

export async function loadEligibilityGate(db: PrismaClient | Prisma.TransactionClient) {
  const row = await db.businessConfig.findFirst({ where: { key: eligibilityPolicyKey, isActive: true }, orderBy: { version: 'desc' } });
  // Explicit unconfigured transition; never represents verified student status.
  return row ? { ...validateEligibilityPolicy(row.payload), version: row.version } : { enforced: false, version: 0 };
}

export async function assertQualificationCanClaim(tx: Prisma.TransactionClient, riderId: string, now: Date) {
  const gate = await loadEligibilityGate(tx);
  if (!gate.enforced) return;
  const snapshot = await qualificationSnapshot(tx, riderId, now);
  if (snapshot.state !== 'VALID') {
    throw new AppError(409, 'RIDER_QUALIFICATION_REQUIRED', 'A current administrator-verified student qualification is required', {
      state: snapshot.state, policyVersion: gate.version, evaluatedAt: now.toISOString(), termId: snapshot.term?.id ?? null,
      nextAction: snapshot.state === 'GRADUATED' ? 'EXCEPTION_STANDARDS_PENDING' : snapshot.state === 'UNDER_REVIEW' ? 'AWAIT_ADMIN_REVIEW' : 'CHECK_ELIGIBILITY_AND_RENEWAL_WINDOW',
    });
  }
}
