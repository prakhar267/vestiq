import type { Env } from '../types';

/**
 * Fixed-window rate limiting on KV.
 *
 * Deliberately approximate: KV is eventually consistent, so a client hitting
 * multiple colos can exceed the limit briefly. That is an acceptable trade for
 * zero-cost, zero-dependency abuse control — the goal is to stop runaway
 * scripts and inference-cost blowups, not to be a billing meter.
 *
 * Two windows are checked per call (current + previous, weighted) which smooths
 * the classic fixed-window burst at the boundary.
 *
 * Scale path: swap for a Durable Object or Cloudflare's rate-limiting binding
 * behind this same signature.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the window resets. Used for Retry-After. */
  resetIn: number;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

/** Per-route budgets. AI routes are tightest — they cost real money. */
export const RULES = {
  search: { limit: 60, windowSeconds: 60 },
  ai_parse: { limit: 30, windowSeconds: 60 },
  stylist: { limit: 12, windowSeconds: 60 },
  image_search: { limit: 8, windowSeconds: 300 },
  write: { limit: 40, windowSeconds: 60 },
  merchant_api: { limit: 120, windowSeconds: 60 },
  report: { limit: 5, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

export type RuleName = keyof typeof RULES;

/**
 * A request is constrained independently by both dimensions. The session cap
 * protects an individual browser, while the IP cap prevents a client from
 * minting a fresh budget simply by omitting or rotating its cookie.
 */
export interface RequestRateIdentity {
  ip: string;
  session?: string;
}

export async function rateLimit(
  env: Env,
  ruleName: RuleName,
  identity: RequestRateIdentity | string,
): Promise<RateLimitResult> {
  const rule = RULES[ruleName];
  const { limit, windowSeconds } = rule;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / windowSeconds) * windowSeconds;
  const resetIn = windowStart + windowSeconds - nowSec;

  // The string form is retained for callers/tests that predate dual-dimension
  // identities. New request paths should always use rateIdentity().
  const dimensions =
    typeof identity === 'string'
      ? [identity]
      : [
          `i:${encodeURIComponent(identity.ip)}`,
          ...(identity.session ? [`s:${encodeURIComponent(identity.session)}`] : []),
        ];

  try {
    const states = await Promise.all(
      dimensions.map(async (dimension) => {
        const key = `rl:${ruleName}:${dimension}:${windowStart}`;
        const prevKey = `rl:${ruleName}:${dimension}:${windowStart - windowSeconds}`;
        const [curRaw, prevRaw] = await Promise.all([
          env.CACHE.get(key),
          env.CACHE.get(prevKey),
        ]);
        return {
          key,
          cur: curRaw ? parseInt(curRaw, 10) || 0 : 0,
          prev: prevRaw ? parseInt(prevRaw, 10) || 0 : 0,
        };
      }),
    );

    // Weight the previous window by how much of it still overlaps ours.
    const elapsed = nowSec - windowStart;
    const prevWeight = Math.max(0, 1 - elapsed / windowSeconds);
    const effective = states.map((state) => state.cur + state.prev * prevWeight);

    // Crossing either budget is enough to stop the request. In particular, a
    // fresh session never resets the IP dimension, and changing IP does not
    // weaken the existing session dimension.
    if (effective.some((used) => used >= limit)) {
      return { ok: false, remaining: 0, limit, resetIn };
    }

    await Promise.all(
      states.map((state) =>
        env.CACHE.put(state.key, String(state.cur + 1), {
          // Keep two windows alive so the smoothing above has data to read.
          expirationTtl: Math.max(60, windowSeconds * 2),
        }),
      ),
    );

    return {
      ok: true,
      remaining: Math.max(0, Math.min(...effective.map((used) => limit - Math.ceil(used) - 1))),
      limit,
      resetIn,
    };
  } catch {
    // Fail open. A KV outage must not take down search; the alternative
    // (fail closed) turns a cache blip into a full outage.
    return { ok: true, remaining: limit, limit, resetIn };
  }
}

/**
 * Cloudflare overwrites CF-Connecting-IP at the edge, making it the trustworthy
 * client-address dimension in production. X-Forwarded-For is deliberately not
 * used: a direct client can spoof it. When the edge header is unavailable
 * (local development/service calls), every request shares the conservative
 * `unknown` bucket rather than receiving a mintable identity.
 */
export function rateIdentity(req: Request, sessionId?: string): RequestRateIdentity {
  return {
    ip: normaliseClientIp(req.headers.get('cf-connecting-ip')),
    ...(sessionId?.trim() ? { session: sessionId.trim().slice(0, 128) } : {}),
  };
}

function normaliseClientIp(raw: string | null): string {
  const candidate = (raw ?? '').trim().toLowerCase();
  if (!candidate) return 'unknown';

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    const parts = candidate.split('.').map(Number);
    if (parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return parts.join('.');
    }
    return 'unknown';
  }

  const unwrapped = candidate.startsWith('[') && candidate.endsWith(']')
    ? candidate.slice(1, -1)
    : candidate;
  if (!/^[0-9a-f:]{2,45}$/.test(unwrapped) || !unwrapped.includes(':')) return 'unknown';

  try {
    // URL parsing gives us strict IPv6 validation and a canonical spelling.
    const host = new URL(`https://[${unwrapped}]/`).hostname;
    return host.replace(/^\[|\]$/g, '');
  } catch {
    return 'unknown';
  }
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(r.limit),
    'RateLimit-Remaining': String(r.remaining),
    'RateLimit-Reset': String(r.resetIn),
    ...(r.ok ? {} : { 'Retry-After': String(r.resetIn) }),
  };
}
