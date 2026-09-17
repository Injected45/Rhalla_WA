import * as crypto from 'crypto';
import * as https from 'https';

// WhatsApp media encryption spec: mediaKey → HKDF-SHA256 → [iv:16, cipherKey:32, macKey:32, refKey:32].
// Fetch from mmg.whatsapp.net{directPath}, verify HMAC-SHA256 of iv||ciphertext (first 10 bytes),
// then AES-256-CBC decrypt with cipherKey/iv. Applied by wwjs's internal Message.downloadMedia,
// but reimplemented here so we can recover when wwjs's puppeteer-side module reflection breaks
// against a WA Web update (the "r: r" error we hit on 2026-08-08).

const INFO_BY_TYPE: Record<string, string> = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  ptt: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Image Keys',
};

export interface RawMediaInfo {
  directPath: string;
  mediaKey: string | Uint8Array | Record<string, number>;
  type: string;
  mimetype?: string;
  filename?: string;
  encFilehash?: string;
  filehash?: string;
  mediaUrl?: string;
}

/** Coerce mediaKey from any shape wwjs might hand us back into a Buffer. */
function toBuffer(val: unknown): Buffer {
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (typeof val === 'string') return Buffer.from(val, 'base64');
  if (val && typeof val === 'object') {
    // Puppeteer commonly serializes Uint8Array as { "0": 12, "1": 34, ... }
    const values = Object.values(val as Record<string, number>);
    if (values.every(v => typeof v === 'number')) {
      return Buffer.from(values);
    }
  }
  throw new Error(`Unsupported mediaKey shape: ${typeof val}`);
}

export async function fetchAndDecryptWhatsAppMedia(info: RawMediaInfo): Promise<Buffer> {
  const infoStr = INFO_BY_TYPE[info.type] || INFO_BY_TYPE['image'];
  const mediaKey = toBuffer(info.mediaKey);
  if (mediaKey.length !== 32) {
    throw new Error(`mediaKey wrong length: ${mediaKey.length} (expected 32)`);
  }

  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), Buffer.from(infoStr, 'utf8'), 112));
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const url = info.mediaUrl || `https://mmg.whatsapp.net${info.directPath}`;
  const encrypted = await httpsGet(url);
  if (encrypted.length < 11) {
    throw new Error(`encrypted payload too short (${encrypted.length} bytes)`);
  }
  const mediaBytes = encrypted.subarray(0, encrypted.length - 10);
  const receivedMac = encrypted.subarray(encrypted.length - 10);

  const hmac = crypto.createHmac('sha256', macKey);
  hmac.update(iv);
  hmac.update(mediaBytes);
  const computedMac = hmac.digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(computedMac, receivedMac)) {
    throw new Error('MAC verification failed — mediaKey/CDN payload mismatch');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(mediaBytes), decipher.final()]);
}

/** Follow up to 5 redirects, capped at 25 MB, 30 s per request. */
function httpsGet(url: string, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // WA CDN is permissive but a plausible UA avoids some 403s.
          'User-Agent': 'WhatsApp/2.24.11.75 A',
          Accept: '*/*',
        },
        timeout: 30_000,
      },
      res => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          httpsGet(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching WA media`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > 25 * 1024 * 1024) {
            req.destroy(new Error('media exceeds 25 MB cap'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('WA media fetch timed out')));
    req.on('error', reject);
  });
}
