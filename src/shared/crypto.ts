import { createHash, randomBytes } from 'node:crypto';

/** Random secret token (base64url, 256 bits). */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** We store only the hash of tokens, never the token itself. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Short human-friendly pairing code, e.g. "K7Q2-M9XD". */
export function newPairingCode(): string {
  const chars = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
