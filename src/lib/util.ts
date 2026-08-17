/** Small, dependency-free primitives. Kept pure so they're trivially testable. */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** URL-safe random id. 20 chars ≈ 103 bits of entropy. */
export function newId(prefix = '', len = 20): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Timing-safe string compare. Guards the admin token and merchant API keys
 * against timing oracles.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare lengths in constant time too, by folding into the accumulator.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export const now = (): number => Date.now();

// ---------------------------------------------------------------- money
// Money is always integer paise. These are the only two conversion points.

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** "₹2,199" — no decimals, because Indian fashion prices are whole rupees. */
export function formatINR(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return '—';
  const rupees = Math.round(paise / 100);
  return '₹' + rupees.toLocaleString('en-IN');
}

/** Discount percentage, floored. Returns 0 when there is no genuine discount. */
export function discountPct(price: number, mrp: number | null | undefined): number {
  if (!mrp || mrp <= price) return 0;
  return Math.floor(((mrp - price) / mrp) * 100);
}

// ---------------------------------------------------------------- text

export function slugify(input: string, maxLen = 80): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'item').slice(0, maxLen).replace(/-+$/g, '');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape for HTML text and double-quoted attribute contexts. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Escape for embedding data inside a <script> block (JSON-LD, state hydration). */
export function escJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Collapse whitespace, lowercase, strip punctuation — for cache keys. */
export function normaliseQuery(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}₹\s.<>-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Escape a user string for use inside an FTS5 MATCH expression.
 * FTS5 treats many characters as operators; the only robust approach is to
 * wrap each token in double quotes (doubling any internal quote).
 */
export function ftsQuote(token: string): string {
  return '"' + token.replace(/"/g, '""') + '"';
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** Chunk an array into fixed-size batches (embedding calls, SQL IN lists). */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Race a promise against a timeout, resolving to `fallback` if it loses. */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Relative time for "verified 2h ago". */
export function timeAgo(ts: number | null | undefined, ref = Date.now()): string {
  if (!ts) return 'unknown';
  const s = Math.max(0, Math.floor((ref - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Crawler detection. Only used to skip personalisation and to serve the
 * paginated (non-infinite-scroll) variant — never to serve different content,
 * which would be cloaking.
 */
export function isBotUA(ua: string): boolean {
  return /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest|vkshare|w3c_validator|lighthouse|gptbot|claudebot|perplexity/i.test(
    ua,
  );
}
