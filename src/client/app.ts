/**
 * Client islands.
 *
 * No framework (ADR-1). Everything here is progressive enhancement — the search
 * form, filters and pagination all work with this file blocked. Budget: 24 KB
 * gzipped, enforced by scripts/check-budget.mjs.
 */

// ---------------------------------------------------------------- utilities

const $ = <T extends Element = Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);
const $$ = <T extends Element = Element>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms) as unknown as number;
  };
}

let toastTimer: number | undefined;
function toast(message: string): void {
  const el = $<HTMLElement>('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600) as unknown as number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- image reveal

/** Fade images in once decoded (design §4) rather than shimmering skeletons. */
function initImages(root: ParentNode = document): void {
  for (const img of $$<HTMLImageElement>('.card-media img:not(.loaded)', root)) {
    if (img.complete) img.classList.add('loaded');
    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener(
      'error',
      () => {
        // A dead image is a dead listing signal; hide the frame rather than
        // showing a broken-image glyph.
        img.style.display = 'none';
      },
      { once: true },
    );
  }
}

// ---------------------------------------------------------------- search bar

interface Suggestions {
  recent: string[];
  trending: string[];
  brands: { name: string; slug: string }[];
}

function initSearchBar(bar: HTMLElement): void {
  const form = $<HTMLFormElement>('form', bar);
  const input = $<HTMLTextAreaElement>('textarea', bar);
  const panel = $<HTMLElement>('.suggestions', bar);
  const camera = $<HTMLButtonElement>('[data-camera]', bar);
  if (!form || !input || !panel) return;

  let activeIndex = -1;
  let items: { label: string; href: string }[] = [];

  const close = () => {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  };

  const render = (data: Suggestions) => {
    items = [
      ...data.recent.map((q) => ({ label: q, href: `/search?q=${encodeURIComponent(q)}` })),
      ...data.trending.map((q) => ({ label: q, href: `/search?q=${encodeURIComponent(q)}` })),
      ...data.brands.map((b) => ({ label: b.name, href: `/brand/${b.slug}` })),
    ];
    if (!items.length) {
      close();
      return;
    }

    const group = (title: string, list: { label: string; href: string }[]) =>
      list.length
        ? `<p class="eyebrow group-label">${escapeHtml(title)}</p><ul>${list
            .map(
              (i) =>
                `<li><button type="button" role="option" data-href="${escapeHtml(i.href)}">${escapeHtml(i.label)}</button></li>`,
            )
            .join('')}</ul>`
        : '';

    panel.innerHTML =
      group('Recent', data.recent.map((q) => ({ label: q, href: `/search?q=${encodeURIComponent(q)}` }))) +
      group('Popular', data.trending.map((q) => ({ label: q, href: `/search?q=${encodeURIComponent(q)}` }))) +
      group('Brands', data.brands.map((b) => ({ label: b.name, href: `/brand/${b.slug}` })));

    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIndex = -1;
  };

  const fetchSuggestions = debounce(async () => {
    const q = input.value.trim();
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      render((await res.json()) as Suggestions);
    } catch {
      /* suggestions are optional */
    }
  }, 160);

  input.addEventListener('input', () => {
    // Auto-grow up to the CSS max-height.
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 88)}px`;
    fetchSuggestions();
  });

  input.addEventListener('focus', fetchSuggestions);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        location.href = items[activeIndex].href;
        return;
      }
      if (input.value.trim()) form.submit();
      return;
    }
    if (panel.hidden) return;
    const options = $$<HTMLButtonElement>('button[role="option"]', panel);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex =
        e.key === 'ArrowDown'
          ? Math.min(activeIndex + 1, options.length - 1)
          : Math.max(activeIndex - 1, -1);
      options.forEach((opt, i) =>
        opt.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false'),
      );
      if (activeIndex >= 0) options[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape') {
      close();
    }
  });

  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-href]');
    if (btn) location.href = btn.dataset.href!;
  });

  document.addEventListener('click', (e) => {
    if (!bar.contains(e.target as Node)) close();
  });

  // Image search (U6). The button is hidden server-side and revealed only when
  // JS is present, so it never appears as a dead control.
  if (camera) {
    camera.hidden = false;
    camera.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/jpeg,image/png,image/webp';
      picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) {
          toast('That image is too large (max 6 MB).');
          return;
        }
        toast('Reading your image…');
        const body = new FormData();
        body.append('image', file);
        try {
          const res = await fetch('/api/image-search', { method: 'POST', body });
          const data = (await res.json()) as { redirect?: string; error?: string };
          if (data.redirect) location.href = data.redirect;
          else toast(data.error === 'could_not_read_image' ? "I couldn't read that image." : 'Image search failed.');
        } catch {
          toast('Image search failed.');
        }
      });
      picker.click();
    });
  }
}

// ---------------------------------------------------------------- saves

function initSaves(root: ParentNode = document): void {
  for (const btn of $$<HTMLButtonElement>('[data-save]', root)) {
    if (btn.dataset.bound) continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const productId = btn.dataset.save!;
      const nowSaved = btn.getAttribute('aria-pressed') !== 'true';

      // Optimistic: the network round-trip should not gate the animation.
      btn.setAttribute('aria-pressed', String(nowSaved));
      const labelSpan = $<HTMLElement>('span', btn);
      if (labelSpan) labelSpan.textContent = nowSaved ? 'Saved' : 'Save';

      const res = await postJson<{ ok: boolean }>('/api/save', {
        product_id: productId,
        saved: nowSaved,
      });
      if (!res?.ok) {
        btn.setAttribute('aria-pressed', String(!nowSaved));
        if (labelSpan) labelSpan.textContent = !nowSaved ? 'Saved' : 'Save';
        toast("Couldn't save that — try again.");
      } else {
        toast(nowSaved ? 'Saved' : 'Removed');
      }
    });
  }
}

// ---------------------------------------------------------------- alerts

function initAlerts(): void {
  for (const btn of $$<HTMLButtonElement>('[data-alert]')) {
    btn.addEventListener('click', async () => {
      const productId = btn.dataset.alert!;
      const kind = btn.dataset.kind ?? 'price_drop';
      const res = await postJson<{ ok: boolean; needs_email: boolean }>('/api/alert', {
        product_id: productId,
        kind,
      });
      if (!res?.ok) {
        toast("Couldn't set that alert.");
        return;
      }
      if (res.needs_email) {
        const email = prompt('Where should we email you when this changes?');
        if (email && email.includes('@')) {
          await postJson('/api/alert', { product_id: productId, kind, email });
          toast('Alert set — we’ll email you.');
        } else {
          toast('Alert saved to this browser.');
        }
      } else {
        toast('Alert set.');
      }
    });
  }
}

// ---------------------------------------------------------------- report

const REPORT_REASONS: [string, string][] = [
  ['dead_link', "Link doesn't work"],
  ['out_of_stock', 'Actually out of stock'],
  ['wrong_price', 'Price is wrong'],
  ['spam', 'Spam or not fashion'],
  ['other', 'Something else'],
];

function initReport(): void {
  for (const btn of $$<HTMLButtonElement>('[data-report]')) {
    btn.addEventListener('click', () => {
      const productId = btn.dataset.report!;
      const dialog = document.createElement('dialog');
      dialog.style.cssText =
        'border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s5);max-width:420px;background:var(--surface);color:var(--ink)';
      dialog.innerHTML = `<form method="dialog">
        <h3 style="margin-bottom:var(--s4)">What's wrong with this listing?</h3>
        ${REPORT_REASONS.map(
          ([value, label], i) =>
            `<label style="display:flex;gap:var(--s2);padding:var(--s2) 0;align-items:center">
              <input type="radio" name="reason" value="${value}"${i === 0 ? ' checked' : ''}>
              <span>${escapeHtml(label)}</span></label>`,
        ).join('')}
        <div style="display:flex;gap:var(--s2);margin-top:var(--s5)">
          <button class="btn btn-sm" value="cancel">Cancel</button>
          <button class="btn btn-primary btn-sm" value="send">Send report</button>
        </div>
      </form>`;
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.addEventListener('close', async () => {
        const reason = (dialog.querySelector<HTMLInputElement>('input[name="reason"]:checked')?.value) ?? 'other';
        if (dialog.returnValue === 'send') {
          const res = await postJson<{ ok: boolean }>('/api/report', {
            product_id: productId,
            reason,
          });
          toast(res?.ok ? 'Thanks — we’ll check it.' : "Couldn't send that report.");
        }
        dialog.remove();
      });
    });
  }
}

// ---------------------------------------------------------------- parse chips

/** Removing a chip re-runs the search with that constraint dropped (U7). */
function initChips(): void {
  for (const btn of $$<HTMLButtonElement>('[data-drop]')) {
    btn.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.append('drop', btn.dataset.drop!);
      url.searchParams.delete('page');
      location.href = url.toString();
    });
  }
}

// ---------------------------------------------------------------- infinite scroll

function initInfiniteScroll(): void {
  const results = $<HTMLElement>('#results');
  if (!results) return;
  const query = results.dataset.query;
  if (!query) return;

  let page = parseInt(results.dataset.page ?? '1', 10);
  let loading = false;
  let exhausted = false;

  const sentinel = document.createElement('div');
  sentinel.style.height = '1px';
  results.after(sentinel);

  const load = async () => {
    if (loading || exhausted) return;
    loading = true;
    try {
      const res = await fetch(
        `/api/search?format=html&q=${encodeURIComponent(query)}&page=${page + 1}${location.search.replace(/^\?/, '&')}`,
      );
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { html: string; has_more: boolean };
      if (data.html.trim()) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = data.html;
        // Merge the returned grid's children into the existing grid so the CSS
        // columns stay continuous instead of starting a new grid per page.
        const grid = $<HTMLElement>('.grid', results);
        const incoming = $<HTMLElement>('.grid', wrapper);
        if (grid && incoming) {
          while (incoming.firstChild) grid.appendChild(incoming.firstChild);
        } else {
          results.appendChild(wrapper);
        }
        initImages(results);
        initSaves(results);
      }
      page++;
      if (!data.has_more) {
        exhausted = true;
        observer.disconnect();
        // Real pagination links stay in the DOM for crawlers; hide them once
        // we've consumed everything client-side.
        $<HTMLElement>('.pagination')?.setAttribute('hidden', '');
      }
    } catch {
      exhausted = true;
      observer.disconnect();
    } finally {
      loading = false;
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void load();
    },
    { rootMargin: '600px' },
  );
  observer.observe(sentinel);
}

// ---------------------------------------------------------------- autosubmit

function initAutosubmit(): void {
  for (const select of $$<HTMLSelectElement>('select[data-autosubmit]')) {
    select.addEventListener('change', () => select.form?.submit());
  }
}

// ---------------------------------------------------------------- bounce-back

/**
 * Outbound clicks open in a new tab; if the user is back on this tab within 10s
 * we treat it as a bounce-back (north-star metric, docs/01 §7).
 */
function initBounceBeacon(): void {
  let lastProductId: string | null = null;
  let lastClickAt = 0;

  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="/go/"]');
    if (!link) return;
    lastProductId = link.getAttribute('href')!.split('/')[2] ?? null;
    lastClickAt = Date.now();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!lastProductId) return;
    const elapsed = Date.now() - lastClickAt;
    if (elapsed > 1000 && elapsed < 10_000) {
      navigator.sendBeacon?.(
        '/api/beacon/return',
        new Blob([JSON.stringify({ product_id: lastProductId })], { type: 'application/json' }),
      );
    }
    lastProductId = null;
  });
}

// ---------------------------------------------------------------- stylist

/** Deliberately tiny markdown: bold, italic, paragraphs. Input is escaped first. */
function miniMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_/g, '$1<em>$2</em>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function initStylist(): void {
  const chat = $<HTMLElement>('#chat');
  const thread = $<HTMLElement>('#thread');
  const form = $<HTMLFormElement>('#chat-form');
  const input = $<HTMLTextAreaElement>('#chat-input');
  if (!chat || !thread || !form || !input) return;

  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  let busy = false;

  const addMessage = (who: 'user' | 'assistant', html: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = `msg msg-${who}`;
    el.innerHTML = `<div class="who">${who === 'user' ? 'You' : 'Stylist'}</div><div class="bubble">${html}</div>`;
    thread.appendChild(el);
    return $<HTMLElement>('.bubble', el)!;
  };

  const send = async (text: string) => {
    if (busy || !text.trim()) return;
    busy = true;
    $<HTMLElement>('#openers')?.setAttribute('hidden', '');

    addMessage('user', miniMarkdown(text));
    history.push({ role: 'user', content: text });

    const bubble = addMessage('assistant', '<span class="typing"></span>');
    let accumulated = '';
    const productBlocks: string[] = [];

    const repaint = () => {
      bubble.innerHTML = miniMarkdown(accumulated) + productBlocks.join('');
    };

    try {
      const res = await fetch('/api/stylist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12) }),
      });

      if (res.status === 429) {
        bubble.innerHTML = '<p>Slow down a moment — too many requests. Try again shortly.</p>';
        busy = false;
        return;
      }
      if (!res.ok || !res.body) throw new Error('stream failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventLine = /^event:\s*(.+)$/m.exec(frame);
          const dataLine = /^data:\s*(.+)$/m.exec(frame);
          if (!eventLine || !dataLine) continue;

          let payload: unknown;
          try {
            payload = JSON.parse(dataLine[1]);
          } catch {
            continue;
          }

          if (eventLine[1] === 'token' && typeof payload === 'string') {
            accumulated += payload;
            repaint();
            chat.scrollIntoView({ block: 'end', behavior: 'smooth' });
          } else if (eventLine[1] === 'products') {
            const p = payload as { html: string };
            productBlocks.push(p.html);
            repaint();
            initImages(bubble);
            initSaves(bubble);
          } else if (eventLine[1] === 'done') {
            history.push({ role: 'assistant', content: accumulated });
          }
        }
      }

      if (!accumulated.trim() && !productBlocks.length) {
        bubble.innerHTML = '<p>I didn’t catch that — try rephrasing?</p>';
      } else {
        repaint();
      }
      initImages(bubble);
      initSaves(bubble);
    } catch {
      bubble.innerHTML = '<p>My connection dropped. Try again, or use search instead.</p>';
    } finally {
      busy = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    void send(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 88)}px`;
  });

  for (const btn of $$<HTMLButtonElement>('[data-opener]')) {
    btn.addEventListener('click', () => void send(btn.dataset.opener!));
  }

  const seed = chat.dataset.seed;
  if (seed) void send(seed);
}

// ---------------------------------------------------------------- boot

function boot(): void {
  for (const bar of $$<HTMLElement>('[data-searchbar]')) initSearchBar(bar);
  initImages();
  initSaves();
  initAlerts();
  initReport();
  initChips();
  initInfiniteScroll();
  initAutosubmit();
  initBounceBeacon();
  initStylist();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
