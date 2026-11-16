import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptError, open, seal, type Sealed } from '../src/crypto/envelope.js';

const kek = randomBytes(32);
const aad = 'sec_01ABC:3';
const secret = 'super-secret-value-42';

function flip(buf: Buffer): Buffer {
  const copy = Buffer.from(buf);
  copy[0] = copy[0]! ^ 0x01;
  return copy;
}

describe('envelope encryption', () => {
  it('roundtrips', () => {
    expect(open(kek, aad, seal(kek, aad, secret))).toBe(secret);
  });

  it('roundtrips empty and unicode values', () => {
    expect(open(kek, aad, seal(kek, aad, ''))).toBe('');
    expect(open(kek, aad, seal(kek, aad, 'äöü 🔑'))).toBe('äöü 🔑');
  });

  it('produces different ciphertexts for the same value', () => {
    const a = seal(kek, aad, secret);
    const b = seal(kek, aad, secret);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it.each(['ciphertext', 'tag', 'wrappedDek', 'iv', 'dekIv', 'dekTag'] as const)(
    'rejects a flipped byte in %s',
    (field) => {
      const sealed = seal(kek, aad, secret);
      const tampered: Sealed = { ...sealed, [field]: flip(sealed[field]) };
      expect(() => open(kek, aad, tampered)).toThrow(DecryptError);
    },
  );

  it('rejects wrong aad', () => {
    expect(() => open(kek, 'sec_01ABC:4', seal(kek, aad, secret))).toThrow(DecryptError);
  });

  it('rejects wrong kek', () => {
    expect(() => open(randomBytes(32), aad, seal(kek, aad, secret))).toThrow(DecryptError);
  });

  it('does not leak plaintext in the error', () => {
    const sealed = seal(kek, aad, secret);
    try {
      open(kek, aad, { ...sealed, ciphertext: flip(sealed.ciphertext) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptError);
      expect(String(err)).not.toContain(secret);
      expect(String(err)).not.toContain(aad);
      expect((err as Error).message).toBe('decryption failed');
    }
  });

  it('rejects a kek of wrong length', () => {
    expect(() => seal(Buffer.alloc(16), aad, secret)).toThrow(/32 bytes/);
  });
});
