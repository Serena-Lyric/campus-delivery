import { ExceptionCaseStatus } from '@prisma/client';
import { conflict } from '../shared/errors.js';

export type ExceptionCaseAction =
  | 'CLAIM'
  | 'RELEASE'
  | 'TRANSFER'
  | 'TAKEOVER'
  | 'ESCALATE'
  | 'RESOLVE'
  | 'ADMIN_REFUND'
  | 'RIDER_COMPENSATE';

const allowed: Readonly<Record<ExceptionCaseAction, readonly ExceptionCaseStatus[]>> = {
  CLAIM: [ExceptionCaseStatus.OPEN],
  RELEASE: [ExceptionCaseStatus.IN_PROGRESS, ExceptionCaseStatus.WAITING_FOR_PARTICIPANT],
  TRANSFER: [ExceptionCaseStatus.IN_PROGRESS, ExceptionCaseStatus.WAITING_FOR_PARTICIPANT],
  TAKEOVER: [
    ExceptionCaseStatus.OPEN,
    ExceptionCaseStatus.IN_PROGRESS,
    ExceptionCaseStatus.WAITING_FOR_PARTICIPANT,
    ExceptionCaseStatus.ESCALATED,
  ],
  ESCALATE: [ExceptionCaseStatus.IN_PROGRESS, ExceptionCaseStatus.WAITING_FOR_PARTICIPANT],
  RESOLVE: [ExceptionCaseStatus.IN_PROGRESS, ExceptionCaseStatus.WAITING_FOR_PARTICIPANT],
  ADMIN_REFUND: [ExceptionCaseStatus.IN_PROGRESS, ExceptionCaseStatus.WAITING_FOR_PARTICIPANT],
  RIDER_COMPENSATE: [
    ExceptionCaseStatus.OPEN,
    ExceptionCaseStatus.IN_PROGRESS,
    ExceptionCaseStatus.WAITING_FOR_PARTICIPANT,
  ],
};

export function assertExceptionCaseAction(status: ExceptionCaseStatus, action: ExceptionCaseAction): void {
  if (!allowed[action].includes(status)) {
    throw conflict('CASE_STATE_CONFLICT', `${action} is not allowed while exception case is ${status}`);
  }
}
