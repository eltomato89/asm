import { generateVAPIDKeys } from 'web-push';
import type { Clock } from '../clock.js';
import { open, seal } from '../crypto/envelope.js';
import type { Db } from '../db/client.js';

export type VapidKeys = { publicKey: string; privateKey: string };

const ROW_ID = 1;
const aad = (publicKey: string) => `vapid:${publicKey}`;

type Row = {
  public_key: string; ciphertext: Buffer; iv: Buffer; tag: Buffer; wrapped_dek: Buffer; dek_iv: Buffer; dek_tag: Buffer;
};

/**
 * Loads the server's VAPID key pair, creating it on first start. The private key is sealed with the master key
 * (AAD bound to the public key); a concurrent first start keeps whichever row was inserted first.
 */
export function loadOrCreateVapidKeys(
  db: Db,
  clock: Clock,
  kek: Buffer,
  generate: () => VapidKeys = () => generateVAPIDKeys(),
): VapidKeys {
  const select = () => db.$client.prepare('SELECT * FROM vapid_keys WHERE id = ?').get(ROW_ID) as Row | undefined;
  let row = select();
  if (!row) {
    const keys = generate();
    const s = seal(kek, aad(keys.publicKey), keys.privateKey);
    db.$client
      .prepare(
        `INSERT OR IGNORE INTO vapid_keys (id, public_key, ciphertext, iv, tag, wrapped_dek, dek_iv, dek_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ROW_ID, keys.publicKey, s.ciphertext, s.iv, s.tag, s.wrappedDek, s.dekIv, s.dekTag, clock.now());
    row = select()!;
  }
  const privateKey = open(kek, aad(row.public_key), {
    ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, wrappedDek: row.wrapped_dek, dekIv: row.dek_iv, dekTag: row.dek_tag,
  });
  return { publicKey: row.public_key, privateKey };
}
