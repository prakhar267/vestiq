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

export async function rateLimit(
  env: Env,
  ruleName: RuleName,
  identity: string,
): Promise<RateLimitResult> {
  const rule = RULES[ruleName];
  const { limit, windowSeconds } = rule;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / windowSeconds) * windowSeconds;
  const key = `rl:${ruleName}:${identity}:${windowStart}`;
  const prevKey = `rl:${ruleName}:${identity}:${windowStart - windowSeconds}`;
  const resetIn = windowStart + windowSeconds - nowSec;

  try {
    const [curRaw, prevRaw] = await Promise.all([env.CACHE.get(key), env.CACHE.get(prevKey)]);
    const cur = curRaw ? parseInt(curRaw, 10) || 0 : 0;
    const prev = prevRaw ? parseInt(prevRaw, 10) || 0 : 0;

    // Weight the previous window by how much of it still overlaps ours.
    const elapsed = nowSec - windowStart;
    const prevWeight = Math.max(0, 1 - elapsed / windowSeconds);
    const effective = cur + prev * prevWeight;

    if (effective >= limit) {
      return { ok: false, remaining: 0, limit, resetIn };
    }

    await env.CACHE.put(key, String(cur + 1), {
      // Keep two windows alive so the smoothing above has data to read.
      expirationTtl: Math.max(60, windowSeconds * 2),
    });

    return {
      ok: true,
      remaining: Math.max(0, limit - Math.ceil(effective) - 1),
      limit,
      resetIn,
    };
  } catch {
    // Fail open. A KV outage must not take down search; the alternative
    // (fail closed) turns a cache blip into a full outage.
    return { ok: true, remaining: limit, limit, resetIn };
  }
}

/** Identity for limiting: session id when present, else client IP. */
export function rateIdentity(req: Request, sessionId?: string): string {
  if (sessionId) return `s:${sessionId}`;
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  return `i:${ip}`;
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(r.limit),
    'RateLimit-Remaining': String(r.remaining),
    'RateLimit-Reset': String(r.resetIn),
    ...(r.ok ? {} : { 'Retry-After': String(r.resetIn) }),
  };
}
