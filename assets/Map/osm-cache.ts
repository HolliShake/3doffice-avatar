// lib/osm-cache.ts
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

/* ------------------------------------------------------------------ */
/*  Geo helpers                                                        */
/* ------------------------------------------------------------------ */

export function parseGeoCoordinatesArray(value: string | null | undefined): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      const [minLng, minLat, maxLng, maxLat] = parsed as number[];
      if (minLng < maxLng && minLat < maxLat) return parsed as number[];
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function centerOf(bbox: number[]): [number, number] {
  return [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
}

export function zoomFor(bbox: number[]): number {
  const span = Math.max(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1]));
  if (span > 1) return 8;
  if (span > 0.5) return 10;
  if (span > 0.1) return 12;
  if (span > 0.02) return 13;
  if (span > 0.005) return 15;
  return 16;
}

export const PHILIPPINES_DEFAULT: [number, number] = [12.8797, 121.774];

/* ------------------------------------------------------------------ */
/*  Base64 <-> UTF-8 helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Decode a Base64 string that was produced from UTF-8 bytes.
 * `atob` alone returns a Latin1 byte string and will mangle non-ASCII
 * characters (e.g. "Peña" in an OSM name tag), so we go through
 * `TextDecoder` to recover the original UTF-8 text.
 */
export function fromBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Quick sanity check before we attempt to decode. */
export function looksLikeBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

/* ------------------------------------------------------------------ */
/*  OSM XML fetching (fallback when no cached XML exists)              */
/* ------------------------------------------------------------------ */

export async function fetchOsmXml(bbox: number[], signal: AbortSignal): Promise<string> {
  const url = `${import.meta.env.VITE_APP_OSM_API ?? ''}?bbox=${bbox.join(',')}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const hint =
      res.status === 400
        ? ' — bbox may be too large (max ~0.25 sq. degrees) or invalid.'
        : res.status === 509
          ? ' — OSM API is throttling this client. Try again later.'
          : '';
    throw new Error(`OSM API error (${res.status} ${res.statusText})${hint}`);
  }
  return res.text();
}

/* ------------------------------------------------------------------ */
/*  useOsmXml hook                                                     */
/* ------------------------------------------------------------------ */

/**
 * Resolve OSM XML for a bounding box.
 *
 * Priority:
 *   1. `cachedBase64` — the Base64-encoded XML cached on the campus row.
 *      Decoded synchronously, no network call.
 *   2. Live fetch from the OSM API using `bbox`.
 *   3. Nothing — no bbox and no cache means 3D cannot render.
 */
export function useOsmXml(
  bbox: number[] | null,
  cachedBase64: string | null | undefined
): {
  xml: string | null;
  loading: boolean;
  error: Error | null;
  source: 'cache' | 'live' | null;
} {
  const [xml, setXml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [source, setSource] = useState<'cache' | 'live' | null>(null);

  // Prefer the Base64 payload itself as key so a re-fetched campus with new
  // cached data invalidates the effect even when the bbox is unchanged.
  const cacheKey = useMemo(() => {
    if (cachedBase64 && cachedBase64.length > 0)
      return `b64:${cachedBase64.length}:${cachedBase64.slice(0, 32)}`;
    return bbox ? `bbox:${bbox.join(',')}` : null;
  }, [cachedBase64, bbox]);

  useEffect(() => {
    // --- Branch 1: cached Base64 → decode locally, no network ---
    if (cachedBase64 && cachedBase64.length > 0) {
      let cacheOk = false;
      try {
        if (!looksLikeBase64(cachedBase64)) {
          throw new Error('Cached OSM XML is not valid Base64.');
        }
        const decoded = fromBase64Utf8(cachedBase64);
        if (!decoded || decoded.trim().length === 0) {
          throw new Error('Cached OSM XML decoded to an empty string.');
        }
        setXml(decoded);
        setLoading(false);
        setError(null);
        setSource('cache');
        cacheOk = true;
      } catch (e) {
        // Corrupt cache should not black-hole the map — fall through to a
        // live fetch if a bbox is available.
        setError(e instanceof Error ? e : new Error(String(e)));
        setXml(null);
        setSource(null);
      }
      if (cacheOk) return;
    }

    // --- Branch 2: no cache (or cache failed) → fetch live ---
    if (!bbox) {
      setXml(null);
      setLoading(false);
      setSource(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchOsmXml(bbox, controller.signal)
      .then((text) => {
        setXml(text);
        setSource('live');
        toast.info('OSM fetched via OpenStreetMap');
      })
      .catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setXml(null);
        setError(e instanceof Error ? e : new Error(String(e)));
        setSource(null);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return { xml, loading, error, source };
}
