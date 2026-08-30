import type { Env } from '../types';
import type { EmbedModel } from '../ai/provider';

/**
 * Brute-force int8 vector index stored in KV (ADR-3).
 *
 * Why not Vectorize: it is outside the granted OAuth scopes, and at our catalog
 * size a linear scan of quantised vectors is genuinely faster than a network
 * round-trip to an ANN service. 384 dims × int8 = 384 bytes per product, so
 * 100k products is ~40 MB across a handful of KV values.
 *
 * Binary layout per shard, repeated:
 *   [ID_WIDTH bytes]  product id, ASCII, right-padded with 0x20
 *   [dim bytes]       int8 quantised unit vector
 *
 * Scale path: past ~500k SKUs, implement this same module against Vectorize.
 */

export const ID_WIDTH = 24;
/** Comfortably under KV's 25 MB per-value ceiling, and cheap to parse. */
const MAX_SHARD_BYTES = 4 * 1024 * 1024;
/** Don't hold more than this in the isolate — Workers cap memory at 128 MB. */
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface IndexMeta {
  version: number;
  dim: number;
  provider: string;
  model: string;
  count: number;
  shards: number;
  built_at: number;
}

/** Isolate-local cache. Survives across requests on a warm isolate. */
interface CachedIndex {
  meta: IndexMeta;
  shards: Uint8Array[];
  loadedAt: number;
  bytes: number;
}
let cache: CachedIndex | null = null;

// ---------------------------------------------------------------- quantisation

/**
 * L2-normalise then scale to int8. Because every stored vector is a unit
 * vector, a plain dot product of two int8 vectors is proportional to cosine
 * similarity — no per-query norm division needed.
 */
export function quantise(vec: Float32Array): Int8Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const out = new Int8Array(vec.length);
  if (norm === 0) return out;
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round((vec[i] / norm) * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}

/** Raw dot product of two equal-length int8 vectors. */
export function dot(a: Int8Array, b: Int8Array | Uint8Array, bOffset = 0): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    // Uint8Array bytes need sign restoration; Int8Array reads are already signed.
    const raw = b[bOffset + i];
    const signed = raw > 127 ? raw - 256 : raw;
    sum += a[i] * signed;
  }
  return sum;
}

/** Normalise a raw dot product into a 0..1 similarity. */
export function toSimilarity(rawDot: number): number {
  const cos = rawDot / (127 * 127);
  return Math.max(0, Math.min(1, (cos + 1) / 2));
}

// ---------------------------------------------------------------- id packing

export function packId(id: string, into: Uint8Array, offset: number): void {
  if (id.length > ID_WIDTH) throw new Error(`product id too long for index: ${id}`);
  for (let i = 0; i < ID_WIDTH; i++) {
    into[offset + i] = i < id.length ? id.charCodeAt(i) & 0x7f : 0x20;
  }
}

export function unpackId(buf: Uint8Array, offset: number): string {
  let end = ID_WIDTH;
  while (end > 0 && buf[offset + end - 1] === 0x20) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}

// ---------------------------------------------------------------- build / load

const metaKey = (v: number) => `vec:v${v}:meta`;
const shardKey = (v: number, i: number) => `vec:v${v}:s${i}`;
const ACTIVE_KEY = 'vec:active';

export interface IndexEntry {
  id: string;
  vector: Int8Array;
}

/**
 * Write a complete index for one embedding version. Called by the embed cron
 * once coverage is sufficient; it never mutates the live index in place.
 */
export async function buildIndex(
  env: Env,
  model: EmbedModel,
  entries: IndexEntry[],
): Promise<IndexMeta> {
  const recordSize = ID_WIDTH + model.dim;
  const perShard = Math.max(1, Math.floor(MAX_SHARD_BYTES / recordSize));
  const shardCount = Math.max(1, Math.ceil(entries.length / perShard));

  for (let s = 0; s < shardCount; s++) {
    const slice = entries.slice(s * perShard, (s + 1) * perShard);
    const buf = new Uint8Array(slice.length * recordSize);
    for (let i = 0; i < slice.length; i++) {
      const off = i * recordSize;
      packId(slice[i].id, buf, off);
      buf.set(new Uint8Array(slice[i].vector.buffer, slice[i].vector.byteOffset, model.dim), off + ID_WIDTH);
    }
    await env.VECTORS.put(shardKey(model.version, s), buf);
  }

  const meta: IndexMeta = {
    version: model.version,
    dim: model.dim,
    provider: model.provider,
    model: model.model,
    count: entries.length,
    shards: shardCount,
    built_at: Date.now(),
  };
  await env.VECTORS.put(metaKey(model.version), JSON.stringify(meta));
  return meta;
}

/**
 * Promote a version to serve live traffic. Deliberately separate from
 * buildIndex so a partially-rebuilt index can never be queried.
 */
export async function activateIndex(env: Env, version: number): Promise<void> {
  await env.VECTORS.put(ACTIVE_KEY, String(version));
  cache = null;
}

/** Remove the active pointer when no live products remain after catalogue cleanup. */
export async function deactivateIndex(env: Env): Promise<void> {
  await env.VECTORS.delete(ACTIVE_KEY);
  cache = null;
}

export async function getActiveVersion(env: Env): Promise<number | null> {
  const raw = await env.VECTORS.get(ACTIVE_KEY);
  if (!raw) return null;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : null;
}

async function loadIndex(env: Env): Promise<CachedIndex | null> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;

  const version = await getActiveVersion(env);
  if (version === null) return null;

  const metaRaw = await env.VECTORS.get(metaKey(version), 'json');
  if (!metaRaw) return null;
  const meta = metaRaw as IndexMeta;

  const shards: Uint8Array[] = [];
  let bytes = 0;
  for (let s = 0; s < meta.shards; s++) {
    const buf = await env.VECTORS.get(shardKey(version, s), 'arrayBuffer');
    if (!buf) continue; // A missing shard degrades recall; it must not throw.
    shards.push(new Uint8Array(buf));
    bytes += buf.byteLength;
  }
  if (!shards.length) return null;

  const loaded: CachedIndex = { meta, shards, loadedAt: Date.now(), bytes };
  // Only retain across requests if it comfortably fits in isolate memory.
  cache = bytes <= MAX_CACHE_BYTES ? loaded : null;
  return loaded;
}

export interface VectorHit {
  id: string;
  similarity: number;
}

/**
 * Top-k nearest neighbours. `queryVec` must come from the same embedding model
 * as the active index — the caller checks `meta.version` before embedding.
 */
export async function vectorSearch(
  env: Env,
  queryVec: Int8Array,
  k = 200,
): Promise<{ hits: VectorHit[]; meta: IndexMeta } | null> {
  const index = await loadIndex(env);
  if (!index) return null;
  if (queryVec.length !== index.meta.dim) return null;

  const recordSize = ID_WIDTH + index.meta.dim;

  // Bounded insertion sort over raw dot products. k is small (200) and, once the
  // buffer is full, the `raw <= floor` guard rejects the vast majority of
  // candidates with a single comparison — cheaper than heap bookkeeping.
  // Ids are unpacked lazily, only for candidates that actually make the cut.
  const topDots: number[] = [];
  const topOffsets: { shard: Uint8Array; offset: number }[] = [];
  let floor = -Infinity;

  for (const shard of index.shards) {
    const records = Math.floor(shard.length / recordSize);
    for (let r = 0; r < records; r++) {
      const off = r * recordSize;
      const raw = dot(queryVec, shard, off + ID_WIDTH);
      if (topDots.length >= k && raw <= floor) continue;

      let i = topDots.length;
      while (i > 0 && topDots[i - 1] < raw) i--;
      topDots.splice(i, 0, raw);
      topOffsets.splice(i, 0, { shard, offset: off });
      if (topDots.length > k) {
        topDots.pop();
        topOffsets.pop();
      }
      if (topDots.length >= k) floor = topDots[topDots.length - 1];
    }
  }

  const hits: VectorHit[] = topDots.map((raw, i) => ({
    id: unpackId(topOffsets[i].shard, topOffsets[i].offset),
    similarity: toSimilarity(raw),
  }));

  return { hits, meta: index.meta };
}

/** Test seam: drop the isolate cache. */
export function resetVectorCache(): void {
  cache = null;
}
