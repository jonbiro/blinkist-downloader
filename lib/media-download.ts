import fs from 'node:fs';
import path from 'node:path';
import { validAudioFile } from './book-files.js';

export type MediaDownloadOptions = {
  fetchImpl?: typeof fetch;
  attempts?: number;
  retryDelayMs?: number;
};

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Save an ordinary, authorized HTTPS media response atomically.
 * Never accept range-only responses or a truncated declared Content-Length.
 */
export async function downloadMediaFile(
  url: string, file: string, options: MediaDownloadOptions = {},
): Promise<void> {
  if (!isHttps(url)) throw new Error('Media URL must use HTTPS');
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const staged = file + '.part';
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      if (response.status !== 200) {
        throw new Error('Expected full HTTP 200 media response; got ' + response.status);
      }
      if (response.url && !isHttps(response.url)) {
        throw new Error('Media redirected to a non-HTTPS destination');
      }

      const mime = (response.headers.get('content-type') ?? '').toLowerCase();
      if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) {
        throw new Error('Unexpected response type, not media');
      }

      const reported = response.headers.get('content-length');
      let declaredLength: number | undefined;
      if (reported !== null) {
        declaredLength = Number(reported);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          throw new Error('Invalid Content-Length header');
        }
        if (declaredLength > MAX_MEDIA_BYTES) throw new Error('Media file exceeds 100 MB limit');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Media response has no downloadable body');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let total = 0;
      let header = new Uint8Array(0);
      let finished = false;
      const handle = await fs.promises.open(staged, 'w');
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { finished = true; break; }
          const bytes = chunk.value;
          total += bytes.byteLength;
          if (total > MAX_MEDIA_BYTES) throw new Error('Media file exceeds 100 MB limit');
          if (header.length < 96) {
            header = Uint8Array.from([...header, ...bytes.subarray(0, 96 - header.length)]);
          }
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
            if (bytesWritten <= 0) throw new Error('Could not write media data');
            offset += bytesWritten;
          }
        }
      } finally {
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
      if (total <= 128) throw new Error('Empty or unexpectedly short media file');
      const encoding = (response.headers.get('content-encoding') ?? 'identity').toLowerCase();
      // Node fetch may transparently decompress encoded responses.
      if (declaredLength !== undefined && encoding === 'identity'
          && total !== declaredLength) {
        throw new Error('Truncated or incomplete media response (length mismatch)');
      }
      const prefix = Buffer.from(header).toString('utf8').trimStart().toLowerCase();
      if (prefix.startsWith('<html') || prefix.startsWith('<!doctype html')
          || prefix.startsWith('{"error"')) {
        throw new Error('Remote server returned HTML/JSON instead of media');
      }
      if (file.toLowerCase().endsWith('.m4a') && !validAudioFile(staged)) {
        throw new Error('Downloaded response does not have recognizable audio header');
      }
      fs.renameSync(staged, file);
      return;
    } catch (error) {
      fs.rmSync(staged, { force: true });
      if (attempt === attempts) throw error;
      if (retryDelayMs) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
}
