import type { Prisma } from '@prisma/client';
import { conflict } from '../shared/errors.js';

export async function assertNoPickupDispute(tx: Prisma.TransactionClient, orderId: string) {
  if (await tx.pickupCustodyDispute.count({ where: { orderId, status: { in: ['OPEN', 'INCONCLUSIVE'] } } })) {
    throw conflict('PICKUP_CUSTODY_DISPUTED', 'Physical pickup must be reviewed before fulfillment or financial disposition');
  }
}
