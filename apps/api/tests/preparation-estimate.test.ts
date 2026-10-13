import { describe, expect, it } from 'vitest';
import { preparationEstimateView } from '../src/orders/preparation-estimate.js';

describe('prediction overdue boundaries use the supplied server clock', () => {
  const order = { status: 'CLAIMED' as const, merchantPreparationStatus: 'PREPARING' as const,
    merchantEstimatedReadyAt: new Date('2026-10-13T04:00:00Z'), merchantPreparationEstimateVersion: 2 };
  it('becomes overdue exactly at the predicted instant without changing readiness', () => {
    expect(preparationEstimateView(order, 'Asia/Shanghai', new Date('2026-10-13T03:59:59.999Z'), true)).toMatchObject({ overdue: false, updateReminder: false });
    expect(preparationEstimateView(order, 'Asia/Shanghai', new Date('2026-10-13T04:00:00Z'), true)).toMatchObject({ overdue: true, updateReminder: true, estimatedReadyAtLocal: '2026-10-13 12:00:00' });
    expect(order.merchantPreparationStatus).toBe('PREPARING');
  });
  it('uses campus time for display and suppresses reminders for READY, terminal and missing predictions', () => {
    const now = new Date('2026-10-13T05:00:00Z');
    expect(preparationEstimateView(order, 'America/New_York', now)).toMatchObject({ overdue: true, updateReminder: false, estimatedReadyAtLocal: '2026-10-13 00:00:00' });
    for (const current of [{ ...order, merchantEstimatedReadyAt: null }, { ...order, merchantPreparationStatus: 'READY_FOR_PICKUP' as const }, { ...order, status: 'EXCEPTION' as const }]) {
      expect(preparationEstimateView(current, 'Asia/Shanghai', now, true)).toMatchObject({ overdue: false, updateReminder: false });
    }
  });
});
