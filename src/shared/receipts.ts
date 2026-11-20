import { createPublicKey, verify } from 'node:crypto';

/**
 * The QR code printed on a receipt: "<payload>.<signature>", both base64url.
 * payload = JSON {o: orderId, d: deviceId, n: receiptNumber, t: total millimes, at: unix seconds}
 * signature = Ed25519(payload base64url text) with the POS's private key (created at pairing).
 * The backend checks it with the public key the POS sent when it was paired.
 */
export interface ReceiptClaim {
  orderId: string;
  deviceId: string;
  receiptNumber: string;
  total: number;
  at: Date;
}

export function parseReceiptCode(code: string): { payload: string; signature: string; claim: ReceiptClaim } | null {
  const [payload, signature, extra] = code.trim().split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof j.o !== 'string' ||
      typeof j.d !== 'string' ||
      typeof j.n !== 'string' ||
      typeof j.t !== 'number' ||
      !Number.isInteger(j.t) ||
      j.t < 0 ||
      typeof j.at !== 'number'
    ) {
      return null;
    }
    return { payload, signature, claim: { orderId: j.o, deviceId: j.d, receiptNumber: j.n, total: j.t, at: new Date(j.at * 1000) } };
  } catch {
    return null;
  }
}

/** Ed25519 raw public key (32 bytes, base64url) → checks the signature of [payload]. */
export function verifyReceiptSignature(publicKeyB64url: string, payload: string, signatureB64url: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64url, 'base64url');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), // SPKI header for Ed25519
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signatureB64url, 'base64url'));
  } catch {
    return false;
  }
}
