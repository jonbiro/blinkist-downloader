import type { Page, Response } from 'playwright-chromium';

export type AudioResponseInfo = {
  url: string;
  status: number;
  contentType?: string;
};

export type AudioChoice = {
  url: string | null;
  source: 'attribute' | 'network' | 'none';
  reason?: 'no-source' | 'ambiguous-network' | 'already-used';
};

const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac',
  'audio/wav', 'audio/ogg', 'audio/webm',
]);

// Recognize ordinary, unencrypted HTTPS audio only; reject playlists and JSON.
// This does not decrypt blob URLs, MediaSource streams, or protected content.
export function isAudioResponse(info: AudioResponseInfo): boolean {
  if (info.status !== 200 && info.status !== 206) return false;
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const mime = (info.contentType ?? '').split(';')[0].toLowerCase().trim();
  if (mime.includes('mpegurl') || mime.includes('dash+xml')) return false;
  if (SUPPORTED_AUDIO_TYPES.has(mime)) return true;
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return false;
  return /\.(?:m4a|mp3|aac|mp4|ogg|webm|wav)$/i.test(url.pathname);
}

function toHttpsUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * DOM audio URLs are authoritative. If a page exposes a blob: URL, choose a
 * direct HTTPS response only when exactly one distinct candidate was observed
 * while visiting the current chapter. Never silently assign the "latest" URL.
 */
export function chooseAudioSource(
  domSource: string | null | undefined,
  pageUrl: string,
  responseUrls: readonly string[],
  usedUrls: ReadonlySet<string> = new Set(),
): AudioChoice {
  const dom = toHttpsUrl(domSource, pageUrl);
  if (dom && !usedUrls.has(dom)) return { url: dom, source: 'attribute' };

  const candidates = [...new Set(responseUrls
    .map(url => toHttpsUrl(url, pageUrl))
    .filter((url): url is string => Boolean(url)))]
    .filter(url => !usedUrls.has(url));

  if (candidates.length === 1) return { url: candidates[0], source: 'network' };
  if (candidates.length > 1) {
    return { url: null, source: 'none', reason: 'ambiguous-network' };
  }
  return { url: null, source: 'none', reason: dom && usedUrls.has(dom) ? 'already-used' : 'no-source' };
}

/** Collect response metadata without reading bodies or logging signed URLs. */
export class ChapterAudioMonitor {
  private readonly urls: string[] = [];
  private listening = false;

  private readonly onResponse = (response: Response): void => {
    try {
      const info: AudioResponseInfo = {
        url: response.url(),
        status: response.status(),
        contentType: response.headers()['content-type'],
      };
      if (isAudioResponse(info)) this.urls.push(info.url);
    } catch {
      // A response can disappear during navigation; recording it is optional.
    }
  };

  constructor(private readonly page: Pick<Page, 'on' | 'off'>) {}

  start(): void {
    if (this.listening) return;
    this.page.on('response', this.onResponse);
    this.listening = true;
  }

  checkpoint(): number {
    return this.urls.length;
  }

  since(checkpoint: number): string[] {
    return [...new Set(this.urls.slice(checkpoint))];
  }

  stop(): void {
    if (!this.listening) return;
    this.page.off('response', this.onResponse);
    this.listening = false;
  }
}
