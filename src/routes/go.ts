import { Hono } from 'hono';
import type { Env, SessionData } from '../types';
import { T, audit } from '../lib/db';
import { newId } from '../lib/util';

/**
 * Outbound hop-out (the monetised action, T1).
 *
 * Open-redirect safety: the destination is read from our own database by product
 * id. No user-supplied URL is ever honoured — that is the entire defence, and it
 * is why there is no `?url=` parameter on this route.
 */

export const goRoutes = new Hono<{ Bindings: Env; Variables: { session: SessionData } }>();

/** Apply a brand's affiliate wrapper, if configured. */
export function affiliateUrl(productUrl: string, template: string | null): string {
  if (!template) return productUrl;
  if (!template.includes('{url}')) return productUrl;
  try {
    // Validate the result before handing it to the browser.
    const built = template.replace('{url}', encodeURIComponent(productUrl));
    const parsed = new URL(built);
    if (parsed.protocol !== 'https:') return productUrl;
    return built;
  } catch {
    return productUrl;
  }
}

goRoutes.get('/go/:id', async (c) => {
  const id = c.req.param('id');
  const session = c.get('session');

  const row = await c.env.DB.prepare(
    `SELECT p.id, p.url, p.price, p.brand_id, b.affiliate_tmpl, b.status AS brand_status
     FROM ${T.products} p
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.id = ? AND p.status != 'hidden'`,
  )
    .bind(id)
    .first<{
      id: string;
      url: string;
      price: number;
      brand_id: string;
      affiliate_tmpl: string | null;
      brand_status: string;
    }>();

  if (!row || row.brand_status !== 'active') {
    return c.redirect('/?e=gone', 302);
  }

  // Destination must be an absolute https URL we stored ourselves.
  let destination: string;
  try {
    const parsed = new URL(row.url);
    if (parsed.protocol !== 'https:') throw new Error('non-https');
    destination = affiliateUrl(row.url, row.affiliate_tmpl);
  } catch {
    return c.redirect('/?e=badlink', 302);
  }

  const clickId = newId('c');
  const queryHash = c.req.query('q') ?? null;
  const position = parseInt(c.req.query('pos') ?? '', 10);
  const promoted = c.req.query('promoted') === '1';

  // Attribution and CPC billing happen off the critical path — the user is
  // already on their way to the merchant.
  c.executionCtx.waitUntil(
    recordClick(c.env, {
      clickId,
      productId: row.id,
      brandId: row.brand_id,
      sessionId: session?.id ?? null,
      userId: session?.user_id ?? null,
      queryHash,
      position: Number.isFinite(position) ? position : null,
      promoted,
      price: row.price,
    }),
  );

  return c.redirect(destination, 302);
});

interface ClickInput {
  clickId: string;
  productId: string;
  brandId: string;
  sessionId: string | null;
  userId: string | null;
  queryHash: string | null;
  position: number | null;
  promoted: boolean;
  price: number;
}

async function recordClick(env: Env, input: ClickInput): Promise<void> {
  const now = Date.now();
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO ${T.clicks}
         (id, ts, product_id, brand_id, session_id, user_id, query_hash, position, promoted, price_at_click, cpc_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
      ).bind(
        input.clickId,
        now,
        input.productId,
        input.brandId,
        input.sessionId,
        input.userId,
        input.queryHash,
        input.position,
        input.promoted ? 1 : 0,
        input.price,
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

    if (input.promoted) {
      // Charge the campaign. The MIN() and the `spent_paise < budget_paise`
      // guard are both in SQL, so concurrent clicks can never overspend a
      // budget even without a transaction around the read.
      statements.push(
        env.DB.prepare(
          `UPDATE ${T.promotions}
           SET spent_paise = MIN(budget_paise, spent_paise + bid_paise),
               status = CASE WHEN spent_paise + bid_paise >= budget_paise THEN 'exhausted' ELSE status END
           WHERE brand_id = ? AND status = 'active'
             AND (product_id = ? OR product_id IS NULL)
             AND spent_paise < budget_paise`,
        ).bind(input.brandId, input.productId),
      );
      // Record what we actually charged, so the merchant ledger reconciles
      // against promotions.spent_paise rather than being inferred later.
      statements.push(
        env.DB.prepare(
          `UPDATE ${T.clicks}
           SET cpc_paise = COALESCE((
             SELECT bid_paise FROM ${T.promotions}
             WHERE brand_id = ? AND (product_id = ? OR product_id IS NULL)
             ORDER BY bid_paise DESC LIMIT 1
           ), 0)
           WHERE id = ?`,
        ).bind(input.brandId, input.productId, input.clickId),
      );
    }

    await env.DB.batch(statements);
  } catch (err) {
    await audit(env, 'system', 'click_record_failed', input.productId, {
      error: String(err),
    });
  }
}
