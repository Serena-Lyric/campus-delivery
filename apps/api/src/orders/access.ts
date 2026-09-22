import type { Actor } from '../auth/auth.js';
import { forbidden } from '../shared/errors.js';

type AccessibleOrder = {
  customerId: string;
  merchantId: string;
  deliveryTask?: { riderId: string | null } | null;
  assignments?: Array<{ riderId: string }>;
};

export function canAccessOrder(actor: Actor, order: AccessibleOrder): boolean {
  return Boolean(actor.role === 'ADMIN'
    || (actor.role === 'CUSTOMER' && order.customerId === actor.id)
    || (actor.role === 'MERCHANT' && order.merchantId === actor.merchantId)
    || (actor.role === 'RIDER' && (
      order.deliveryTask?.riderId === actor.riderId
      || order.assignments?.some((assignment) => assignment.riderId === actor.riderId)
    )));
}

export function assertOrderAccess(actor: Actor, order: AccessibleOrder): void {
  if (!canAccessOrder(actor, order)) throw forbidden();
}
