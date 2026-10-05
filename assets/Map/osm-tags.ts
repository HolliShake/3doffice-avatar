/**
 * osm-tags.ts — semantic helpers for OSM tag dictionaries.
 *
 * Handles the awkward parts of OSM tagging that a renderer shouldn't
 * have to re-derive at every call site:
 *   - semicolon-separated list values (`isced:level=2;3`)
 *   - name variants (`name`, `old_name`, `nat_name`, `loc_name`, …)
 *   - annotation-only elements (`fixme`, `note`, `source:*`, `bridge:support`)
 *   - namespaced qualifier tags (`population:pupils` + `population:pupils:date`)
 *   - Philippine address hierarchy (`addr:barangay`, `addr:purok`-via-neighbourhood)
 *   - case-insensitive address comparison
 *
 * Pure functions; no dependencies on the renderer.
 */

export type Tags = Record<string, string>;

const LIST_SPLIT_RE = /;/;

/** OSM uses `;` to pack multiple values into one tag. */
export function splitTag(value: string | undefined | null): string[] {
  if (!value) return [];
  const parts = value.split(LIST_SPLIT_RE);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) out.push(t);
  }
  return out;
}

/** First defined, non-empty tag among `keys`. */
export function firstTagValue(tags: Tags, keys: ReadonlyArray<string>): string | undefined {
  for (const k of keys) {
    const v = tags[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Names                                                              */
/* ------------------------------------------------------------------ */

const PRIMARY_NAME_KEYS = [
  'name',
  'name:en',
  'official_name',
  'short_name',
  'alt_name',
  'loc_name',
  'nat_name',
] as const;

const ALT_NAME_KEYS = [
  'old_name',
  'alt_name',
  'short_name',
  'loc_name',
  'nat_name',
  'official_name',
  'name:en',
  'name:tl',
] as const;

export function bestName(tags: Tags): string | undefined {
  return firstTagValue(tags, PRIMARY_NAME_KEYS);
}

export interface AltNameEntry {
  key: string;
  value: string;
}

/** Alt names, deduped against the primary name. */
export function altNames(tags: Tags): AltNameEntry[] {
  const primary = bestName(tags);
  const seen = new Set<string>(primary ? [primary.toLowerCase()] : []);
  const out: AltNameEntry[] = [];
  for (const k of ALT_NAME_KEYS) {
    const v = tags[k];
    if (!v) continue;
    const norm = v.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ key: k, value: v });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Annotation-only detection                                          */
/* ------------------------------------------------------------------ */

const ANNOTATION_KEYS = new Set<string>([
  'fixme',
  'note',
  'comment',
  'source',
  'checked',
  'check_date',
  'created_by',
  'editor',
  'attribution',
  'import',
  'review',
  'tiger:reviewed',
  'tiger:cfcc',
  'tiger:county',
  'tiger:tlid',
  'tiger:upload_uuid',
  'bridge:support', // a lone abutment/pier node is a marker, not geometry
]);

/**
 * True if the element carries only metadata keys — e.g. a bare
 * `<node><tag k="fixme" v="continue"/></node>` or a lone
 * `<node><tag k="bridge:support" v="abutment"/></node>`.
 *
 * These should classify as `ignore` so they don't render as phantom
 * blocks in a 3D scene.
 */
export function isAnnotationOnly(tags: Tags): boolean {
  const keys = Object.keys(tags);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if (ANNOTATION_KEYS.has(k)) continue;
    if (k.startsWith('source:')) continue;
    if (k.startsWith('tiger:')) continue;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Namespaced qualifier tags                                          */
/* ------------------------------------------------------------------ */

const QUALIFIER_SUFFIXES = [
  'date',
  'source',
  'wikidata',
  'wikipedia',
  'unit',
  'note',
  'ref',
  'url',
] as const;

export interface NamespacedValue {
  /** e.g. `population:pupils` */
  key: string;
  value: string;
  /** e.g. `{ date: '2015', source: 'DepEd' }` */
  qualifiers: Record<string, string>;
}

/**
 * Extract `foo:bar` values that carry sibling qualifiers like `foo:bar:date`.
 * Skips keys that are themselves qualifiers, so a two-level namespace
 * produces exactly one entry per leaf.
 */
export function parseNamespacedTags(tags: Tags): NamespacedValue[] {
  const out: NamespacedValue[] = [];
  const qualifierKeySet = new Set<string>();
  for (const key of Object.keys(tags)) {
    for (const suffix of QUALIFIER_SUFFIXES) {
      if (key.endsWith(`:${suffix}`)) qualifierKeySet.add(key);
    }
  }
  for (const key of Object.keys(tags)) {
    if (qualifierKeySet.has(key)) continue;
    const value = tags[key]!;
    if (value === '') continue;
    const prefix = `${key}:`;
    const qualifiers: Record<string, string> = {};
    let hasQualifier = false;
    for (const suffix of QUALIFIER_SUFFIXES) {
      const qk = `${prefix}${suffix}`;
      const qv = tags[qk];
      if (qv !== undefined) {
        qualifiers[suffix] = qv;
        hasQualifier = true;
      }
    }
    if (!hasQualifier) continue;
    out.push({ key, value, qualifiers });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Addresses                                                          */
/* ------------------------------------------------------------------ */

/**
 * Format an address for a hover card. Understands the Philippine
 * hierarchy (barangay + purok), plus the common world-wide keys.
 * Returns `''` when nothing usable is present.
 */
export function formatAddress(tags: Tags): string {
  const parts: string[] = [];

  const num = tags['addr:housenumber'];
  const street = tags['addr:street'];
  if (num && street) parts.push(`${num} ${street}`);
  else if (street) parts.push(street);
  else if (num) parts.push(num);

  const hood = tags['addr:neighbourhood'] ?? tags['addr:suburb'] ?? tags['addr:quarter'];
  if (hood) parts.push(hood);

  const barangay = tags['addr:barangay'];
  if (barangay) parts.push(`Brgy. ${barangay}`);

  const city = tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'];
  if (city) parts.push(city);

  const province = tags['addr:province'] ?? tags['addr:state'];
  if (province) parts.push(province);

  const post = tags['addr:postcode'];
  if (post) parts.push(post);

  return parts.join(', ');
}

/** Case- and whitespace-insensitive address comparison key. */
export function normalizeAddr(v: string): string {
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}
