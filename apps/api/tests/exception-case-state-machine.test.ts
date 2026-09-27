import { ExceptionCaseStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertExceptionCaseAction, type ExceptionCaseAction } from '../src/exception-cases/state-machine.js';

describe('exception case state machine', () => {
  it('keeps resolved and closed cases terminal for ownership and resolution actions', () => {
    const actions: ExceptionCaseAction[] = ['RELEASE', 'TRANSFER', 'TAKEOVER', 'ESCALATE', 'RESOLVE', 'ADMIN_REFUND'];
    for (const status of [ExceptionCaseStatus.RESOLVED, ExceptionCaseStatus.CLOSED]) {
      for (const action of actions) expect(() => assertExceptionCaseAction(status, action)).toThrow(/not allowed/);
    }
  });

  it('requires takeover before an escalated case can be resolved', () => {
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.ESCALATED, 'RESOLVE')).toThrow(/not allowed/);
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.ESCALATED, 'ADMIN_REFUND')).toThrow(/not allowed/);
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.ESCALATED, 'TAKEOVER')).not.toThrow();
  });

  it('blocks participant remake actions while a case is escalated', () => {
    for (const action of ['RIDER_PROPOSE_REMAKE', 'CUSTOMER_ACCEPT_REMAKE', 'CUSTOMER_REJECT_REMAKE'] as const) {
      expect(() => assertExceptionCaseAction(ExceptionCaseStatus.ESCALATED, action)).toThrow(/not allowed/);
    }
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.OPEN, 'RIDER_PROPOSE_REMAKE')).not.toThrow();
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.WAITING_FOR_PARTICIPANT, 'CUSTOMER_ACCEPT_REMAKE')).not.toThrow();
    expect(() => assertExceptionCaseAction(ExceptionCaseStatus.WAITING_FOR_PARTICIPANT, 'CUSTOMER_REJECT_REMAKE')).not.toThrow();
  });
});
