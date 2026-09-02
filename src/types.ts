/** Shared types for Vestiq. */

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  VECTORS: KVNamespace;
  SESSIONS: KVNamespace;
  AI?: Ai;
  ASSETS?: Fetcher;

  SITE_NAME: string;
  SITE_TAGLINE: string;
  SITE_URL: string;
  CURRENCY: string;
  EMBED_DIM: string;
  EMBED_VERSION: string;
  LOG_LEVEL: string;
  /**
   * "1" enables traffic-driven scheduling (see maybeRunScheduledFromRequest).
   * Off by default so a real cron trigger or external scheduler is the explicit,
   * preferred driver — and so tests are not mutating data mid-request.
   */
  SCHEDULER_PIGGYBACK?: string;
  /** Declares the dependable driver used when piggybacking is disabled. */
  SCHEDULER_DRIVER?: 'github-actions' | 'cloudflare-cron';

  ADMIN_TOKEN?: string;
  GEMINI_API_KEY?: string;
  RESEND_API_KEY?: string;
}

export type FitPreference = 'slim' | 'regular' | 'relaxed' | 'oversized';

/** Shopper-controlled defaults used only as bounded ranking preferences. */
export interface FitProfile {
  gender?: Gender;
  top_size?: string;
  bottom_size?: string;
  shoe_size?: string;
  fit?: FitPreference;
  avoid_materials: string[];
}

export type Gender = 'women' | 'men' | 'unisex' | 'kids';
export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock';
export type SortKey = 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'popular';

/** Intent classes the query parser can assign. Drives recall strategy. */
export type Intent =
  | 'mood'
  | 'occasion'
  | 'constraint'
  | 'styling_problem'
  | 'brand_reference'
  | 'image'
  | 'specific_item'
  | 'browse';

/**
 * The structured understanding of a user's query. This is the contract between
 * the AI layer and the search layer — everything downstream reads only this.
 * Rendered to the user as removable chips (design §5 ParseChips).
 */
export interface ParsedQuery {
  /** Text used for semantic embedding — the query stripped of hard constraints. */
  semantic_text: string;
  intent: Intent;
  categories: string[];
  gender?: Gender;
  colors: string[];
  exclude_colors: string[];
  materials: string[];
  occasions: string[];
  style_tags: string[];
  brands: string[];
  /** Style-reference brands: "like Sabyasachi" — used for vector seeding, not filtering. */
  like_brands: string[];
  price_min?: number; // paise
  price_max?: number; // paise
  sizes: string[];
  /** Free-text negations we could not map to a structured field. */
  exclude_terms: string[];
  /** Model's own confidence 0..1. Low confidence widens recall. */
  confidence: number;
  /** Which provider produced this parse. Observability + cost accounting. */
  provider?: string;
}

export interface Brand {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  description: string | null;
  city: string | null;
  country: string;
  price_tier: string;
  style_tags: string[];
  trust_score: number;
  ship_days: number | null;
  return_days: number | null;
  has_return_policy: number;
  affiliate_network: string | null;
  affiliate_rate_bp: number;
  affiliate_tmpl: string | null;
  product_count: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Product {
  id: string;
  brand_id: string;
  external_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  gender: Gender;
  price: number; // paise
  mrp: number | null; // paise
  currency: string;
  url: string;
  image_url: string | null;
  images: string[];
  colors: string[];
  sizes: string[];
  materials: string[];
  occasions: string[];
  style_tags: string[];
  attributes: Record<string, unknown>;
  availability: Availability;
  rating: number | null;
  review_count: number;
  popularity: number;
  last_verified_at: number | null;
  first_seen_at: number;
  updated_at: number;
  status: string;
}

/** A product joined with its brand, plus per-query ranking metadata. */
export interface ResultItem extends Product {
  brand_name: string;
  brand_slug: string;
  brand_trust: number;
  brand_ship_days: number | null;
  score: number;
  /** Human-readable reasons this matched, rendered as chips. */
  match_reasons: string[];
  /** Debug-only score breakdown, populated when ?debug=1. */
  score_parts?: Record<string, number>;
}

export interface FacetBucket {
  value: string;
  label: string;
  count: number;
}

export interface Facets {
  category: FacetBucket[];
  brand: FacetBucket[];
  color: FacetBucket[];
  material: FacetBucket[];
  occasion: FacetBucket[];
  price_band: FacetBucket[];
  size: FacetBucket[];
}

export interface SearchResponse {
  query: string;
  parse: ParsedQuery;
  /** The subset enforced as hard constraints; other parsed attributes rank softly. */
  filter_parse: ParsedQuery;
  items: ResultItem[];
  facets: Facets;
  total: number;
  /**
   * True when `total` hit the recall-pool ceiling and is therefore a floor, not
   * an exact count. The UI must render "N+" in this case rather than claiming
   * precision it does not have.
   */
  capped: boolean;
  page: number;
  per_page: number;
  has_more: boolean;
  latency_ms: number;
  /** Populated when total is 0 — one-tap ways to widen the search. */
  relaxations: Relaxation[];
  degraded: string[];
}

export interface Relaxation {
  label: string;
  query: string;
  /** Which constraint was binding, so the empty state can explain itself. */
  removed: string;
}

export interface SessionData {
  id: string;
  user_id?: string;
  created_at: number;
  last_seen_at: number;
  /**
   * Taste profile from onboarding (U17) and click behaviour: canonical style /
   * material / colour token → weight in roughly -1..1. Stored as tag weights
   * rather than a vector so ranking can apply it with zero inference cost.
   */
  taste?: Record<string, number>;
  recent_queries: string[];
  gender_pref?: Gender;
  /** Explicit shopper fit settings. Sizes influence ranking but never hide stock. */
  fit?: FitProfile;
}

export interface AppContext {
  session: SessionData;
  requestId: string;
  isBot: boolean;
  nonce: string;
}
