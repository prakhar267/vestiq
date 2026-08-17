import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../types';
import { T, audit } from '../lib/db';
import { esc, formatINR, newId, sha256Hex, slugify, timeAgo, truncate } from '../lib/util';
import { layout } from '../ui/layout';
import { sectionHead } from '../ui/components';
import { enqueueJob } from '../jobs';

type Merchant = {
  id: string;
  brand_id: string;
  email: string;
  feed_url: string | null;
  feed_type: string;
  feed_status: string;
  last_sync_at: number | null;
  status: string;
  brand_name: string;
  brand_slug: string;
};

type Ctx = {
  Bindings: Env;
  Variables: { app: AppContext; merchant?: Merchant };
};

export const merchantRoutes = new Hono<Ctx>();

const COOKIE = 'vq_merch';

/** API keys are stored only as SHA-256; the plaintext is shown once at signup. */
async function resolveMerchant(env: Env, apiKey: string): Promise<Merchant | null> {
  if (!/^vq_[A-Za-z0-9_-]{24,60}$/.test(apiKey)) return null;
  const hash = await sha256Hex(apiKey);
  try {
    return await env.DB.prepare(
      `SELECT m.id, m.brand_id, m.email, m.feed_url, m.feed_type, m.feed_status,
              m.last_sync_at, m.status, b.name AS brand_name, b.slug AS brand_slug
       FROM ${T.merchants} m JOIN ${T.brands} b ON b.id = m.brand_id
       WHERE m.api_key_hash = ?`,
    )
      .bind(hash)
      .first<Merchant>();
  } catch {
    return null;
  }
}

merchantRoutes.use('/merchant/*', async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const match = /(?:^|;\s*)vq_merch=([^;]+)/.exec(cookie);
  if (match) {
    const merchant = await resolveMerchant(c.env, decodeURIComponent(match[1]));
    if (merchant) c.set('merchant', merchant);
  }
  return next();
});

function shell(c: { env: Env; var: { app: AppContext; merchant?: Merchant } }, title: string, body: string): string {
  const m = c.var.merchant;
  return layout(
    {
      env: c.env,
      title: `${title} — ${c.env.SITE_NAME} for brands`,
      description: 'Manage your brand on Vestiq.',
      path: '/merchant',
      nonce: c.var.app.nonce,
      noindex: true,
    },
    `<div class="wrap"><section class="section">
      ${
        m
          ? `<nav class="chips" style="margin-bottom:var(--s6)">
              <a class="chip" href="/merchant">Dashboard</a>
              <a class="chip" href="/merchant/feed">Feed</a>
              <a class="chip" href="/merchant/demand">Demand</a>
              <a class="chip" href="/merchant/promote">Promote</a>
              <a class="chip" href="/merchant/payouts">Payouts</a>
              <form method="POST" action="/merchant/logout" style="display:inline">
                <button class="chip" type="submit">Sign out</button></form>
            </nav>
            <p class="eyebrow">${esc(m.brand_name)}${m.status !== 'approved' ? ` · <span class="badge warn">${esc(m.status)}</span>` : ''}</p>`
          : ''
      }
      ${body}
    </section></div>`,
  );
}

function requireMerchant(c: { var: { merchant?: Merchant } }): Merchant | null {
  return c.var.merchant ?? null;
}

// ---------------------------------------------------------------- signup

merchantRoutes.get('/merchant/signup', (c) =>
  c.html(
    shell(
      c,
      'List your brand',
      `<h1>List your brand</h1>
      <p class="muted" style="max-width:60ch;margin-top:var(--s3)">
        Paste your store URL. If you're on Shopify we'll find your product feed
        automatically — no development work needed. Listing is free.
      </p>
      <form method="POST" action="/merchant/signup" style="max-width:520px;margin-top:var(--s6)">
        <label class="field"><span>Brand name</span>
          <input type="text" name="brand_name" required maxlength="80"></label>
        <label class="field"><span>Store URL</span>
          <input type="url" name="store_url" placeholder="https://yourbrand.com" required></label>
        <label class="field"><span>Your email</span>
          <input type="email" name="email" required maxlength="200"></label>
        <label class="field"><span>Your name</span>
          <input type="text" name="contact_name" maxlength="80"></label>
        <label class="field"><span>City</span>
          <input type="text" name="city" maxlength="60"></label>
        <button class="btn btn-primary btn-block" type="submit">Create account</button>
        <p class="tiny" style="margin-top:var(--s3)">
          By continuing you confirm you're authorised to list this brand's catalogue
          and agree to our <a href="/terms">terms</a>.
        </p>
      </form>`,
    ),
  ),
);

const SignupSchema = z.object({
  brand_name: z.string().min(2).max(80),
  store_url: z.string().url().max(300),
  email: z.string().email().max(200),
  contact_name: z.string().max(80).optional(),
  city: z.string().max(60).optional(),
});

merchantRoutes.post('/merchant/signup', async (c) => {
  const form = await c.req.formData();
  const parsed = SignupSchema.safeParse({
    brand_name: form.get('brand_name'),
    store_url: form.get('store_url'),
    email: form.get('email'),
    contact_name: form.get('contact_name') || undefined,
    city: form.get('city') || undefined,
  });
  if (!parsed.success) {
    return c.html(shell(c, 'List your brand', `<div class="notice bad">Please check the form and try again.</div>`), 400);
  }
  const data = parsed.data;

  let domain: string;
  try {
    const u = new URL(data.store_url);
    if (u.protocol !== 'https:') throw new Error('https required');
    domain = u.hostname.toLowerCase();
  } catch {
    return c.html(shell(c, 'List your brand', `<div class="notice bad">Store URL must be a valid https:// address.</div>`), 400);
  }

  const existing = await c.env.DB.prepare(`SELECT id FROM ${T.merchants} WHERE email = ?`)
    .bind(data.email)
    .first<{ id: string }>();
  if (existing) {
    return c.html(
      shell(c, 'List your brand', `<div class="notice">That email is already registered. <a href="/merchant/login">Sign in instead</a>.</div>`),
      409,
    );
  }

  const apiKey = `vq_${newId('', 32)}`;
  const brandId = newId('b');
  const merchantId = newId('m');
  const now = Date.now();

  // Slug collisions are possible across brands with similar names; suffix on conflict.
  let slug = slugify(data.brand_name);
  const slugTaken = await c.env.DB.prepare(`SELECT id FROM ${T.brands} WHERE slug = ?`)
    .bind(slug)
    .first<{ id: string }>();
  if (slugTaken) slug = `${slug}-${newId('', 4)}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ${T.brands}
        (id, slug, name, domain, city, country, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'IN', 'pending', ?, ?)`,
    ).bind(brandId, slug, data.brand_name, domain, data.city ?? null, now, now),
    c.env.DB.prepare(
      `INSERT INTO ${T.merchants}
        (id, brand_id, email, contact_name, api_key_hash, api_key_hint, feed_url, feed_type,
         feed_status, status, created_at, next_sync_at)
       VALUES (?,?,?,?,?,?,?, 'shopify', 'pending', 'pending', ?, ?)`,
    ).bind(
      merchantId,
      brandId,
      data.email,
      data.contact_name ?? null,
      await sha256Hex(apiKey),
      apiKey.slice(-4),
      // Shopify exposes /products.json on every store; a safe default guess the
      // merchant can correct on the feed page.
      `https://${domain}/products.json`,
      now,
      now,
    ),
  ]);

  await audit(c.env, `merchant:${merchantId}`, 'merchant_signup', brandId, { domain });

  const secure = new URL(c.req.url).protocol === 'https:';
  return c.html(
    layout(
      {
        env: c.env,
        title: 'Account created',
        description: 'Save your API key.',
        path: '/merchant/signup',
        nonce: c.var.app.nonce,
        noindex: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <h1>You're in.</h1>
        <div class="notice good" style="margin-top:var(--s5)">
          <strong>Save this API key now — it is shown once and we only store a hash.</strong>
          <p style="margin:var(--s3) 0 0"><code style="font-size:1rem;word-break:break-all">${esc(apiKey)}</code></p>
        </div>
        <p class="muted">We've guessed your product feed as
          <code>https://${esc(domain)}/products.json</code>. Check it on the
          <a href="/merchant/feed">feed page</a> and we'll start indexing.</p>
        <p class="muted">Your brand is <strong>pending review</strong>. We approve
          brands within one business day; your products stay hidden until then.</p>
        <p><a class="btn btn-primary" href="/merchant">Go to dashboard</a></p>
      </section></div>`,
    ),
    201,
    {
      'set-cookie': `${COOKIE}=${encodeURIComponent(apiKey)}; Path=/merchant; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
    } as never,
  );
});

// ---------------------------------------------------------------- login

merchantRoutes.get('/merchant/login', (c) =>
  c.html(
    shell(
      c,
      'Sign in',
      `<h1>Brand sign in</h1>
      <form method="POST" action="/merchant/login" style="max-width:440px;margin-top:var(--s5)">
        <label class="field"><span>API key</span>
          <input type="password" name="api_key" required autocomplete="current-password"
            placeholder="vq_…"></label>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        <p class="tiny" style="margin-top:var(--s3)">
          Lost your key? Email <a href="mailto:brands@vestiq.in">brands@vestiq.in</a> and we'll rotate it.
        </p>
      </form>
      <p class="muted" style="margin-top:var(--s6)">New here? <a href="/merchant/signup">List your brand</a>.</p>`,
    ),
  ),
);

merchantRoutes.post('/merchant/login', async (c) => {
  const form = await c.req.formData();
  const apiKey = String(form.get('api_key') ?? '');
  const merchant = await resolveMerchant(c.env, apiKey);
  if (!merchant) {
    await audit(c.env, 'anonymous', 'merchant_login_failed', undefined, {}, c.req.header('cf-connecting-ip'));
    return c.html(shell(c, 'Sign in', `<div class="notice bad">That key isn't valid.</div>`), 401);
  }
  const secure = new URL(c.req.url).protocol === 'https:';
  c.header(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(apiKey)}; Path=/merchant; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
  );
  return c.redirect('/merchant', 302);
});

merchantRoutes.post('/merchant/logout', (c) => {
  c.header('set-cookie', `${COOKIE}=; Path=/merchant; HttpOnly; SameSite=Lax; Max-Age=0`);
  return c.redirect('/merchant/login', 302);
});

// ---------------------------------------------------------------- dashboard

merchantRoutes.get('/merchant', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);

  const week = Date.now() - 7 * 86_400_000;
  const [skus, impressions, clicks, spend, lastRun] = await Promise.all([
    num(c.env, `SELECT COUNT(*) AS n FROM ${T.products} WHERE brand_id = ? AND status = 'active'`, [m.brand_id]),
    num(c.env, `SELECT COUNT(*) AS n FROM ${T.events} WHERE brand_id = ? AND type = 'impression' AND ts > ?`, [m.brand_id, week]),
    num(c.env, `SELECT COUNT(*) AS n FROM ${T.clicks} WHERE brand_id = ? AND ts > ?`, [m.brand_id, week]),
    num(c.env, `SELECT COALESCE(SUM(cpc_paise),0) AS n FROM ${T.clicks} WHERE brand_id = ? AND ts > ?`, [m.brand_id, week]),
    c.env.DB.prepare(
      `SELECT * FROM ${T.feedRuns} WHERE brand_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
      .bind(m.brand_id)
      .first<Record<string, unknown>>(),
  ]);

  return c.html(
    shell(
      c,
      'Dashboard',
      `<h1>Dashboard</h1>
      ${
        m.status !== 'approved'
          ? `<div class="notice warn" style="margin-top:var(--s4)">Your brand is pending review. Products stay hidden from shoppers until we approve it.</div>`
          : ''
      }
      <div class="stat-row" style="margin-top:var(--s6)">
        <div class="stat"><div class="label">Live SKUs</div><div class="value">${skus}</div></div>
        <div class="stat"><div class="label">Impressions 7d</div><div class="value">${impressions.toLocaleString('en-IN')}</div></div>
        <div class="stat"><div class="label">Clicks 7d</div><div class="value">${clicks.toLocaleString('en-IN')}</div></div>
        <div class="stat"><div class="label">Ad spend 7d</div><div class="value">${esc(formatINR(spend))}</div></div>
      </div>
      ${sectionHead('Feed health')}
      ${
        lastRun
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Run</th><th>Status</th><th class="num">In</th><th class="num">Live</th>
                <th class="num">Rejected</th></tr></thead>
              <tbody><tr>
                <td>${esc(timeAgo(Number(lastRun.started_at)))}</td>
                <td><span class="badge ${lastRun.status === 'ok' ? 'good' : 'bad'}">${esc(String(lastRun.status))}</span></td>
                <td class="num">${Number(lastRun.rows_in)}</td>
                <td class="num">${Number(lastRun.rows_upserted)}</td>
                <td class="num">${Number(lastRun.rows_rejected)}</td>
              </tr></tbody></table></div>
            ${
              Number(lastRun.rows_rejected) > 0
                ? `<div class="notice" style="margin-top:var(--s4)">
                    <strong>${Number(lastRun.rows_rejected)} items were rejected.</strong>
                    <p style="margin:var(--s2) 0 0" class="tiny">${esc(String(lastRun.reject_reasons ?? '{}'))}</p>
                    <p style="margin:var(--s2) 0 0" class="tiny">Fix these in your feed and they'll appear on the next sync.</p>
                  </div>`
                : ''
            }`
          : `<p class="muted">No sync has run yet. <a href="/merchant/feed">Check your feed URL</a>.</p>`
      }`,
    ),
  );
});

// ---------------------------------------------------------------- feed

merchantRoutes.get('/merchant/feed', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);

  const runs = await c.env.DB.prepare(
    `SELECT * FROM ${T.feedRuns} WHERE brand_id = ? ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(m.brand_id)
    .all<Record<string, unknown>>();

  return c.html(
    shell(
      c,
      'Feed',
      `<h1>Product feed</h1>
      <form method="POST" action="/merchant/feed" style="max-width:560px;margin-top:var(--s5)">
        <label class="field"><span>Feed URL</span>
          <input type="url" name="feed_url" value="${esc(m.feed_url ?? '')}" required></label>
        <label class="field"><span>Format</span>
          <select name="feed_type">
            ${[
              ['shopify', 'Shopify products.json'],
              ['gmc', 'Google Merchant Center XML'],
              ['csv', 'CSV'],
            ]
              .map(
                ([v, l]) =>
                  `<option value="${v}"${m.feed_type === v ? ' selected' : ''}>${esc(l)}</option>`,
              )
              .join('')}
          </select></label>
        <button class="btn btn-primary" type="submit">Save &amp; sync now</button>
      </form>
      <div class="notice" style="margin-top:var(--s5);max-width:560px">
        <strong>CSV columns we accept:</strong>
        <p class="tiny" style="margin:var(--s2) 0 0">
          <code>id, title, description, category, price, mrp, url, image_url, colors,
          sizes, materials, availability, gender</code> — prices in rupees,
          multi-value fields pipe-separated.
        </p>
      </div>
      ${sectionHead('Sync history')}
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Status</th><th class="num">In</th><th class="num">Live</th>
          <th class="num">Skipped</th><th class="num">Rejected</th><th>Error</th></tr></thead>
        <tbody>${(runs.results ?? [])
          .map(
            (r) => `<tr>
              <td>${esc(timeAgo(Number(r.started_at)))}</td>
              <td><span class="badge ${r.status === 'ok' ? 'good' : r.status === 'failed' ? 'bad' : 'warn'}">${esc(String(r.status))}</span></td>
              <td class="num">${Number(r.rows_in)}</td>
              <td class="num">${Number(r.rows_upserted)}</td>
              <td class="num">${Number(r.rows_skipped)}</td>
              <td class="num">${Number(r.rows_rejected)}</td>
              <td class="tiny">${esc(truncate(String(r.error ?? ''), 60))}</td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted">No syncs yet.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

merchantRoutes.post('/merchant/feed', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);

  const form = await c.req.formData();
  const feedUrl = String(form.get('feed_url') ?? '');
  const feedType = String(form.get('feed_type') ?? 'shopify');
  if (!['shopify', 'gmc', 'csv'].includes(feedType)) return c.text('bad feed type', 400);

  try {
    const u = new URL(feedUrl);
    if (u.protocol !== 'https:') throw new Error('https required');
  } catch {
    return c.html(shell(c, 'Feed', `<div class="notice bad">Feed URL must be a valid https:// address.</div>`), 400);
  }

  await c.env.DB.prepare(
    `UPDATE ${T.merchants} SET feed_url = ?, feed_type = ?, feed_status = 'pending', next_sync_at = ? WHERE id = ?`,
  )
    .bind(feedUrl, feedType, Date.now(), m.id)
    .run();

  await enqueueJob(c.env, 'feed_sync', { merchant_id: m.id, brand_id: m.brand_id });
  await audit(c.env, `merchant:${m.id}`, 'feed_updated', m.brand_id, { feedType });

  return c.redirect('/merchant/feed', 302);
});

// ---------------------------------------------------------------- demand (T3)

merchantRoutes.get('/merchant/demand', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);
  const week = Date.now() - 7 * 86_400_000;

  // Queries that produced clicks on this brand.
  const won = await c.env.DB.prepare(
    `SELECT s.query_raw, COUNT(*) AS n
     FROM ${T.clicks} cl JOIN ${T.searches} s ON s.query_hash = cl.query_hash
     WHERE cl.brand_id = ? AND cl.ts > ?
     GROUP BY s.query_hash ORDER BY n DESC LIMIT 25`,
  )
    .bind(m.brand_id, week)
    .all<{ query_raw: string; n: number }>();

  // The gap report: demand in this brand's categories that they did not win.
  const gap = await c.env.DB.prepare(
    `SELECT s.query_raw, COUNT(*) AS n
     FROM ${T.searches} s
     WHERE s.ts > ? AND s.result_count > 0
       AND NOT EXISTS (
         SELECT 1 FROM ${T.clicks} cl
         WHERE cl.query_hash = s.query_hash AND cl.brand_id = ?
       )
       AND EXISTS (
         SELECT 1 FROM ${T.products} p
         WHERE p.brand_id = ? AND p.status = 'active'
           AND s.parse LIKE '%"' || p.category || '"%'
       )
     GROUP BY s.query_hash ORDER BY n DESC LIMIT 25`,
  )
    .bind(week, m.brand_id, m.brand_id)
    .all<{ query_raw: string; n: number }>();

  return c.html(
    shell(
      c,
      'Demand',
      `<h1>Demand</h1>
      <p class="muted" style="max-width:64ch">What shoppers actually typed. The gap report is
      the useful half: searches in your categories where someone else got the click.</p>
      ${sectionHead('Queries you won')}
      <div class="table-wrap"><table>
        <thead><tr><th>Query</th><th class="num">Clicks</th></tr></thead>
        <tbody>${(won.results ?? [])
          .map((r) => `<tr><td>${esc(truncate(r.query_raw, 64))}</td><td class="num">${r.n}</td></tr>`)
          .join('') || '<tr><td colspan="2" class="muted">No clicks yet this week.</td></tr>'}</tbody>
      </table></div>
      ${sectionHead('Demand you missed')}
      <div class="table-wrap"><table>
        <thead><tr><th>Query</th><th class="num">Searches</th><th></th></tr></thead>
        <tbody>${(gap.results ?? [])
          .map(
            (r) => `<tr><td>${esc(truncate(r.query_raw, 64))}</td><td class="num">${r.n}</td>
              <td><a href="/search?q=${encodeURIComponent(r.query_raw)}">see results</a></td></tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">Nothing obvious — good sign.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

// ---------------------------------------------------------------- promote (T2)

merchantRoutes.get('/merchant/promote', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);

  const promos = await c.env.DB.prepare(
    `SELECT * FROM ${T.promotions} WHERE brand_id = ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(m.brand_id)
    .all<Record<string, unknown>>();

  return c.html(
    shell(
      c,
      'Promote',
      `<h1>Promoted placement</h1>
      <div class="notice" style="max-width:64ch">
        Promoted items appear in at most <strong>2 of 24</strong> slots and are always
        labelled &ldquo;Promoted&rdquo;. Paid placement never changes the ranking of
        organic results — that's a hard rule, enforced in code.
      </div>
      <form method="POST" action="/merchant/promote" style="max-width:440px;margin-top:var(--s5)">
        <label class="field"><span>Bid per click (₹)</span>
          <input type="number" name="bid_rupees" min="2" max="200" step="1" value="7" required></label>
        <label class="field"><span>Total budget (₹)</span>
          <input type="number" name="budget_rupees" min="500" max="1000000" step="100" value="5000" required></label>
        <button class="btn btn-primary btn-block" type="submit">Start campaign</button>
      </form>
      ${sectionHead('Campaigns')}
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Status</th><th class="num">Bid</th><th class="num">Budget</th>
          <th class="num">Spent</th></tr></thead>
        <tbody>${(promos.results ?? [])
          .map(
            (p) => `<tr>
              <td>${esc(timeAgo(Number(p.created_at)))}</td>
              <td><span class="badge ${p.status === 'active' ? 'good' : ''}">${esc(String(p.status))}</span></td>
              <td class="num">${esc(formatINR(Number(p.bid_paise)))}</td>
              <td class="num">${esc(formatINR(Number(p.budget_paise)))}</td>
              <td class="num">${esc(formatINR(Number(p.spent_paise)))}</td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">No campaigns.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

merchantRoutes.post('/merchant/promote', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);
  if (m.status !== 'approved') {
    return c.html(shell(c, 'Promote', `<div class="notice bad">Your brand must be approved before running campaigns.</div>`), 403);
  }

  const form = await c.req.formData();
  const bid = Math.round(Number(form.get('bid_rupees')) * 100);
  const budget = Math.round(Number(form.get('budget_rupees')) * 100);
  if (!Number.isFinite(bid) || bid < 200 || bid > 20_000) return c.text('bad bid', 400);
  if (!Number.isFinite(budget) || budget < 50_000 || budget > 100_000_000) return c.text('bad budget', 400);

  await c.env.DB.prepare(
    `INSERT INTO ${T.promotions}
      (id, brand_id, product_id, bid_paise, budget_paise, status, starts_at, created_at)
     VALUES (?,?,NULL,?,?, 'active', ?, ?)`,
  )
    .bind(newId('pr'), m.brand_id, bid, budget, Date.now(), Date.now())
    .run();

  await audit(c.env, `merchant:${m.id}`, 'promotion_created', m.brand_id, { bid, budget });
  return c.redirect('/merchant/promote', 302);
});

// ---------------------------------------------------------------- payouts

merchantRoutes.get('/merchant/payouts', async (c) => {
  const m = requireMerchant(c);
  if (!m) return c.redirect('/merchant/login', 302);

  const rows = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', ts/1000, 'unixepoch') AS month,
            COUNT(*) AS clicks,
            SUM(converted) AS orders,
            COALESCE(SUM(order_value),0) AS gmv,
            COALESCE(SUM(commission),0) AS commission,
            COALESCE(SUM(cpc_paise),0) AS ad_spend
     FROM ${T.clicks} WHERE brand_id = ?
     GROUP BY month ORDER BY month DESC LIMIT 12`,
  )
    .bind(m.brand_id)
    .all<Record<string, unknown>>();

  return c.html(
    shell(
      c,
      'Payouts',
      `<h1>Payouts</h1>
      <p class="muted">Commission we've earned on referred orders, and what you owe for
      promoted clicks. Settled monthly.</p>
      <div class="table-wrap" style="margin-top:var(--s5)"><table>
        <thead><tr><th>Month</th><th class="num">Clicks</th><th class="num">Orders</th>
          <th class="num">GMV</th><th class="num">Our commission</th><th class="num">Ad spend</th></tr></thead>
        <tbody>${(rows.results ?? [])
          .map(
            (r) => `<tr>
              <td>${esc(String(r.month))}</td>
              <td class="num">${Number(r.clicks)}</td>
              <td class="num">${Number(r.orders ?? 0)}</td>
              <td class="num">${esc(formatINR(Number(r.gmv)))}</td>
              <td class="num">${esc(formatINR(Number(r.commission)))}</td>
              <td class="num">${esc(formatINR(Number(r.ad_spend)))}</td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="6" class="muted">No activity yet.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

async function num(env: Env, sql: string, binds: unknown[]): Promise<number> {
  try {
    const row = await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number | null }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}
