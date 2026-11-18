import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Staff PINs (4–6 digits). The POS verifies them OFFLINE, so it gets this hash.
 * Format: "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>" — the Dart POS
 * implements the same check (Pos_Cafe lib/core/staff/pin.dart, same test vector).
 *
 * A 4–6 digit PIN is a small space: the salt + iterations slow down guessing if a
 * tablet's database is stolen, and the POS locks after 5 wrong tries. The owner can
 * deactivate a staff member at any time.
 */
export const PIN_ITERATIONS = 20_000;
const KEY_LENGTH = 32;

export const isValidPin = (pin: string) => /^\d{4,6}$/.test(pin);

export function hashPin(pin: string, salt: Buffer = randomBytes(16), iterations = PIN_ITERATIONS): string {
  const hash = pbkdf2Sync(pin, salt, iterations, KEY_LENGTH, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [algo, iter, salt, hash] = stored.split('$');
  if (algo !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = pbkdf2Sync(pin, Buffer.from(salt, 'base64url'), Number(iter), expected.length, 'sha256');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
