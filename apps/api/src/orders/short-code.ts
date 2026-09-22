import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export function generateShortCode(bytes: Uint8Array = randomBytes(CODE_LENGTH)): string {
  if (bytes.length < CODE_LENGTH) throw new Error('At least four random bytes are required');
  return Array.from(bytes.slice(0, CODE_LENGTH), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function shortCodeDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
}

export const shortCodePattern = '^[A-HJ-NP-Z2-9]{4}$';
