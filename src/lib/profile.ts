import type { Env, FitPreference, FitProfile, Gender, SessionData } from '../types';
import { T } from './db';
import { safeJson } from './util';

const GENDERS = new Set<Gender>(['women', 'men', 'unisex', 'kids']);
const FITS = new Set<FitPreference>(['slim', 'regular', 'relaxed', 'oversized']);
const SIZE = /^(?:xxs|xs|s|m|l|xl|xxl|3xl|4xl|5xl|free|\d{1,2}(?:\.\d)?)$/;
const MATERIAL = /^[a-z][a-z-]{1,30}$/;

function validSize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const size = value.trim().toLowerCase();
  return SIZE.test(size) ? size : undefined;
}

/** Treat persisted profile JSON as untrusted and bound every field on read. */
export function sanitiseFitProfile(value: unknown): FitProfile {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const gender = typeof raw.gender === 'string' && GENDERS.has(raw.gender as Gender)
    ? (raw.gender as Gender)
    : undefined;
  const fit = typeof raw.fit === 'string' && FITS.has(raw.fit as FitPreference)
    ? (raw.fit as FitPreference)
    : undefined;
  const avoidMaterials = Array.isArray(raw.avoid_materials)
    ? [...new Set(raw.avoid_materials
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => MATERIAL.test(item)))]
        .slice(0, 8)
    : [];
  return {
    ...(gender ? { gender } : {}),
    ...(validSize(raw.top_size) ? { top_size: validSize(raw.top_size) } : {}),
    ...(validSize(raw.bottom_size) ? { bottom_size: validSize(raw.bottom_size) } : {}),
    ...(validSize(raw.shoe_size) ? { shoe_size: validSize(raw.shoe_size) } : {}),
    ...(fit ? { fit } : {}),
    avoid_materials: avoidMaterials,
  };
}

export async function loadFitProfile(env: Env, owner: string): Promise<FitProfile | null> {
  const stored = await loadShopperProfile(env, owner);
  return stored?.fit ?? null;
}

export interface ShopperProfile {
  fit: FitProfile;
  taste: Record<string, number>;
}

function sanitiseTaste(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, weight] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 64) break;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key)) continue;
    if (weight === 1 || weight === -1) out[key] = weight;
  }
  return out;
}

export async function loadShopperProfile(env: Env, owner: string): Promise<ShopperProfile | null> {
  try {
    const row = await env.DB.prepare(`SELECT profile FROM ${T.profiles} WHERE owner_key = ?`)
      .bind(owner)
      .first<{ profile: string }>();
    if (!row) return null;
    const raw = safeJson<Record<string, unknown>>(row.profile, {});
    // Accept the first release's fit-only shape during rolling deploys.
    const fit = sanitiseFitProfile(raw.fit ?? raw);
    return { fit, taste: sanitiseTaste(raw.taste) };
  } catch {
    return null;
  }
}

export async function persistFitProfile(
  env: Env,
  owner: string,
  profile: FitProfile,
): Promise<void> {
  const clean = sanitiseFitProfile(profile);
  const existing = await loadShopperProfile(env, owner);
  await env.DB.prepare(
    `INSERT INTO ${T.profiles} (owner_key, profile, updated_at) VALUES (?,?,?)
     ON CONFLICT(owner_key) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
  )
    .bind(owner, JSON.stringify({ fit: clean, taste: existing?.taste ?? {} }), Date.now())
    .run();
}

export async function persistTasteProfile(
  env: Env,
  owner: string,
  taste: Record<string, number>,
): Promise<void> {
  const existing = await loadShopperProfile(env, owner);
  await env.DB.prepare(
    `INSERT INTO ${T.profiles} (owner_key, profile, updated_at) VALUES (?,?,?)
     ON CONFLICT(owner_key) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
  )
    .bind(owner, JSON.stringify({ fit: existing?.fit ?? sanitiseFitProfile({}), taste: sanitiseTaste(taste) }), Date.now())
    .run();
}

/** Human-readable constraints for outfit and trip prompts. */
export function fitPrompt(profile?: FitProfile): string {
  if (!profile) return '';
  const parts = [
    profile.gender,
    profile.fit ? `${profile.fit} fit` : '',
    profile.top_size ? `top size ${profile.top_size.toUpperCase()}` : '',
    profile.bottom_size ? `bottom size ${profile.bottom_size.toUpperCase()}` : '',
    profile.shoe_size ? `shoe size ${profile.shoe_size.toUpperCase()}` : '',
    profile.avoid_materials.length ? `avoid ${profile.avoid_materials.join(' and ')}` : '',
  ].filter(Boolean);
  return parts.length ? `Shopper preferences: ${parts.join(', ')}.` : '';
}

export function hasFitProfile(session?: SessionData): boolean {
  const fit = session?.fit;
  return Boolean(
    fit &&
      (fit.gender || fit.top_size || fit.bottom_size || fit.shoe_size || fit.fit || fit.avoid_materials.length),
  );
}
