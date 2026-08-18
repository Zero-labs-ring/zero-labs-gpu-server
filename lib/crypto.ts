import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getEnvOrThrow } from './env-check';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = getEnvOrThrow('ENCRYPTION_KEY');
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decrypt(encrypted: string, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
