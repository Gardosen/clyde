// Binaeres Rahmenformat fuer Blob-Transfers (gemeinsam fuer Client und Server):
//   [32 Byte SHA-256 roh][4 Byte Laenge, Big-Endian][Daten]
import { createHash } from 'node:crypto';

export const HASH_BYTES = 32;
export const LEN_BYTES = 4;
export const HEADER_BYTES = HASH_BYTES + LEN_BYTES;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function isHash(h) {
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
}

export function encodeBlob(hashHex, data) {
  const header = Buffer.alloc(HEADER_BYTES);
  Buffer.from(hashHex, 'hex').copy(header, 0);
  header.writeUInt32BE(data.length, HASH_BYTES);
  return [header, data];
}

// Liest aus einem (async) Iterable von Buffern nacheinander {hash, data}.
export async function* decodeBlobs(source) {
  const parts = [];
  let total = 0;
  let header = null;
  let need = HEADER_BYTES;

  const take = (n) => {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const p = parts[0];
      const want = n - off;
      if (p.length <= want) { p.copy(out, off); off += p.length; parts.shift(); }
      else { p.copy(out, off, 0, want); parts[0] = p.subarray(want); off += want; }
    }
    total -= n;
    return out;
  };

  for await (const chunk of source) {
    if (!chunk.length) continue;
    parts.push(chunk);
    total += chunk.length;
    while (total >= need) {
      if (!header) {
        header = take(HEADER_BYTES);
        need = header.readUInt32BE(HASH_BYTES);
        if (need === 0) {
          yield { hash: header.subarray(0, HASH_BYTES).toString('hex'), data: Buffer.alloc(0) };
          header = null; need = HEADER_BYTES;
        }
      } else {
        const data = take(need);
        yield { hash: header.subarray(0, HASH_BYTES).toString('hex'), data };
        header = null; need = HEADER_BYTES;
      }
    }
  }
  if (total || header) throw new Error('Unvollstaendiger Blob-Stream (Verbindung abgebrochen?)');
}
