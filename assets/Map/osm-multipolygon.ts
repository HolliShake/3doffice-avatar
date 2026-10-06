/**
 * osm-multipolygon.ts — assemble `type=multipolygon` relations into rings.
 *
 * Two important properties of this extract that a naive implementation
 * gets wrong:
 *
 *   1. Roles are on the relation's <member>, not on the way. The SAME way
 *      can be `outer` in one relation and `inner` in a sibling (which is
 *      true of ways 1255471209, 1255471210, 1255471213, 1255471214 in the
 *      USTP Claveria extract — the running track and the soccer pitch
 *      share edges).
 *
 *   2. Member ways are usually NOT closed rings. They must be chained by
 *      matching endpoints. (E.g. the pitch's outer ring is built from four
 *      2-node ways that link corner-to-corner.)
 *
 * Missing member refs are tolerated — common in clipped extracts.
 */

import type { LatLon, OsmNode, OsmRelation, OsmWay } from './osm-parser';

export interface MultipolygonRing {
  coords: LatLon[];
}

export interface MultipolygonGeometry {
  outers: MultipolygonRing[];
  inners: MultipolygonRing[];
}

export interface AssembleOptions {
  wayIndex: ReadonlyMap<number, OsmWay>;
  nodeMap: ReadonlyMap<number, OsmNode>;
}

/** Resolve a way's coordinates, tolerating missing node refs when geometry is inlined. */
function wayLatLons(way: OsmWay, nodeMap: ReadonlyMap<number, OsmNode>): LatLon[] | null {
  const geom = way.geometry;
  const aligned = geom !== undefined && geom.length === way.nodeRefs.length;

  if (way.nodeRefs.length === 0 && geom) {
    const out: LatLon[] = [];
    for (const g of geom) {
      if (!g) return null;
      out.push(g);
    }
    return out;
  }

  const out: LatLon[] = [];
  for (let i = 0; i < way.nodeRefs.length; i++) {
    const ref = way.nodeRefs[i]!;
    const n = nodeMap.get(ref);
    if (n && n.lat !== undefined && n.lon !== undefined) {
      out.push({ lat: n.lat, lon: n.lon });
    } else if (aligned && geom![i]) {
      out.push(geom![i]!);
    } else {
      return null;
    }
  }
  return out;
}

const COORD_EPS = 1e-8;

function samePoint(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) < COORD_EPS && Math.abs(a.lon - b.lon) < COORD_EPS;
}

/**
 * Chain an unordered pool of polyline segments into closed rings.
 *
 * Repeats until the pool is empty. Any run that can't close is force-closed
 * by repeating its first point (so we always emit a closed ring — better to
 * render a slightly-wrong polygon than to silently drop the whole feature).
 */
function chainRings(segments: LatLon[][]): LatLon[][] {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings: LatLon[][] = [];

  while (pool.length > 0) {
    let current = pool.shift()!;
    let grew = true;

    while (grew) {
      grew = false;
      const head = current[0]!;
      const tail = current[current.length - 1]!;
      if (samePoint(head, tail) && current.length >= 4) break;

      for (let i = 0; i < pool.length; i++) {
        const s = pool[i]!;
        const sHead = s[0]!;
        const sTail = s[s.length - 1]!;

        if (samePoint(tail, sHead)) {
          current = current.concat(s.slice(1));
        } else if (samePoint(tail, sTail)) {
          current = current.concat(s.slice().reverse().slice(1));
        } else if (samePoint(head, sTail)) {
          current = s.slice(0, -1).concat(current);
        } else if (samePoint(head, sHead)) {
          current = s.slice().reverse().slice(0, -1).concat(current);
        } else {
          continue;
        }
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }

    const head = current[0]!;
    const tail = current[current.length - 1]!;
    if (!samePoint(head, tail)) current.push({ lat: head.lat, lon: head.lon });
    if (current.length >= 4) rings.push(current);
  }

  return rings;
}

/**
 * Assemble a multipolygon relation into `{ outers, inners }`.
 * Returns `null` when nothing usable could be produced.
 */
export function assembleMultipolygon(
  relation: OsmRelation,
  opts: AssembleOptions
): MultipolygonGeometry | null {
  const outerSegs: LatLon[][] = [];
  const innerSegs: LatLon[][] = [];

  for (const m of relation.members) {
    if (m.type !== 'way') continue;
    const way = opts.wayIndex.get(m.ref);
    if (!way) continue; // tolerate missing members
    const coords = wayLatLons(way, opts.nodeMap);
    if (!coords || coords.length < 2) continue;
    if (m.role === 'inner') innerSegs.push(coords);
    else outerSegs.push(coords); // 'outer' or '' → outer
  }

  if (outerSegs.length === 0) return null;

  const outers = chainRings(outerSegs).map<MultipolygonRing>((coords) => ({ coords }));
  if (outers.length === 0) return null;
  const inners = chainRings(innerSegs).map<MultipolygonRing>((coords) => ({ coords }));
  return { outers, inners };
}
