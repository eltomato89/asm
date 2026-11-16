import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type Sealed = {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
};

/** Generic on purpose: never contains plaintext, keys or AAD. */
export class DecryptError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptError';
  }
}

function encrypt(key: Buffer, aad: string, data: Buffer) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, aad: string, ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function seal(kek: Buffer, aad: string, plaintext: string): Sealed {
  if (kek.length !== KEY_LENGTH) throw new Error('KEK must be 32 bytes');
  const dek = randomBytes(KEY_LENGTH);
  try {
    const data = encrypt(dek, aad, Buffer.from(plaintext, 'utf8'));
    const wrapped = encrypt(kek, `dek:${aad}`, dek);
    return {
      ciphertext: data.ciphertext,
      iv: data.iv,
      tag: data.tag,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    };
  } finally {
    dek.fill(0);
  }
}

export function open(kek: Buffer, aad: string, sealed: Sealed): string {
  let dek: Buffer | undefined;
  try {
    dek = decrypt(kek, `dek:${aad}`, sealed.wrappedDek, sealed.dekIv, sealed.dekTag);
    return decrypt(dek, aad, sealed.ciphertext, sealed.iv, sealed.tag).toString('utf8');
  } catch {
    throw new DecryptError();
  } finally {
    dek?.fill(0);
  }
}
