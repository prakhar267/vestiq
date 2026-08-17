import type { Env, SessionData } from '../types';
import { newId, now } from './util';

const COOKIE = 'vq_sid';
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90-day sliding window
/** Only re-write KV when the session is this stale, to stay inside free-tier writes. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Session ids are opaque, 32 chars of [0-9a-z]. Reject anything else outright. */
function isValidSid(sid: string): boolean {
  return /^[0-9a-z]{32}$/.test(sid);
}

export function sessionCookie(sid: string, secure: boolean): string {
  const attrs = [
    `${COOKIE}=${sid}`,
    'Path=/',
    `Max-Age=${TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export interface ResolvedSession {
  session: SessionData;
  /** Set when a cookie must be written back on the response. */
  setCookie?: string;
  /** True when KV should be written (caller does this in waitUntil). */
  dirty: boolean;
}

/**
 * Resolve the session from the request, minting a fresh anonymous one when
 * absent or invalid (ADR-8: everything works before sign-in).
 */
export async function resolveSession(req: Request, env: Env): Promise<ResolvedSession> {
  const secure = new URL(req.url).protocol === 'https:';
  const sid = parseCookies(req.headers.get('cookie'))[COOKIE];

  if (sid && isValidSid(sid)) {
    try {
      const raw = await env.SESSIONS.get(sid, 'json');
      if (raw) {
        const session = raw as SessionData;
        const stale = now() - (session.last_seen_at ?? 0) > TOUCH_INTERVAL_MS;
        if (stale) session.last_seen_at = now();
        return { session, dirty: stale };
      }
    } catch {
      // KV read failure must not block the request; fall through to a new session.
    }
    // Valid-looking id with no stored data (expired): reuse the id so the
    // user's cookie stays stable, but rebuild the record.
    const session: SessionData = {
      id: sid,
      created_at: now(),
      last_seen_at: now(),
      recent_queries: [],
    };
    return { session, dirty: true };
  }

  const session: SessionData = {
    id: newId('', 32),
    created_at: now(),
    last_seen_at: now(),
    recent_queries: [],
  };
  return { session, setCookie: sessionCookie(session.id, secure), dirty: true };
}

export async function saveSession(env: Env, session: SessionData): Promise<void> {
  try {
    await env.SESSIONS.put(session.id, JSON.stringify(session), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    // Best-effort: a dropped session write costs personalisation, not correctness.
  }
}

/** Records a query in the session's recent list (most-recent-first, capped at 12). */
export function pushRecentQuery(session: SessionData, query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  const existing = session.recent_queries ?? [];
  if (existing[0] === q) return false;
  session.recent_queries = [q, ...existing.filter((x) => x !== q)].slice(0, 12);
  return true;
}

/**
 * The owner key for saves/alerts/intents. Anonymous work is keyed on the
 * session; after sign-in it is keyed on the user, and `mergeOwner` moves rows
 * across so nothing is lost.
 */
export function ownerKey(session: SessionData): string {
  return session.user_id ? `u:${session.user_id}` : session.id;
}

/**
 * Merge anonymous state into a user account on sign-in.
 * `INSERT OR IGNORE` then delete: if the user already saved an item on another
 * device, keep theirs and discard the duplicate rather than failing the merge.
 */
export async function mergeOwner(env: Env, fromKey: string, toKey: string): Promise<void> {
  if (fromKey === toKey) return;
  const { T } = await import('./db');
  const stmts = [
    `INSERT OR IGNORE INTO ${T.saves} (id, owner_key, product_id, note, created_at)
       SELECT id, ?, product_id, note, created_at FROM ${T.saves} WHERE owner_key = ?`,
    `DELETE FROM ${T.saves} WHERE owner_key = ?`,
    `INSERT OR IGNORE INTO ${T.alerts}
       (id, owner_key, product_id, kind, target_price, base_price, email, status, created_at, fired_at)
       SELECT id, ?, product_id, kind, target_price, base_price, email, status, created_at, fired_at
       FROM ${T.alerts} WHERE owner_key = ?`,
    `DELETE FROM ${T.alerts} WHERE owner_key = ?`,
    `INSERT OR IGNORE INTO ${T.savedIntents}
       (id, owner_key, label, query_raw, parse, email, last_run_at, last_count, seen_ids, status, created_at)
       SELECT id, ?, label, query_raw, parse, email, last_run_at, last_count, seen_ids, status, created_at
       FROM ${T.savedIntents} WHERE owner_key = ?`,
    `DELETE FROM ${T.savedIntents} WHERE owner_key = ?`,
  ];
  await env.DB.batch([
    env.DB.prepare(stmts[0]).bind(toKey, fromKey),
    env.DB.prepare(stmts[1]).bind(fromKey),
    env.DB.prepare(stmts[2]).bind(toKey, fromKey),
    env.DB.prepare(stmts[3]).bind(fromKey),
    env.DB.prepare(stmts[4]).bind(toKey, fromKey),
    env.DB.prepare(stmts[5]).bind(fromKey),
  ]);
}
