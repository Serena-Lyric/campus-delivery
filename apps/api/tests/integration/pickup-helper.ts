import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { seedIds } from '../../prisma/seed.js';

// Existing flow regressions now use the authorized merchant protocol.
export async function merchantPickup(app: FastifyInstance, prisma: PrismaClient, taskId: string, payload: { evidenceId?: string; pickupPhotoEvidenceId?: string; codeId?: string; code?: string } = {}) {
  const task = await prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId }, include: { order: true, assignments: { orderBy: { claimedAt: 'desc' } } } });
  const assignment = task.assignments.find((a) => a.status === 'ACTIVE') ?? task.assignments[0];
  return app.inject({ method: 'POST', url: `/merchant/orders/${task.orderId}/confirm-rider-pickup`, headers: { 'x-user-id': seedIds.merchantUser }, payload: { assignmentId: assignment!.id, expectedRevision: task.order.pickupHandoffRevision, requestKey: randomUUID(), ...(payload.pickupPhotoEvidenceId ?? payload.evidenceId ? { photoEvidenceId: payload.pickupPhotoEvidenceId ?? payload.evidenceId } : {}), ...(payload.codeId ? { codeId: payload.codeId } : {}), ...(payload.code ? { code: payload.code } : {}) } });
}
