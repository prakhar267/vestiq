import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { T, audit } from '../lib/db';
import { newId } from '../lib/util';

/**
 * Outbound hop-out.
 *
 * Open-redirect safety: the destination is read from our own database by product
 * id. No user-supplied URL is ever honoured — that is the entire defence, and it
 * is why there is no `?url=` parameter on this route.
 */

export const goRoutes = new Hono<{ Bindings: Env; Variables: { session: SessionData } }>();

goRoutes.get('/go/:id', async (c) => {
  const id = c.req.param('id');
  const session = c.get('session');

  const row = await c.env.DB.prepare(
    `SELECT p.id, p.url, p.brand_id, b.status AS brand_status
     FROM ${T.products} p
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.id = ? AND p.status != 'hidden'`,
  )
    .bind(id)
    .first<{
      id: string;
      url: string;
      brand_id: string;
      brand_status: string;
    }>();

  if (!row || row.brand_status !== 'active') {
    return c.redirect('/?e=gone', 302);
  }

  // Destination must be an absolute https URL we stored ourselves.
  try {
    const parsed = new URL(row.url);
    if (parsed.protocol !== 'https:') throw new Error('non-https');
  } catch {
    return c.redirect('/?e=badlink', 302);
  }

  const clickId = newId('c');
  const queryHash = c.req.query('q') ?? null;
  const position = parseInt(c.req.query('pos') ?? '', 10);
  // Free, non-commercial click analytics happen off the critical path — the
  // shopper is already on their way to the brand.
  c.executionCtx.waitUntil(
    recordClick(c.env, {
      clickId,
      productId: row.id,
      brandId: row.brand_id,
      sessionId: session?.id ?? null,
      userId: session?.user_id ?? null,
      queryHash,
      position: Number.isFinite(position) ? position : null,
    }),
  );

  return c.redirect(row.url, 302);
});

interface ClickInput {
  clickId: string;
  productId: string;
  brandId: string;
  sessionId: string | null;
  userId: string | null;
  queryHash: string | null;
  position: number | null;
}

async function recordClick(env: Env, input: ClickInput): Promise<void> {
  const now = Date.now();
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO ${T.clicks}
         (id, ts, product_id, brand_id, session_id, user_id, query_hash, position,
          promoted, price_at_click, cpc_paise, converted, order_value, commission, settled)
         VALUES (?,?,?,?,?,?,?,?,0,NULL,0,0,NULL,NULL,0)`,
      ).bind(
        input.clickId,
        now,
        input.productId,
        input.brandId,
        input.sessionId,
        input.userId,
        input.queryHash,
        input.position,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO ${T.events} (ts, type, session_id, user_id, product_id, brand_id, query_hash, position, meta)
         VALUES (?,'hop_out',?,?,?,?,?,?,'{}')`,
      ).bind(
        now,
        input.sessionId,
        input.userId,
        input.productId,
        input.brandId,
        input.queryHash,
        input.position,
      ),
      // Engagement feeds ranking (popularityFactor). Clicks are the strongest
      // signal we have without conversion data.
      env.DB.prepare(
        `UPDATE ${T.products} SET popularity = popularity + 1.0 WHERE id = ?`,
      ).bind(input.productId),
    ];

    await env.DB.batch(statements);
  } catch (err) {
    await audit(env, 'system', 'click_record_failed', input.productId, {
      error: String(err),
    });
  }
}
