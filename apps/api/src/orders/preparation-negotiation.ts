import type { PreparationNegotiationRecord, Prisma, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { badRequest, conflict, forbidden } from '../shared/errors.js';
import { ensurePreparationCase, lockPreparationOrder, preparationUuid } from './preparation-control.js';

const version = Type.Integer({ minimum: 0, maximum: 2147483646 });
const money = Type.Integer({ minimum: 0, maximum: 2147483647 });
const text = Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' });
const base = { expectedVersion: version, requestKey: preparationUuid(), text };
const referencing = { ...base, proposalVersion: Type.Integer({ minimum: 1, maximum: 2147483646 }) };
export const NegotiationStatementBody = Type.Union([
  Type.Object({ ...base, kind: Type.Literal('PROPOSE'), refundMinor: money, wholeOrderUnavailable: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ ...referencing, kind: Type.Literal('CONFIRM'), refundMinor: money }, { additionalProperties: false }),
  Type.Object({ ...referencing, kind: Type.Literal('DISPUTE') }, { additionalProperties: false }),
  Type.Object({ ...referencing, kind: Type.Literal('REFUND_SENT'), refundMinor: money }, { additionalProperties: false }),
  Type.Object({ ...referencing, kind: Type.Literal('REFUND_RECEIVED'), refundMinor: money }, { additionalProperties: false }),
]);
export const NegotiationReviewBody = Type.Object({ expectedVersion: version, expectedCaseVersion: version, expectedPreparationVersion: version,
  requestKey: preparationUuid(), reason: text, outcome: Type.Union([Type.Literal('SIMPLIFIED_WAITING_FOR_FUNDS'), Type.Literal('REGULAR_REVIEW')]) }, { additionalProperties: false });
export type StatementInput = Static<typeof NegotiationStatementBody>;
export type NegotiationReviewInput = Static<typeof NegotiationReviewBody>;

function participant(actor: Actor, order: { customerId: string; merchantId: string; merchant: { ownerId: string } }) {
  if ((actor.role === 'CUSTOMER' && actor.id === order.customerId)
    || (actor.role === 'MERCHANT' && actor.merchantId === order.merchantId && actor.id === order.merchant.ownerId)) return;
  throw forbidden();
}
function ongoingWithoutRider(order: Awaited<ReturnType<typeof lockPreparationOrder>>) {
  if (!['CREATED', 'MERCHANT_PENDING', 'MERCHANT_CONFIRMED', 'READY_FOR_RIDER'].includes(order.status)
    || order.deliveryTask?.riderId || order.deliveryTask?.assignments.length || order.deliveryTask?.pickedUpAt
    || order.preparationControlState === 'NORMAL') throw conflict('NEGOTIATION_NOT_AVAILABLE', 'Only a paused, unclaimed, unfinished whole-order preparation exception may use this record flow');
}
function recordView(record: PreparationNegotiationRecord) {
  return { id: record.id, version: record.version, kind: record.kind, party: record.actorRole, proposalVersion: record.proposalVersion,
    reportedRefundMinor: record.refundMinor, text: record.text, reviewOutcome: record.reviewOutcome, createdAt: record.createdAt,
    selfReported: record.actorRole !== 'ADMIN', trustedExternalPaymentFact: false };
}
function agreementFacts(records: PreparationNegotiationRecord[]) {
  const latest = [...records].reverse();
  const proposal = latest.find((r) => r.kind === 'PROPOSE');
  const latestFor = (party: string) => latest.find((r) => r.actorRole === party && r.proposalVersion === proposal?.version && ['CONFIRM', 'DISPUTE'].includes(r.kind));
  const merchant = latestFor('MERCHANT'); const customer = latestFor('CUSTOMER');
  const established = Boolean(proposal && merchant?.kind === 'CONFIRM' && customer?.kind === 'CONFIRM'
    && merchant.refundMinor === proposal.refundMinor && customer.refundMinor === proposal.refundMinor);
  return { proposal, established };
}
async function present(tx: Prisma.TransactionClient, order: Awaited<ReturnType<typeof lockPreparationOrder>>) {
  const records = await tx.preparationNegotiationRecord.findMany({ where: { orderId: order.id }, orderBy: { version: 'asc' } });
  const lastReview = [...records].reverse().find((r) => r.kind === 'REVIEW');
  let reviewCurrent = false;
  if (lastReview && lastReview.version === order.preparationNegotiationVersion && order.preparationSourceExceptionId) {
    const expected = JSON.parse(lastReview.payloadSignature) as { expectedPreparationVersion: number; expectedCaseVersion: number };
    const linked = await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.preparationSourceExceptionId } });
    reviewCurrent = order.preparationControlVersion === expected.expectedPreparationVersion && linked?.version === expected.expectedCaseVersion + 1
      && linked.status === 'WAITING_FOR_PARTICIPANT' && linked.currentHandlerAdminId === lastReview.actorId;
    if (reviewCurrent && lastReview.reviewOutcome === 'SIMPLIFIED_WAITING_FOR_FUNDS') {
      reviewCurrent = !await tx.exceptionCase.count({ where: { orderId: order.id, id: { not: linked!.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } } });
    }
  }
  return { version: order.preparationNegotiationVersion, preparationVersion: order.preparationControlVersion, agreementEstablished: agreementFacts(records).established,
    reviewRoute: lastReview ? reviewCurrent ? lastReview.reviewOutcome : 'REVIEW_STALE' : 'UNREVIEWED', reviewCurrent,
    agreementStatements: records.filter((r) => ['PROPOSE', 'CONFIRM', 'DISPUTE'].includes(r.kind)).map(recordView),
    refundProgress: records.filter((r) => ['REFUND_SENT', 'REFUND_RECEIVED'].includes(r.kind)).map(recordView),
    reviewHistory: records.filter((r) => r.kind === 'REVIEW').map(recordView),
    refundBusinessApproved: false, refundInitiated: false, trustedExternalRefundConfirmed: false, formalTerminationAvailable: false,
    fundsStatus: 'NO_TRUSTED_EXTERNAL_REFUND_ADAPTER', terminationBlockedReason: 'Trusted payment/refund facts and a safe separated termination workflow are unavailable',
  };
}
async function replay(tx: Prisma.TransactionClient, actor: Actor, orderId: string, requestKey: string, signature: string) {
  const previous = await tx.preparationNegotiationRecord.findUnique({ where: { orderId_requestKey: { orderId, requestKey } } });
  if (previous && (previous.actorId !== actor.id || previous.payloadSignature !== signature)) throw conflict('NEGOTIATION_RETRY_CONFLICT', 'Request key belongs to a different statement/action');
  return previous;
}

export async function recordNegotiationStatement(prisma: PrismaClient, actor: Actor, orderId: string, input: StatementInput) {
  if (!Value.Check(NegotiationStatementBody, input)) throw badRequest('INVALID_NEGOTIATION_STATEMENT', 'Invalid statement fields');
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId); participant(actor, order); ongoingWithoutRider(order);
    if (input.kind === 'REFUND_SENT' && actor.role !== 'MERCHANT') throw forbidden();
    if (input.kind === 'REFUND_RECEIVED' && actor.role !== 'CUSTOMER') throw forbidden();
    const signature = JSON.stringify({ action: input.kind, expectedVersion: input.expectedVersion, text: input.text,
      proposalVersion: 'proposalVersion' in input ? input.proposalVersion : null, refundMinor: 'refundMinor' in input ? input.refundMinor : null });
    if (await replay(tx, actor, orderId, input.requestKey, signature)) return present(tx, order);
    if (order.preparationNegotiationVersion !== input.expectedVersion) throw conflict('NEGOTIATION_VERSION_CONFLICT', 'Refresh the participant statement version');
    const latestMerchant = await tx.preparationControlAudit.findFirst({ where: { orderId, action: { in: ['DECLARE_UNABLE', 'REQUEST_RECOVERY'] } }, orderBy: { version: 'desc' } });
    if (input.kind === 'PROPOSE' && latestMerchant?.action !== 'DECLARE_UNABLE') throw conflict('WHOLE_PREPARATION_STATEMENT_REQUIRED', 'A current merchant inability statement is required; recovery conflicts need ordinary review');
    if (input.kind !== 'PROPOSE') {
      const proposal = await tx.preparationNegotiationRecord.findFirst({ where: { orderId, kind: 'PROPOSE' }, orderBy: { version: 'desc' } });
      if (!proposal || proposal.version !== input.proposalVersion) throw conflict('NEGOTIATION_PROPOSAL_CHANGED', 'Statements must refer to the current proposal');
    }
    const linked = await ensurePreparationCase(tx, order);
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const current = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (current.category !== 'MERCHANT_PREPARATION_UNAVAILABLE' || ['RESOLVED', 'CLOSED'].includes(current.status)) throw conflict('NEGOTIATION_CASE_CHANGED', 'An active preparation case is required; terminal cases cannot be reopened');
    const now = new Date();
    await tx.preparationNegotiationRecord.create({ data: { orderId, version: input.expectedVersion + 1, kind: input.kind, actorId: actor.id, actorRole: actor.role,
      proposalVersion: 'proposalVersion' in input ? input.proposalVersion : null, refundMinor: 'refundMinor' in input ? input.refundMinor : null,
      text: input.text, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    await tx.order.update({ where: { id: orderId }, data: { preparationNegotiationVersion: { increment: 1 },
      ...(order.preparationControlState !== 'MANUAL_REVIEW' ? { preparationControlState: 'MANUAL_REVIEW', preparationControlVersion: { increment: 1 }, preparationControlUpdatedAt: now } : {}),
    } });
    if (order.preparationControlState !== 'MANUAL_REVIEW') await tx.preparationControlAudit.create({ data: { orderId, version: order.preparationControlVersion + 1,
      action: 'NEGOTIATION_REVIEW_PAUSED', previousState: order.preparationControlState, newState: 'MANUAL_REVIEW', actorId: actor.id, payloadSignature: input.requestKey, createdAt: now } });
    await tx.exceptionCaseAction.create({ data: { caseId: current.id, type: 'REQUESTED_INFORMATION', actorId: actor.id, reason: input.text,
      metadata: { action: 'PREPARATION_NEGOTIATION_STATEMENT', kind: input.kind, recordVersion: input.expectedVersion + 1, trustedPaymentFact: false } } });
    return present(tx, await lockPreparationOrder(tx, orderId));
  });
}

export async function getPreparationNegotiation(prisma: PrismaClient, actor: Actor, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    if (!(actor.role === 'ADMIN' && actor.adminLevel === 'SUPER_ADMIN')) participant(actor, order);
    return present(tx, order);
  });
}

export async function reviewPreparationNegotiation(prisma: PrismaClient, actor: Actor, orderId: string, input: NegotiationReviewInput) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']);
  if (!Value.Check(NegotiationReviewBody, input)) throw badRequest('INVALID_NEGOTIATION_REVIEW', 'Invalid review fields');
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId); ongoingWithoutRider(order);
    const linked = await ensurePreparationCase(tx, order);
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const current = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (current.currentHandlerAdminId !== actor.id) throw forbidden();
    const signature = JSON.stringify({ action: 'REVIEW', expectedVersion: input.expectedVersion, expectedCaseVersion: input.expectedCaseVersion,
      expectedPreparationVersion: input.expectedPreparationVersion, outcome: input.outcome, reason: input.reason });
    const previous = await replay(tx, actor, orderId, input.requestKey, signature);
    if (previous) {
      if (order.preparationNegotiationVersion !== previous.version || order.preparationControlVersion !== input.expectedPreparationVersion
        || current.version !== input.expectedCaseVersion + 1 || current.status !== 'WAITING_FOR_PARTICIPANT') throw conflict('NEGOTIATION_REVIEW_RETRY_CHANGED', 'Workflow changed after review');
      return present(tx, order);
    }
    assertExceptionCaseAction(current.status, 'RESOLVE');
    if (current.category !== 'MERCHANT_PREPARATION_UNAVAILABLE' || current.version !== input.expectedCaseVersion
      || order.preparationNegotiationVersion !== input.expectedVersion || order.preparationControlVersion !== input.expectedPreparationVersion) throw conflict('NEGOTIATION_REVIEW_VERSION_CONFLICT', 'Case or participant facts changed');
    if (order.preparationNegotiationVersion === 0) throw conflict('NEGOTIATION_STATEMENTS_REQUIRED', 'Record participant negotiation facts before using this review; ordinary preparation cases keep their original workflow');
    if (input.outcome === 'SIMPLIFIED_WAITING_FOR_FUNDS') {
      const records = await tx.preparationNegotiationRecord.findMany({ where: { orderId }, orderBy: { version: 'asc' } });
      const facts = agreementFacts(records);
      const pricing = await tx.orderPricing.findUniqueOrThrow({ where: { orderId } });
      const total = pricing.itemSubtotalMinor + pricing.customerDeliveryFeeMinor + pricing.customerRiderTipMinor;
      const latestMerchant = await tx.preparationControlAudit.findFirst({ where: { orderId, action: { in: ['DECLARE_UNABLE', 'REQUEST_RECOVERY'] } }, orderBy: { version: 'desc' } });
      if (!facts.established || facts.proposal?.refundMinor !== total || latestMerchant?.action !== 'DECLARE_UNABLE'
        || records.some((r) => ['REFUND_SENT', 'REFUND_RECEIVED'].includes(r.kind) && r.proposalVersion === facts.proposal?.version && r.refundMinor !== total)
        || await tx.deliveryAssignment.count({ where: { orderId } })
        || await tx.exceptionCase.count({ where: { orderId, id: { not: current.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } } })) throw conflict('SIMPLIFIED_NEGOTIATION_UNSAFE', 'Disagreement, amounts, rider history or unresolved conflicts require ordinary review');
    }
    const now = new Date();
    const updated = await tx.exceptionCase.updateMany({ where: { id: current.id, version: input.expectedCaseVersion, currentHandlerAdminId: actor.id, status: current.status }, data: {
      version: { increment: 1 }, status: 'WAITING_FOR_PARTICIPANT', lastActionAt: now, resolutionType: 'WAITING_FOR_INFORMATION', resolutionNote: input.reason,
    } });
    if (updated.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Case or handler changed');
    await tx.order.update({ where: { id: orderId }, data: { preparationNegotiationVersion: { increment: 1 } } });
    await tx.preparationNegotiationRecord.create({ data: { orderId, version: input.expectedVersion + 1, kind: 'REVIEW', actorId: actor.id, actorRole: actor.role,
      text: input.reason, reviewOutcome: input.outcome, requestKey: input.requestKey, payloadSignature: signature, createdAt: now } });
    await tx.exceptionCaseAction.create({ data: { caseId: current.id, type: 'REQUESTED_INFORMATION', actorId: actor.id, reason: input.reason,
      metadata: { action: 'NEGOTIATION_HUMAN_REVIEW', route: input.outcome, refundBusinessApproved: false, refundInitiated: false, trustedExternalRefundConfirmed: false, orderTerminated: false, moneyChanged: false } } });
    return present(tx, await lockPreparationOrder(tx, orderId));
  });
}
