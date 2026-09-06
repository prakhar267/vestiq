# Vestiq — public demo launch kit

This is the source of truth for presenting the current product. The custom domain
is deliberately deferred; every other repository-controlled launch item is part
of CI or this kit.

## Positioning

**Name:** Vestiq

**Tagline:** Describe it. We'll find it.

**One-liner:** AI fashion discovery that turns a mood, occasion, budget or photo
into shoppable results from genuine live inventory.

**Short description:** Marketplace filters make shoppers translate a real need
into a rigid category tree. Vestiq accepts the request as people naturally say it,
explains what it understood, and searches live merchant inventory. Shoppers can
then build one budget-safe look, plan a trip wardrobe, remember their fit and
search from a photo.

**Current scope:** This public launch is a catalogue pilot with The Souled Store.
It contains no invented listings, does not take payment and links shoppers to the
merchant's own checkout. The free merchant portal is ready for additional
authorised brands.

## 60-second demo script

| Time | Screen | Narration |
| --- | --- | --- |
| 0–7s | Home | “Fashion searches start as a human thought, not a category path.” |
| 7–18s | Search | Enter “I need a breathable dinner outfit for Goa under ₹5000.” Show the live results and removable understanding chips. |
| 18–30s | Complete look | Open “Build a complete look.” Generate coordinated pieces inside one total budget. |
| 30–42s | Trip planner | Build a two-day Goa wardrobe and show the shared budget. |
| 42–51s | Photo search | Show the upload surface and explain that the inferred description stays editable. |
| 51–60s | Sources / merchant | Show genuine source transparency, then finish on the free merchant-onboarding CTA. |

## Reliable demo prompts

- `outdoor`
- `black cotton t-shirt`
- `Harry Potter oversized`
- `I need a breathable dinner outfit for Goa under ₹5000.`

Use the first prompt for a fast cold-open, then the Goa request to demonstrate
natural language and budget handling. Do not improvise a niche category during a
recorded demo; the catalogue is intentionally honest about what it currently has.

## Gallery assets

- `launch/01-home.png` — product promise and four feature entries
- `launch/02-natural-language-search.png` — genuine results for the Goa request
- `launch/03-complete-look.png` — coordinated look within a single budget
- `launch/04-trip-wardrobe.png` — two distinct days and one trip budget
- `launch/05-photo-search.png` — accessible image-search entry
- `launch/vestiq-demo.mp4` — short captioned gallery video assembled from these screens
- `launch/og-source.svg` — editable 1200×630 social-card source
- `../public/og.png` — production social card

## Suggested launch post

> Fashion search still expects you to think like a catalogue. Vestiq lets you ask
> for what you actually mean: “a breathable dinner outfit for Goa under ₹5000,” a
> complete look inside one budget, a trip wardrobe, or something from a screenshot.
> Every result comes from genuine live inventory and links to the merchant's own
> store. The current public release is a live catalogue pilot, and both shopper
> access and merchant onboarding are free during launch.

## Founder comment

> I built Vestiq around a simple observation: people describe an occasion and a
> feeling, while commerce sites expose a taxonomy. The difficult work is not a
> chat box—it is maintaining live inventory, combining lexical and semantic
> retrieval, enforcing real budgets, explaining matches, and continuing to work
> when an AI provider fails. This pilot makes that complete loop public. I would
> especially value feedback on result quality and the complete-look workflow.

## Demo-day operating checklist

1. Run `SITE_URL=https://vestiq.prakhargupta267.workers.dev npm run check:demo`.
2. Confirm the latest **CI**, **Scheduler and production health**, and
   **Production synthetic checks** runs are green.
3. Open each reliable prompt once to warm its parse/vector cache.
4. Keep `/health` and the GitHub Actions page open during the launch window.
5. Use `/admin` to watch zero-result/catalogue health.
6. Respond to catalogue reports; do not hide an item without checking its
   merchant source.
7. If a release regresses, roll back the Worker using `docs/06-runbook.md`.

## External records to retain privately

- Merchant/feed and product-image authorisation.
- Domain registration and the working `hello@` / `privacy@` inboxes once bought.
- Any future affiliate agreement and its disclosure wording.

These records should not be committed to the public repository.
