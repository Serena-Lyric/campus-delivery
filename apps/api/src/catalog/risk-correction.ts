import { type Prisma, type PrismaClient, type CatalogRiskReport } from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { transitionOrder } from '../orders/state-machine.js';
import { expireOpenDeliveryTask } from '../orders/lifecycle.js';
import { loadPolicyConfig } from '../merchant-policy/policies.js';
import { pickupRiskSnapshot } from '../delivery/pickup-risk.js';

export type CatalogRiskInput = {
  assignmentId: string;
  orderItemId: string;
  observedCategoryCode: 'CAKE' | 'SUNDAE';
  reason: string;
  evidenceIds?: string[];
};

function reportView(report: CatalogRiskReport) {
  return {
    id: report.id, orderItemId: report.orderItemId,
    observedCategoryCode: report.observedCategoryCode, reason: report.reason,
    correctedAt: report.correctedAt, correctedRevision: report.correctedRevision,
    republishedAt: report.republishedAt, createdAt: report.createdAt,
  };
}

async function lockTask(tx: Prisma.TransactionClient, taskId: string) {
  const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
  if (!identity) throw notFound('Delivery task');
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "DeliveryTask" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
  return tx.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, include: { order: { include: { items: true } } } });
}

export function assertCatalogRefusalState(task: { status: string; pickedUpAt: Date | null; riderId: string | null; order: { status: string } }, assignment: { status: string }, riderId: string) {
  if (task.riderId !== riderId || task.status !== 'CLAIMED' || task.pickedUpAt || task.order.status !== 'CLAIMED' || assignment.status !== 'ACTIVE') throw conflict('CATALOG_REFUSAL_NOT_ALLOWED', 'Refusal is only available to the current rider before actual pickup');
}

export async function reportCatalogRisk(prisma: PrismaClient, actor: Actor, taskId: string, input: CatalogRiskInput, now = new Date()) {
  return prisma.$transaction((tx) => recordCatalogRiskReport(tx, actor, taskId, input, now));
}

// Also used atomically after an authorized no-handoff review. Original rider statement is retained.
export async function recordCatalogRiskReport(tx: Prisma.TransactionClient, actor: Actor, taskId: string, input: CatalogRiskInput, now: Date, performedBy: Actor = actor) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  if (!['CAKE', 'SUNDAE'].includes(input.observedCategoryCode) || !input.reason.trim() || input.reason.length > 500) throw badRequest('INVALID_CATALOG_REPORT', 'Report an explicit core category and reason');
  const evidenceIds = [...new Set(input.evidenceIds ?? [])].sort();
  // Share Order -> Task custody locks. No rider counter or balance is written here.
  const task = await lockTask(tx, taskId);
  const assignment = await tx.deliveryAssignment.findUnique({ where: { id: input.assignmentId } });
  if (!assignment || assignment.taskId !== task.id || assignment.riderId !== actor.riderId) throw forbidden();
  const existing = await tx.catalogRiskReport.findUnique({ where: { assignmentId: assignment.id } });
  if (existing) {
    if (existing.orderItemId !== input.orderItemId || existing.observedCategoryCode !== input.observedCategoryCode || existing.reason !== input.reason || JSON.stringify(existing.evidenceIds) !== JSON.stringify(evidenceIds)) throw conflict('REPORT_IDEMPOTENCY_CONFLICT', 'This assignment already has a different report');
    return { report: reportView(existing), accepted: true };
  }
  assertCatalogRefusalState(task, assignment, actor.riderId!);
  const item = task.order.items.find((candidate) => candidate.id === input.orderItemId);
  if (!item || item.coreFragileSnapshot) throw conflict('CATALOG_REPORT_NOT_MISDECLARED', 'Report a sold item missing its authoritative core-fragile classification');
  if (evidenceIds.length && await tx.evidence.count({ where: { id: { in: evidenceIds }, orderId: task.orderId, actorId: actor.id } }) !== evidenceIds.length) throw badRequest('INVALID_EVIDENCE', 'Report evidence must belong to this order and rider');
  // Claim reserves an assignment, not wallet funds. Never release unrelated settlement balances.
  if (await tx.riderSettlement.count({ where: { orderId: task.orderId } }) || await tx.compensationObligation.count({ where: { orderId: task.orderId } })) throw conflict('PRE_PICKUP_FINANCIAL_STATE_CONFLICT', 'Unexpected settlement facts require review before pre-pickup refusal');
  const report = await tx.catalogRiskReport.create({ data: {
    orderId: task.orderId, assignmentId: assignment.id, orderItemId: item.id,
    observedCategoryCode: input.observedCategoryCode, reason: input.reason, evidenceIds,
    originalRiskSnapshot: {
      categoryCode: item.deliveryCategoryCodeSnapshot, categoryName: item.deliveryCategoryNameSnapshot,
      categoryVersion: item.deliveryCategoryVersionSnapshot, riskTags: item.deliveryRiskTagsSnapshot,
      coreFragile: item.coreFragileSnapshot, reviewRequired: item.deliveryClassificationReviewRequired,
      coreFragileValueMinor: task.order.coreFragileValueMinor, evidenceLevel: task.order.pickupEvidenceLevel,
      policyVersion: task.order.pickupEvidencePolicyVersion, revision: task.order.pickupRiskRevision,
    }, createdAt: now,
  } });
  await tx.deliveryAssignment.update({ where: { id: assignment.id }, data: { status: 'ABANDONED', endedAt: now, reason: 'MERCHANT_CORE_FRAGILE_MISDECLARATION' } });
  await tx.deliveryTask.update({ where: { id: task.id }, data: { status: 'RISK_REVIEW', riderId: null, claimedAt: null } });
  await tx.order.update({ where: { id: task.orderId }, data: { pickupRiskRevision: { increment: 1 } } });
  await transitionOrder(tx, task.orderId, task.order.status, 'READY_FOR_RIDER', performedBy, {
    eventType: 'RIDER_CATALOG_RISK_REPORTED', reason: input.reason,
    metadata: { reportId: report.id, assignmentId: assignment.id, orderItemId: item.id, observedCategoryCode: input.observedCategoryCode, evidenceIds, taskPaused: true, ordinaryCancellationCounted: false, reportingRiderId: actor.riderId!, performedByRole: performedBy.role },
  });
  if (task.claimDeadline && now >= task.claimDeadline) await expireOpenDeliveryTask(tx, task.id, now);
  return { report: reportView(report), accepted: true };
}

export async function getCatalogRiskForMerchant(prisma: PrismaClient, actor: Actor, orderId: string) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  const order = await prisma.order.findFirst({ where: { id: orderId, merchantId: actor.merchantId }, select: {
    id: true, status: true, pickupRiskRevision: true,
    deliveryTask: { select: { status: true, firstPublishedAt: true, claimDeadline: true } },
    catalogRiskReports: { orderBy: { createdAt: 'desc' }, take: 100 },
  } });
  if (!order) throw notFound('Own order');
  return { orderId: order.id, orderStatus: order.status, revision: order.pickupRiskRevision, task: order.deliveryTask, reports: order.catalogRiskReports.map(reportView) };
}

export async function correctCatalogRisk(prisma: PrismaClient, actor: Actor, orderId: string, input: { reportId: string; expectedRevision: number; deliveryCategoryCode: string }, now = new Date()) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  const currentPolicy = await loadPolicyConfig(prisma);
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { orderId }, select: { id: true } });
    if (!identity) throw notFound('Order task');
    const task = await lockTask(tx, identity.id);
    if (task.order.merchantId !== actor.merchantId) throw forbidden();
    const report = await tx.catalogRiskReport.findFirst({ where: { id: input.reportId, orderId } });
    if (!report) throw notFound('Own order report');
    if (task.order.status !== 'READY_FOR_RIDER' || task.status !== 'RISK_REVIEW' || task.riderId || task.order.pickupRiskRevision !== input.expectedRevision) throw conflict('RISK_CORRECTION_STATE_CONFLICT', 'Order is not paused at the expected risk revision');
    if (report.correctedAt || report.republishedAt) throw conflict('RISK_REPORT_ALREADY_CORRECTED', 'This report has already been corrected');
    if (task.claimDeadline && now >= task.claimDeadline) {
      await expireOpenDeliveryTask(tx, task.id, now);
      return { expired: true, reportId: report.id };
    }
    if (input.deliveryCategoryCode !== report.observedCategoryCode) throw conflict('UNCONFIRMED_RISK_CORRECTION', 'Merchant must acknowledge the reported core category or request review through existing exception channels');
    const item = task.order.items.find((candidate) => candidate.id === report.orderItemId);
    if (!item) throw notFound('Reported order item');
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${item.productId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "code" FROM "DeliveryCategory" WHERE "code" = ${input.deliveryCategoryCode} FOR SHARE`;
    const category = await tx.deliveryCategory.findUnique({ where: { code: input.deliveryCategoryCode } });
    if (!category?.coreFragile || !category.selectable) throw conflict('INVALID_CORE_CATEGORY', 'Correction must use a platform-approved core category');
    const productUpdated = await tx.product.updateMany({ where: { id: item.productId, merchantId: actor.merchantId }, data: { deliveryCategoryCode: category.code, version: { increment: 1 } } });
    if (!productUpdated.count) throw notFound('Own product');
    const corrected = await tx.orderItem.update({ where: { id: item.id }, data: {
      deliveryCategoryCodeSnapshot: category.code, deliveryCategoryNameSnapshot: category.name,
      deliveryCategoryVersionSnapshot: category.version, deliveryRiskTagsSnapshot: category.riskTags,
      coreFragileSnapshot: true, deliveryClassificationReviewRequired: false,
    } });
    const items = task.order.items.map((candidate) => candidate.id === item.id ? corrected : candidate);
    // Normal orders retain creation-time thresholds. Legacy unassessed orders adopt an audited current policy on correction.
    const policy = {
      fragilePickupRecommendedMinor: task.order.pickupEvidenceRecommendedMinor ?? currentPolicy.config.fragilePickupRecommendedMinor ?? 1500,
      fragilePickupRequiredMinor: task.order.pickupEvidenceRequiredMinor ?? currentPolicy.config.fragilePickupRequiredMinor ?? 5000,
    };
    const risk = pickupRiskSnapshot(items, policy, task.order.pickupEvidencePolicyVersion || currentPolicy.version);
    const revision = task.order.pickupRiskRevision + 1;
    await tx.order.update({ where: { id: orderId }, data: { ...risk, pickupRiskRevision: revision } });
    const updated = await tx.catalogRiskReport.update({ where: { id: report.id }, data: { correctedAt: now, correctedRevision: revision } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'CATALOG_RISK_CORRECTED', actorType: 'USER', operatorId: actor.id, operatorRole: actor.role, fromStatus: task.order.status, toStatus: task.order.status, metadata: { reportId: report.id, before: report.originalRiskSnapshot as Prisma.InputJsonValue, after: { categoryCode: category.code, categoryVersion: category.version, riskTags: category.riskTags, ...risk, revision }, soldContentsAndMoneyChanged: false } } });
    return {
      report: reportView(updated), revision,
      risk: { coreFragileValueMinor: risk.coreFragileValueMinor, pickupEvidenceLevel: risk.pickupEvidenceLevel, pickupEvidencePolicyVersion: risk.pickupEvidencePolicyVersion },
      requiresExplicitRepublish: true,
    };
  });
}

export async function republishCorrectedOrder(prisma: PrismaClient, actor: Actor, orderId: string, input: { reportId: string; expectedRevision: number }, now = new Date()) {
  if (actor.role !== 'MERCHANT' || !actor.merchantId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { orderId }, select: { id: true } });
    if (!identity) throw notFound('Order task');
    const task = await lockTask(tx, identity.id);
    if (task.order.merchantId !== actor.merchantId) throw forbidden();
    const report = await tx.catalogRiskReport.findFirst({ where: { id: input.reportId, orderId } });
    if (!report) throw notFound('Own order report');
    if (report.republishedAt) {
      if (report.correctedRevision !== input.expectedRevision) throw conflict('RISK_REVISION_CONFLICT', 'Published revision differs');
      return { report: reportView(report), published: true, currentTaskStatus: task.status };
    }
    if (!report.correctedAt || report.correctedRevision !== input.expectedRevision || task.order.pickupRiskRevision !== input.expectedRevision || task.order.status !== 'READY_FOR_RIDER' || task.status !== 'RISK_REVIEW' || task.riderId) throw conflict('RISK_REPUBLISH_NOT_ALLOWED', 'Only the corrected current paused revision may be republished');
    if (!task.firstPublishedAt || !task.claimDeadline) throw conflict('MARKET_WINDOW_MISSING', 'Original market window is required');
    if (now >= task.claimDeadline) {
      await expireOpenDeliveryTask(tx, task.id, now);
      return { expired: true, reportId: report.id };
    }
    await tx.deliveryTask.update({ where: { id: task.id }, data: { status: 'OPEN' } });
    const updated = await tx.catalogRiskReport.update({ where: { id: report.id }, data: { republishedAt: now } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'CATALOG_RISK_REPUBLISHED', actorType: 'USER', operatorId: actor.id, operatorRole: actor.role, fromStatus: task.order.status, toStatus: task.order.status, metadata: { reportId: report.id, revision: input.expectedRevision, firstPublishedAt: task.firstPublishedAt.toISOString(), claimDeadline: task.claimDeadline.toISOString() } } });
    return { report: reportView(updated), published: true, currentTaskStatus: 'OPEN' };
  });
}
