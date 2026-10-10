import { badRequest } from './errors.js';

export function assertMinor(value: number, field = 'amount'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw badRequest('INVALID_MONEY', `${field} must be a non-negative safe integer in minor currency units`);
  }
  return value;
}

export function addMinor(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + assertMinor(value), 0);
  if (!Number.isSafeInteger(total)) throw badRequest('MONEY_OVERFLOW', 'Money calculation overflowed');
  return total;
}

export function multiplyMinor(value: number, quantity: number): number {
  assertMinor(value);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw badRequest('INVALID_QUANTITY', 'quantity must be a positive safe integer');
  }
  const total = value * quantity;
  if (!Number.isSafeInteger(total)) throw badRequest('MONEY_OVERFLOW', 'Money calculation overflowed');
  return total;
}

export function basisPoints(value: number, bps: number): number {
  assertMinor(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw badRequest('INVALID_BASIS_POINTS', 'basis points must be an integer between 0 and 10000');
  }
  return Number(BigInt(value) * BigInt(bps) / 10_000n);
}

