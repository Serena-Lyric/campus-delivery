import {
  ExceptionCaseActionType,
  ExceptionCaseStatus,
  ExceptionResolutionType,
  ExceptionType,
  RemakeProposalStatus,
  type PrismaClient,
} from '@prisma/client';
import type { Actor } from '../auth/auth.js';
import { assertOrderAccess } from '../orders/access.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import { createSevereRiderExceptionEvent } from './service.js';
import { assertExceptionCaseAction } from '../exception-cases/state-machine.js';
import { resolveLinkedExceptionEvent } from '../settlements/service.js';

const severeTypes: ExceptionType[] = [ExceptionType.SEVERE_FOOD_DAMAGE, ExceptionType.FOOD_LOST];

export async function reportSevereRiderException(
  prisma: PrismaClient,
  actor: Actor,
  orderId: string,
  input: { type: ExceptionType; description: string },
) {
  const event = await createSevereRiderExceptionEvent(prisma, actor, orderId, input);
  return prisma.exceptionCase.findUniqueOrThrow({
    where: { exceptionEventId: event.id },
    select: { id: true, orderId: true, category: true, priority: true, status: true, createdAt: true },
  });
}

export async function proposeRemake(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  message: string,
  now = new Date(),
) {
  if (!actor.riderId) throw forbidden();
  const riderId = actor.riderId;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
    const exceptionCase = await tx.exceptionCase.findUnique({
      where: { id: caseId },
      include: { order: { include: { deliveryTask: true } }, remakeProposal: true },
    });
    if (!exceptionCase) throw notFound('Exception case');
    if (!severeTypes.includes(exceptionCase.category)) throw conflict('REMAKE_NOT_AVAILABLE', 'This exception does not support remake');
    if (exceptionCase.order.deliveryTask?.riderId !== riderId) throw forbidden();
    if (exceptionCase.remakeProposal) throw conflict('REMAKE_ALREADY_PROPOSED', 'A remake proposal already exists');
    assertExceptionCaseAction(exceptionCase.status, 'RIDER_PROPOSE_REMAKE');
    const proposal = await tx.remakeProposal.create({
      data: { caseId, orderId: exceptionCase.orderId, riderId, message },
    });
    await tx.exceptionCase.update({
      where: { id: caseId },
      data: {
        status: ExceptionCaseStatus.WAITING_FOR_PARTICIPANT,
        resolutionType: null,
        resolutionNote: null,
        resolvedAt: null,
        lastActionAt: now,
        version: { increment: 1 },
      },
    });
    await tx.exceptionCaseAction.create({
      data: { caseId, type: ExceptionCaseActionType.REQUESTED_INFORMATION, actorId: actor.id, reason: 'REMAKE_PROPOSED', metadata: { proposalId: proposal.id } },
    });
    return {
      id: proposal.id,
      caseId: proposal.caseId,
      message: proposal.message,
      status: proposal.status,
      createdAt: proposal.createdAt,
    };
  });
}

export async function respondToRemake(
  prisma: PrismaClient,
  actor: Actor,
  caseId: string,
  accept: boolean,
  now = new Date(),
) {
  if (actor.role !== 'CUSTOMER') throw forbidden();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ExceptionCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
    const exceptionCase = await tx.exceptionCase.findUnique({
      where: { id: caseId },
      include: { order: true, remakeProposal: true },
    });
    if (!exceptionCase) throw notFound('Exception case');
    if (exceptionCase.order.customerId !== actor.id) throw forbidden();
    if (!exceptionCase.remakeProposal || exceptionCase.remakeProposal.status !== RemakeProposalStatus.PENDING) {
      throw conflict('NO_PENDING_REMAKE', 'No pending remake proposal exists');
    }
    assertExceptionCaseAction(
      exceptionCase.status,
      accept ? 'CUSTOMER_ACCEPT_REMAKE' : 'CUSTOMER_REJECT_REMAKE',
    );
    const status = accept ? RemakeProposalStatus.ACCEPTED : RemakeProposalStatus.REJECTED;
    await tx.remakeProposal.update({
      where: { id: exceptionCase.remakeProposal.id },
      data: { status, respondedAt: now },
    });
    await tx.exceptionCase.update({
      where: { id: caseId },
      data: accept
        ? {
          status: ExceptionCaseStatus.RESOLVED,
          resolutionType: ExceptionResolutionType.REMAKE_AND_CONTINUE,
          resolutionNote: 'Customer accepted remake and continued fulfillment',
          resolvedAt: now,
          lastActionAt: now,
          version: { increment: 1 },
        }
        : {
          status: exceptionCase.currentHandlerAdminId
            ? ExceptionCaseStatus.IN_PROGRESS
            : ExceptionCaseStatus.OPEN,
          ...(!exceptionCase.currentHandlerAdminId
            ? { currentHandlerAdminId: null, claimedAt: null }
            : {}),
          resolutionType: null,
          resolutionNote: null,
          resolvedAt: null,
          lastActionAt: now,
          version: { increment: 1 },
        },
    });
    if (accept) await resolveLinkedExceptionEvent(tx, exceptionCase, now);
    await tx.exceptionCaseAction.create({
      data: {
        caseId,
        type: accept ? ExceptionCaseActionType.RESOLVED : ExceptionCaseActionType.REMAKE_REJECTED,
        actorId: actor.id,
        reason: accept ? 'CUSTOMER_ACCEPTED_REMAKE' : 'CUSTOMER_REJECTED_REMAKE',
        metadata: {
          proposalId: exceptionCase.remakeProposal.id,
          resultingCaseStatus: accept
            ? ExceptionCaseStatus.RESOLVED
            : exceptionCase.currentHandlerAdminId
              ? ExceptionCaseStatus.IN_PROGRESS
              : ExceptionCaseStatus.OPEN,
        },
      },
    });
    return { status };
  });
}

export async function getOrderExceptionView(prisma: PrismaClient, actor: Actor, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { deliveryTask: true, assignments: { select: { riderId: true } } },
  });
  if (!order) throw notFound('Order');
  assertOrderAccess(actor, order);
  const cases = await prisma.exceptionCase.findMany({
    where: { orderId },
    select: {
      id: true,
      category: true,
      priority: true,
      status: true,
      resolutionType: true,
      resolutionNote: true,
      createdAt: true,
      resolvedAt: true,
      remakeProposal: { select: { id: true, message: true, status: true, respondedAt: true } },
      compensationObligation: {
        select: {
          id: true,
          requiredCompensationMinor: true,
          currentOrderReservedMinor: true,
          otherUnwithdrawnReservedMinor: true,
          riderVoluntaryPaymentMinor: true,
          platformAdvancedMinor: true,
          customerRefundMinor: true,
          outstandingMinor: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return cases.map((exceptionCase) => ({
    id: exceptionCase.id,
    category: exceptionCase.category,
    priority: exceptionCase.priority,
    status: exceptionCase.status,
    resolutionType: exceptionCase.resolutionType,
    resolutionNote: exceptionCase.resolutionNote,
    createdAt: exceptionCase.createdAt,
    resolvedAt: exceptionCase.resolvedAt,
    remakeProposal: exceptionCase.remakeProposal,
    compensation: !exceptionCase.compensationObligation
      ? null
      : actor.role === 'RIDER'
        ? {
          id: exceptionCase.compensationObligation.id,
          requiredCompensationMinor: exceptionCase.compensationObligation.requiredCompensationMinor,
          currentOrderReservedMinor: exceptionCase.compensationObligation.currentOrderReservedMinor,
          otherUnwithdrawnReservedMinor: exceptionCase.compensationObligation.otherUnwithdrawnReservedMinor,
          riderVoluntaryPaymentMinor: exceptionCase.compensationObligation.riderVoluntaryPaymentMinor,
          platformAdvancedMinor: exceptionCase.compensationObligation.platformAdvancedMinor,
          outstandingMinor: exceptionCase.compensationObligation.outstandingMinor,
          status: exceptionCase.compensationObligation.status,
        }
        : actor.role === 'CUSTOMER'
          ? {
            id: exceptionCase.compensationObligation.id,
            customerRefundMinor: exceptionCase.compensationObligation.customerRefundMinor,
            status: exceptionCase.compensationObligation.status,
          }
          : actor.role === 'MERCHANT'
            ? { id: exceptionCase.compensationObligation.id, status: exceptionCase.compensationObligation.status }
            : exceptionCase.compensationObligation,
  }));
}
