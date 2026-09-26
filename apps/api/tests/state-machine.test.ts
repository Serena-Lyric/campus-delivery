import { OrderStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertTransition } from '../src/orders/state-machine.js';

describe('order state machine', () => {
  it('accepts the complete delivery lifecycle', () => {
    const path = [
      OrderStatus.CREATED,
      OrderStatus.MERCHANT_PENDING,
      OrderStatus.MERCHANT_CONFIRMED,
      OrderStatus.READY_FOR_RIDER,
      OrderStatus.CLAIMED,
      OrderStatus.PICKED_UP,
      OrderStatus.DELIVERED,
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(() => assertTransition(path[index]!, path[index + 1]!)).not.toThrow();
    }
  });

  it('allows the dedicated pre-pickup return-to-pool transition and the no-rider terminal outcome', () => {
    expect(() => assertTransition(OrderStatus.CLAIMED, OrderStatus.READY_FOR_RIDER)).not.toThrow();
    expect(() => assertTransition(OrderStatus.READY_FOR_RIDER, OrderStatus.NO_RIDER_ACCEPTED)).not.toThrow();
  });

  it('rejects skipping states and leaving terminal states', () => {
    expect(() => assertTransition(OrderStatus.CREATED, OrderStatus.DELIVERED)).toThrow(/cannot transition/);
    expect(() => assertTransition(OrderStatus.DELIVERED, OrderStatus.CANCELLED)).toThrow(/cannot transition/);
    expect(() => assertTransition(OrderStatus.CANCELLED, OrderStatus.CREATED)).toThrow(/cannot transition/);
  });
});
