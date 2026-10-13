import type { Order, Prisma, PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { requireAdminLevel, type Actor } from '../auth/auth.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { openExceptionCase } from '../exception-cases/service.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { lockPreparationOrder, preparationUuid } from './preparation-control.js';

const version = Type.Integer({ minimum: 0, maximum: 2147483646 });
const text = Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' });
const base = { expectedVersion: version, requestKey: preparationUuid() };
export const ChangeNoticeBody = Type.Object({ ...base, content: text, riskDeclaration: Type.Union([
  Type.Literal('NO_ADDITIONAL_CORE_FRAGILE'), Type.Literal('ADDITIONAL_CORE_FRAGILE'), Type.Literal('UNASSESSED'),
]) }, { additionalProperties: false });
export const GoodsObjectionBody = Type.Object({ ...base, type: Type.Literal('GOODS_CHANGE_OBJECTION'), assignmentId: preparationUuid(),
  noticeId: Type.Optional(preparationUuid()), description: text, evidenceIds: Type.Optional(Type.Array(preparationUuid(), { maxItems: 20, uniqueItems: true })) }, { additionalProperties: false });
export const GoodsReviewBody = Type.Object({ ...base, expectedCaseVersion: version, reason: text,
  outcome: Type.Union([Type.Literal('NO_ADDITIONAL_CORE_RISK_CONFIRMED'), Type.Literal('HOLD_UNRESOLVED_RISK')]) }, { additionalProperties: false });
export type NoticeInput = Static<typeof ChangeNoticeBody>;
export type ObjectionInput = Static<typeof GoodsObjectionBody>;
export type GoodsReviewInput = Static<typeof GoodsReviewBody>;

export const changeNoticeSelect = { id: true, version: true, merchantId: true, merchantNameSnapshot: true, content: true,
  riskDeclaration: true, createdAt: true, acknowledgements: { select: { assignmentId: true, createdAt: true } } } satisfies Prisma.OrderChangeNoticeSelect;
type Notice = Prisma.OrderChangeNoticeGetPayload<{ select: typeof changeNoticeSelect }>;
export function changeNoticeView(notice: Notice, assignmentId?: string) {
  return { id: notice.id, version: notice.version, merchantId: notice.merchantId, merchantName: notice.merchantNameSnapshot,
    content: notice.content, riskDeclaration: notice.riskDeclaration, createdAt: notice.createdAt, selfReported: true,
    acknowledgedAt: assignmentId ? notice.acknowledgements.find((a) => a.assignmentId === assignmentId)?.createdAt ?? null : null };
}
export function goodsChangeView(order: Pick<Order, 'goodsChangeVersion' | 'goodsChangeReviewPending'>) {
  return { version: order.goodsChangeVersion, reviewPending: order.goodsChangeReviewPending,
    statusLabel: order.goodsChangeReviewPending ? '商品变更风险待人工核查，暂停交接与业务推进' : '原取餐规则仍适用，声明不代表平台核实',
    substitutionApproved: false, originalRiskSnapshotChanged: false };
}

function validate(schema: Parameters<typeof Value.Check>[0], input: unknown) {
  if (!Value.Check(schema, input)) throw badRequest('INVALID_GOODS_CHANGE_ACTION', 'Invalid goods-change action fields');
}
function prehandoff(order: { status: string; deliveryTask: { pickedUpAt: Date | null } | null }) {
  if (!['MERCHANT_CONFIRMED', 'READY_FOR_RIDER', 'CLAIMED'].includes(order.status) || order.deliveryTask?.pickedUpAt) throw conflict('CHANGE_NOTICE_STAGE_CONFLICT', 'Merchant notices must precede pickup or termination');
}
async function priorAction(tx: Prisma.TransactionClient, orderId: string, actor: Actor, requestKey: string, signature: string) {
  const previous = await tx.goodsChangeAction.findUnique({ where: { orderId_requestKey: { orderId, requestKey } } });
  if (previous && (previous.actorId !== actor.id || previous.payloadSignature !== signature)) throw conflict('GOODS_CHANGE_RETRY_CONFLICT', 'Request key belongs to a different action');
  return previous;
}
async function pauseForGoodsReview(tx: Prisma.TransactionClient, order: Order, actor: Actor, description: string, evidenceIds: string[] = [], forceNew = false) {
  const existing = order.goodsChangeSourceExceptionId ? await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.goodsChangeSourceExceptionId } }) : null;
  if (!forceNew && existing && !['RESOLVED', 'CLOSED'].includes(existing.status)) return order.goodsChangeSourceExceptionId!;
  const event = await tx.exceptionEvent.create({ data: { orderId: order.id, reporterId: actor.id, reporterRole: actor.role, orderStatus: order.status,
    type: 'GOODS_CHANGE_OBJECTION', description, evidences: { connect: evidenceIds.map((id) => ({ id })) } } });
  await openExceptionCase(tx, event);
  return event.id;
}

export async function appendChangeNotice(prisma: PrismaClient, actor: Actor, orderId: string, input: NoticeInput) {
  validate(ChangeNoticeBody, input);
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    if (actor.role !== 'MERCHANT' || actor.merchantId !== order.merchantId || actor.id !== order.merchant.ownerId) throw forbidden();
    prehandoff(order);
    const signature = JSON.stringify({ action: 'NOTICE', expectedVersion: input.expectedVersion, content: input.content, riskDeclaration: input.riskDeclaration });
    const previous = await priorAction(tx, orderId, actor, input.requestKey, signature);
    if (previous?.noticeId) return changeNoticeView(await tx.orderChangeNotice.findUniqueOrThrow({ where: { id: previous.noticeId }, select: changeNoticeSelect }));
    if (order.goodsChangeVersion !== input.expectedVersion) throw conflict('GOODS_CHANGE_VERSION_CONFLICT', 'Refresh the goods-change version');
    const unsafe = input.riskDeclaration !== 'NO_ADDITIONAL_CORE_FRAGILE';
    const source = unsafe ? await pauseForGoodsReview(tx, order, actor, input.content) : order.goodsChangeSourceExceptionId;
    const notice = await tx.orderChangeNotice.create({ data: { orderId, version: input.expectedVersion + 1, merchantId: order.merchantId,
      merchantNameSnapshot: order.pickupMerchantNameSnapshot, content: input.content, riskDeclaration: input.riskDeclaration }, select: changeNoticeSelect });
    await tx.order.update({ where: { id: orderId }, data: { goodsChangeVersion: { increment: 1 }, goodsChangeReviewPending: unsafe || order.goodsChangeReviewPending, goodsChangeSourceExceptionId: source } });
    await tx.goodsChangeAction.create({ data: { orderId, version: input.expectedVersion + 1, action: 'NOTICE', actorId: actor.id, requestKey: input.requestKey, payloadSignature: signature, noticeId: notice.id } });
    await tx.orderEvent.create({ data: { orderId, eventType: 'EXCEPTION_RECORDED', actorType: 'USER', operatorId: actor.id, operatorRole: actor.role,
      fromStatus: order.status, toStatus: order.status, metadata: { action: 'CHANGE_NOTICE', noticeId: notice.id, riskDeclaration: input.riskDeclaration, fundsChanged: false, substitutionApproved: false } } });
    return changeNoticeView(notice);
  });
}

export async function getChangeNotices(prisma: PrismaClient, actor: Actor, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    const assignment = order.deliveryTask?.assignments.find((a) => a.riderId === actor.riderId && a.rider.userId === actor.id && order.deliveryTask?.riderId === actor.riderId);
    const allowed = (actor.role === 'CUSTOMER' && actor.id === order.customerId)
      || (actor.role === 'MERCHANT' && actor.id === order.merchant.ownerId && actor.merchantId === order.merchantId)
      || (actor.role === 'RIDER' && assignment) || (actor.role === 'ADMIN' && actor.adminLevel === 'SUPER_ADMIN');
    if (!allowed) throw forbidden();
    const notices = await tx.orderChangeNotice.findMany({ where: { orderId }, orderBy: { version: 'asc' }, select: changeNoticeSelect });
    return { ...goodsChangeView(order), notices: notices.map((n) => changeNoticeView(n, actor.role === 'RIDER' ? assignment?.id : undefined)) };
  });
}

export async function acknowledgeChangeNotice(prisma: PrismaClient, actor: Actor, taskId: string, noticeId: string, assignmentId: string) {
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const identity = await tx.deliveryTask.findUnique({ where: { id: taskId }, select: { orderId: true } });
    if (!identity) throw notFound('Task');
    const order = await lockPreparationOrder(tx, identity.orderId);
    const assignment = order.deliveryTask?.assignments.find((a) => a.id === assignmentId && a.riderId === actor.riderId && a.rider.userId === actor.id);
    if (!assignment || order.deliveryTask?.riderId !== actor.riderId) throw forbidden();
    if (!['CLAIMED', 'PICKED_UP'].includes(order.status)) throw conflict('ACKNOWLEDGEMENT_STAGE_CONFLICT', 'Only the current ongoing assignment may acknowledge');
    const notice = await tx.orderChangeNotice.findFirst({ where: { id: noticeId, orderId: order.id } });
    if (!notice) throw notFound('Own order notice');
    const recorded = await tx.orderChangeAcknowledgement.upsert({ where: { noticeId_assignmentId: { noticeId, assignmentId } }, create: { noticeId, assignmentId }, update: {} });
    return { noticeId, noticeVersion: notice.version, assignmentId, acknowledgedAt: recorded.createdAt, acceptsSubstitution: false, waivesProtection: false };
  });
}

export async function reportGoodsObjection(prisma: PrismaClient, actor: Actor, orderId: string, input: ObjectionInput) {
  validate(GoodsObjectionBody, input);
  if (actor.role !== 'RIDER' || !actor.riderId) throw forbidden();
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    const assignment = order.deliveryTask?.assignments.find((a) => a.id === input.assignmentId && a.riderId === actor.riderId && a.rider.userId === actor.id);
    if (!assignment || order.deliveryTask?.riderId !== actor.riderId) throw forbidden();
    if (!['CLAIMED', 'PICKED_UP'].includes(order.status)) throw conflict('GOODS_REPORT_STAGE_CONFLICT', 'Report while holding a legitimate ongoing assignment');
    const signature = JSON.stringify({ action: 'OBJECTION', expectedVersion: input.expectedVersion, assignmentId: input.assignmentId,
      noticeId: input.noticeId ?? null, description: input.description, evidenceIds: [...(input.evidenceIds ?? [])].sort() });
    const previous = await priorAction(tx, orderId, actor, input.requestKey, signature);
    if (previous) return goodsChangeView(order);
    if (order.goodsChangeVersion !== input.expectedVersion) throw conflict('GOODS_CHANGE_VERSION_CONFLICT', 'Refresh the goods-change version');
    if (input.noticeId && !await tx.orderChangeNotice.findFirst({ where: { id: input.noticeId, orderId } })) throw badRequest('INVALID_NOTICE', 'Notice must belong to this order');
    const evidenceIds = input.evidenceIds ?? [];
    const evidences = await tx.evidence.findMany({ where: { id: { in: evidenceIds }, orderId, actorId: actor.id }, select: { id: true, exceptionEventId: true } });
    if (evidences.length !== evidenceIds.length) throw badRequest('INVALID_EVIDENCE', 'Evidence must belong to this order and reporting rider');
    // Every objection records its actual rider statement, even if an earlier merchant declaration already opened a case.
    const event = await tx.exceptionEvent.create({ data: { orderId, reporterId: actor.id, reporterRole: actor.role, orderStatus: order.status,
      type: 'GOODS_CHANGE_OBJECTION', description: input.description, evidences: { connect: evidences.filter((e) => !e.exceptionEventId).map((e) => ({ id: e.id })) } } });
    const existing = order.goodsChangeSourceExceptionId ? await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.goodsChangeSourceExceptionId } }) : null;
    const source = existing && !['RESOLVED', 'CLOSED'].includes(existing.status) ? order.goodsChangeSourceExceptionId! : event.id;
    const linked = source === event.id ? await openExceptionCase(tx, event) : existing!;
    await tx.exceptionCaseAction.create({ data: { caseId: linked.id, type: 'REQUESTED_INFORMATION', actorId: actor.id, reason: input.description,
      metadata: { action: 'GOODS_CHANGE_OBJECTION', exceptionEventId: event.id, assignmentId: assignment.id, noticeId: input.noticeId ?? null, evidenceIds } } });
    const updated = await tx.order.update({ where: { id: orderId }, data: { goodsChangeVersion: { increment: 1 }, goodsChangeReviewPending: true, goodsChangeSourceExceptionId: source } });
    await tx.goodsChangeAction.create({ data: { orderId, version: updated.goodsChangeVersion, action: 'OBJECTION', actorId: actor.id, requestKey: input.requestKey,
      payloadSignature: signature, noticeId: input.noticeId ?? null, exceptionEventId: event.id } });
    return goodsChangeView(updated);
  });
}

export async function reviewGoodsChange(prisma: PrismaClient, actor: Actor, orderId: string, input: GoodsReviewInput) {
  requireAdminLevel(actor, ['OPERATOR', 'SUPER_ADMIN']); validate(GoodsReviewBody, input);
  return prisma.$transaction(async (tx) => {
    const order = await lockPreparationOrder(tx, orderId);
    const linked = order.goodsChangeSourceExceptionId ? await tx.exceptionCase.findUnique({ where: { exceptionEventId: order.goodsChangeSourceExceptionId } }) : null;
    if (!linked) throw conflict('GOODS_CHANGE_CASE_MISSING', 'An existing goods-risk case is required');
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id"=${linked.id}::uuid FOR UPDATE`;
    const current = await tx.exceptionCase.findUniqueOrThrow({ where: { id: linked.id } });
    if (current.currentHandlerAdminId !== actor.id) throw forbidden();
    const signature = JSON.stringify({ action: 'REVIEW', expectedVersion: input.expectedVersion, expectedCaseVersion: input.expectedCaseVersion, outcome: input.outcome, reason: input.reason });
    const previous = await priorAction(tx, orderId, actor, input.requestKey, signature);
    if (previous) {
      if (order.goodsChangeVersion !== previous.version || current.version !== input.expectedCaseVersion + 1
        || (input.outcome === 'NO_ADDITIONAL_CORE_RISK_CONFIRMED' ? current.status !== 'RESOLVED' : current.status !== 'WAITING_FOR_PARTICIPANT')
        || !['READY_FOR_RIDER', 'CLAIMED', 'PICKED_UP'].includes(order.status)) throw conflict('GOODS_REVIEW_RETRY_CHANGED', 'Review workflow has changed');
      return goodsChangeView(order);
    }
    assertExceptionCaseAction(current.status, 'RESOLVE');
    if (!order.goodsChangeReviewPending || order.goodsChangeVersion !== input.expectedVersion || current.version !== input.expectedCaseVersion
      || !['READY_FOR_RIDER', 'CLAIMED', 'PICKED_UP'].includes(order.status)) throw conflict('GOODS_REVIEW_VERSION_CONFLICT', 'Refresh the active case and goods-change facts');
    const clear = input.outcome === 'NO_ADDITIONAL_CORE_RISK_CONFIRMED';
    if (clear && ((order.preparationControlState === 'NORMAL' && order.deliveryTask?.assignments.some((a) => a.noFaultExitStatus === 'PENDING'))
      || await tx.exceptionCase.count({ where: { orderId, id: { not: current.id }, status: { notIn: ['RESOLVED', 'CLOSED'] },
        // A separately paused preparation/delivery source retains its own gate. Resolve this domain without clearing that one.
        ...(order.preparationControlState !== 'NORMAL' && order.preparationSourceExceptionId ? { exceptionEventId: { not: order.preparationSourceExceptionId } } : {}),
      } }))) throw conflict('GOODS_OTHER_CONFLICT_PENDING', 'Other conflicts or pending exit must be reviewed before clearing this risk gate');
    const now = new Date();
    const changed = await tx.exceptionCase.updateMany({ where: { id: current.id, version: input.expectedCaseVersion, currentHandlerAdminId: actor.id, status: current.status }, data: {
      version: { increment: 1 }, lastActionAt: now, status: clear ? 'RESOLVED' : 'WAITING_FOR_PARTICIPANT',
      resolutionType: clear ? 'CONTINUE_FULFILLMENT' : 'WAITING_FOR_INFORMATION', resolutionNote: input.reason, ...(clear ? { resolvedAt: now } : {}),
    } });
    if (changed.count !== 1) throw conflict('CASE_VERSION_CONFLICT', 'Case or handler changed');
    const updated = await tx.order.update({ where: { id: orderId }, data: { goodsChangeVersion: { increment: 1 }, goodsChangeReviewPending: !clear } });
    if (clear) {
      const actions = await tx.exceptionCaseAction.findMany({ where: { caseId: current.id }, select: { metadata: true } });
      const covered = actions.flatMap(({ metadata }) => {
        const data = metadata as { action?: unknown; exceptionEventId?: unknown } | null;
        return data?.action === 'GOODS_CHANGE_OBJECTION' && typeof data.exceptionEventId === 'string' ? [data.exceptionEventId] : [];
      });
      await tx.exceptionEvent.updateMany({ where: { id: { in: [current.exceptionEventId, ...covered] }, orderId, type: 'GOODS_CHANGE_OBJECTION', resolvedAt: null }, data: { resolvedAt: now } });
    }
    await tx.goodsChangeAction.create({ data: { orderId, version: updated.goodsChangeVersion, action: 'REVIEW', actorId: actor.id,
      requestKey: input.requestKey, payloadSignature: signature, exceptionEventId: current.exceptionEventId } });
    await tx.exceptionCaseAction.create({ data: { caseId: current.id, type: clear ? 'RESOLVED' : 'REQUESTED_INFORMATION', actorId: actor.id, reason: input.reason,
      metadata: { action: 'GOODS_RISK_REVIEW', outcome: input.outcome, substitutionApproved: false, moneyChanged: false, riskSnapshotChanged: false } } });
    return goodsChangeView(updated);
  });
}
