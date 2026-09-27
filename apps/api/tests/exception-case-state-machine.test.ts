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
});
