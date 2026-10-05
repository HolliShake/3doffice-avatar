/**
 * osm-parser.ts — a robust, dependency-free parser for OpenStreetMap XML (.osm)
 *
 * Handles:
 *   - Planet/extract/API 0.6 `<osm>` files (nodes, ways, relations, bounds)
 *   - JOSM files (negative ids, `action="delete"`, `<bound box=…>`, `upload`, etc.)
 *   - Overpass output (`out meta|tags|ids|center|bb|geom`, `<meta>`, `<note>`, `<remark>`)
 *   - osmChange (`<create>/<modify>/<delete>`) and augmented diffs (`<action><old/><new/>`)
 *   - Changeset dumps (`<changeset>` with tags)
 *   - History files (multiple versions of one id, `visible="false"`)
 *   - Arbitrarily large files via incremental (push/stream) parsing
 *   - Chunk boundaries anywhere (even mid-tag, mid-entity, mid-UTF-8 sequence)
 *   - Comments, CDATA, processing instructions, DOCTYPE, BOM, UTF-16, single/double quoted attrs
 *   - Malformed input: lenient mode collects warnings and recovers; strict mode throws
 *
 * Security notes: DOCTYPE entity declarations are never expanded (no XXE / billion-laughs),
 * tag/attribute maps use null-prototype objects (a tag key of `__proto__` is safe), and
 * pending-token size is capped.
 *
 * Performance notes
 * -----------------
 *   - Markup is located with native `indexOf` / sticky-regex `test`, never char-by-char loops.
 *   - Text between elements is skipped (not even sliced) unless it is inside <note>/<remark>.
 *   - Line/column are computed lazily, only when a warning/error is actually reported.
 *   - Element dispatch uses lookup tables instead of long switch chains.
 *   - Scalar parsers (num/int/bool/latlon/bounds) are pure closures built once per parser.
 *
 * Quick start
 * -----------
 *   const doc = parseOsm(xmlStringOrBytes);
 *
 *   // Huge files (Node):
 *   import { createReadStream } from 'node:fs';
 *   await parseOsmStream(createReadStream('planet.osm'), { onNode: n => … });
 *
 *   // Pull style:
 *   for await (const el of iterateOsm(stream)) { … }
 */

// ───────────────────────────── Types ─────────────────────────────

export type Tags = Record<string, string>;
export type OsmElementType = 'node' | 'way' | 'relation';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Metadata shared by nodes, ways and relations. All fields are optional in the wild. */
export interface OsmMeta {
  version?: number;
  /** ISO-8601 string exactly as found in the file. */
  timestamp?: string;
  changeset?: number;
  uid?: number;
  user?: string;
  visible?: boolean;
  /** JOSM `action` attribute, or the osmChange container (`create` | `modify` | `delete`). */
  action?: string;
  /** Only present when `keepRawAttributes` is enabled. */
  rawAttributes?: Record<string, string>;
}

export interface OsmNode extends OsmMeta {
  type: 'node';
  id: number;
  /** Absent for `out ids/tags` Overpass output and for deleted nodes. */
  lat?: number;
  lon?: number;
  tags: Tags;
}

export interface OsmWay extends OsmMeta {
  type: 'way';
  id: number;
  /** Node ids from `<nd ref>`. */
  nodeRefs: number[];
  /**
   * Inline geometry (Overpass `out geom`), one entry per `<nd>`.
   * `null` where the server omitted the coordinate (e.g. outside the clip bbox).
   */
  geometry?: (LatLon | null)[];
  bounds?: Bounds;
  center?: LatLon;
  tags: Tags;
}

export interface OsmMember {
  type: OsmElementType;
  ref: number;
  role: string;
  /** Overpass `out geom` for node members. */
  lat?: number;
  lon?: number;
  /** Overpass `out geom` for way members. */
  geometry?: (LatLon | null)[];
}

export interface OsmRelation extends OsmMeta {
  type: 'relation';
  id: number;
  members: OsmMember[];
  bounds?: Bounds;
  center?: LatLon;
  tags: Tags;
}

export interface OsmChangeset {
  type: 'changeset';
  id: number;
  createdAt?: string;
  closedAt?: string;
  open?: boolean;
  user?: string;
  uid?: number;
  bounds?: Bounds;
  numChanges?: number;
  commentsCount?: number;
  tags: Tags;
  rawAttributes?: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation | OsmChangeset;

export interface OsmHeader {
  /** Name of the root element: `osm`, `osmChange`, `osmAugmentedDiff`, … */
  root?: string;
  version?: string;
  generator?: string;
  copyright?: string;
  attribution?: string;
  license?: string;
  /** JOSM `upload` attribute (`true` | `false` | `never`). */
  upload?: string;
  bounds?: Bounds;
  /** Overpass `<meta osm_base>` */
  osmBase?: string;
  /** Overpass `<meta areas>` */
  osmAreas?: string;
  /** Overpass `<note>` text. */
  note?: string;
  /** Overpass `<remark>` texts — this is where runtime errors/timeouts are reported. */
  remarks: string[];
}

export interface OsmWarning {
  message: string;
  line: number;
  column: number;
}

export interface OsmDocument extends OsmHeader {
  nodes: OsmNode[];
  ways: OsmWay[];
  relations: OsmRelation[];
  changesets: OsmChangeset[];
  warnings: OsmWarning[];
  /** Number of warnings discarded after `maxWarnings` was reached. */
  droppedWarnings: number;
}

export interface OsmParseOptions {
  /** Throw `OsmParseError` on the first problem instead of recovering. Default: false. */
  strict?: boolean;
  /** Report coordinates outside ±90/±180. Default: true. */
  validateCoordinates?: boolean;
  /** Store the raw XML attributes on each element as `rawAttributes`. Default: false. */
  keepRawAttributes?: boolean;
  /** Report unrecognised elements. Default: false (OSM tooling adds many extensions). */
  warnOnUnknownElements?: boolean;
  /** Only build these element types; others are skipped cheaply. Default: all. */
  types?: ReadonlyArray<OsmElement['type']>;
  /** Cap on stored warnings. Default: 1000. */
  maxWarnings?: number;
  /** Max characters of a single unfinished markup token / text run. Default: 16 MiB. */
  maxTokenLength?: number;
}

export interface OsmHandlers {
  onHeader?(header: OsmHeader): void;
  onBounds?(bounds: Bounds): void;
  onNode?(node: OsmNode): void;
  onWay?(way: OsmWay): void;
  onRelation?(relation: OsmRelation): void;
  onChangeset?(changeset: OsmChangeset): void;
  /** Called for every element, after its specific handler. */
  onElement?(element: OsmElement): void;
  onRemark?(text: string): void;
  onWarning?(warning: OsmWarning): void;
}

export class OsmParseError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'OsmParseError';
    this.line = line;
    this.column = column;
  }
}

// ───────────────────────────── XML helpers ─────────────────────────────

type Attrs = Record<string, string>;
type Report = (msg: string) => void;

const dict = <T = string>(): Record<string, T> =>
  ({ __proto__: null }) as unknown as Record<string, T>;

const NAMED_ENTITIES: Record<string, string> = Object.assign(dict(), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z_][\w.-]*));/g;
const BARE_AMP_RE = /&(?!(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);)/;
const NEEDS_NORMALISE_RE = /[\t\n\r]/;
const NAME_END_RE = /[\t-\r /]/;
/** Matches the rest of a start tag (after `<`), honouring quoted attribute values. Sticky. */
const TAG_REST_RE = /(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const ATTR_RE = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

const isValidXmlCodePoint = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

function decodeEntities(s: string, report: Report, strict: boolean): string {
  if (!s.includes('&')) return s;
  if (strict && BARE_AMP_RE.test(s)) report('Unescaped "&" in text or attribute value');
  return s.replace(ENTITY_RE, (match: string, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) {
      const v = NAMED_ENTITIES[name];
      if (v === undefined) {
        report(`Unknown entity &${name};`);
        return match;
      }
      return v;
    }
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    if (!isValidXmlCodePoint(cp)) {
      report(`Invalid character reference ${match}`);
      return '\uFFFD';
    }
    return String.fromCodePoint(cp);
  });
}

const isNameStart = (c: number): boolean =>
  c === 58 || c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;

/** Finds the `>` closing a `<!DOCTYPE …>`-style declaration, honouring `[…]` and quotes. */
function findDeclEnd(s: string, from: number): number {
  let q = 0;
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (q) {
      if (c === q) q = 0;
    } else if (c === 34 || c === 39) q = c;
    else if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return i;
  }
  return -1;
}

/** Counts `\n` in `s[0, end)` using native indexOf; also returns the index of the last one. */
function scanLines(s: string, end: number): { count: number; last: number } {
  let count = 0;
  let last = -1;
  for (let i = s.indexOf('\n'); i !== -1 && i < end; i = s.indexOf('\n', i + 1)) {
    count++;
    last = i;
  }
  return { count, last };
}

/** Splits `name attr="v" …` into a name and a null-prototype attribute map. */
function parseTag(inner: string, report: Report, strict: boolean): { name: string; attrs: Attrs } {
  const end = inner.search(NAME_END_RE);
  const nameEnd = end === -1 ? inner.length : end;
  const name = inner.slice(0, nameEnd);
  const attrs: Attrs = { __proto__: null } as unknown as Attrs; // literal form is much cheaper than Object.create(null)
  if (nameEnd === inner.length) return { name, attrs };

  // ATTR_RE is global; it is reset here and never re-entered while this loop runs.
  ATTR_RE.lastIndex = nameEnd;
  let last = nameEnd;
  for (let m = ATTR_RE.exec(inner); m !== null; m = ATTR_RE.exec(inner)) {
    if (m.index > last && inner.slice(last, m.index).trim() !== '') {
      report(`Malformed attribute list in <${name}>`);
    }
    last = ATTR_RE.lastIndex;
    const key = m[1] as string;
    const rawVal = m[2] ?? m[3] ?? m[4];
    if (rawVal === undefined) {
      report(`Attribute "${key}" in <${name}> has no value`);
      continue;
    }
    if (m[4] !== undefined && strict) report(`Unquoted attribute value for "${key}"`);
    if (key in attrs) report(`Duplicate attribute "${key}" in <${name}>`);
    // XML attribute-value normalisation: literal whitespace → space (char refs are decoded after).
    const norm = NEEDS_NORMALISE_RE.test(rawVal) ? rawVal.replace(/\r\n|[\t\n\r]/g, ' ') : rawVal;
    attrs[key] = decodeEntities(norm, report, strict);
  }
  return { name, attrs };
}

// ───────────────────────────── Tokenizer ─────────────────────────────

interface XmlSink {
  /** When false the tokenizer does not even slice text runs. */
  readonly wantsText: boolean;
  startElement(name: string, attrs: Attrs): void;
  endElement(name: string): void;
  text(text: string): void;
}

/** Incremental XML tokenizer. Buffers incomplete markup until more data arrives. */
class XmlTokenizer {
  private buf = '';
  private pos = 0;
  private base = 0; // absolute offset of buf[0]
  private lines = 0; // newlines already discarded from the buffer
  private lineStart = 0; // absolute offset of the current line's start, as of the last discard

  private readonly sink: XmlSink;
  private readonly report: Report;
  private readonly strict: boolean;
  private readonly maxToken: number;
  private readonly fatal: (msg: string) => never;

  constructor(
    sink: XmlSink,
    report: Report,
    strict: boolean,
    maxToken: number,
    fatal: (msg: string) => never
  ) {
    this.sink = sink;
    this.report = report;
    this.strict = strict;
    this.maxToken = maxToken;
    this.fatal = fatal;
  }

  /** Lazily computed — only paid for when a problem is actually reported. */
  get location(): { line: number; column: number } {
    const { count, last } = scanLines(this.buf, this.pos);
    const start = last === -1 ? this.lineStart : this.base + last + 1;
    return { line: 1 + this.lines + count, column: this.base + this.pos - start + 1 };
  }

  write(chunk: string): void {
    if (!chunk) return;
    this.buf = this.buf.length === 0 ? chunk : this.buf + chunk;
    this.pump(false);
  }

  end(): void {
    this.pump(true);
  }

  private pump(final: boolean): void {
    const s = this.buf;
    while (this.pos < s.length) {
      const lt = s.indexOf('<', this.pos);
      if (lt === -1) {
        if (final) {
          this.emitText(s, this.pos, s.length);
          this.pos = s.length;
        }
        break;
      }
      if (lt > this.pos) {
        this.emitText(s, this.pos, lt);
        this.pos = lt;
      }
      if (!this.readMarkup(s)) {
        if (final) {
          this.report('Unexpected end of input inside markup');
          this.pos = s.length;
        }
        break;
      }
    }
    if (this.pos > 0) {
      const { count, last } = scanLines(s, this.pos);
      this.lines += count;
      if (last !== -1) this.lineStart = this.base + last + 1;
      this.base += this.pos;
      this.buf = s.slice(this.pos);
      this.pos = 0;
    }
    if (this.buf.length > this.maxToken) {
      this.fatal(`Unterminated token exceeds maxTokenLength (${this.maxToken})`);
    }
  }

  private emitText(s: string, from: number, to: number): void {
    if (to > from && this.sink.wantsText) {
      this.sink.text(decodeEntities(s.slice(from, to), this.report, this.strict));
    }
  }

  /** Reads one markup construct at `pos`. Returns false if more input is needed. */
  private readMarkup(s: string): boolean {
    const p = this.pos;
    if (p + 1 >= s.length) return false;
    const c = s.charCodeAt(p + 1);

    if (c === 33 /* ! */) {
      if (s.startsWith('<!--', p)) {
        const end = s.indexOf('-->', p + 4);
        if (end === -1) return false;
        this.pos = end + 3;
        return true;
      }
      if (s.startsWith('<![CDATA[', p)) {
        const end = s.indexOf(']]>', p + 9);
        if (end === -1) return false;
        if (this.sink.wantsText) this.sink.text(s.slice(p + 9, end));
        this.pos = end + 3;
        return true;
      }
      if (s.length - p < 9) {
        const rest = s.slice(p);
        if ('<!--'.startsWith(rest) || '<![CDATA['.startsWith(rest)) return false;
      }
      const end = findDeclEnd(s, p + 2); // DOCTYPE and friends: skipped, never expanded
      if (end === -1) return false;
      this.pos = end + 1;
      return true;
    }

    if (c === 63 /* ? */) {
      const end = s.indexOf('?>', p + 2);
      if (end === -1) return false;
      this.pos = end + 2;
      return true;
    }

    if (c === 47 /* / */) {
      const close = s.indexOf('>', p + 2);
      if (close === -1) return false;
      this.sink.endElement(s.slice(p + 2, close).trim());
      this.pos = close + 1;
      return true;
    }

    if (isNameStart(c)) {
      TAG_REST_RE.lastIndex = p + 1;
      if (!TAG_REST_RE.test(s)) return false; // unterminated: wait for more input
      const gt = TAG_REST_RE.lastIndex - 1;
      const selfClosing = s.charCodeAt(gt - 1) === 47;
      const { name, attrs } = parseTag(
        s.slice(p + 1, selfClosing ? gt - 1 : gt),
        this.report,
        this.strict
      );
      this.sink.startElement(name, attrs);
      if (selfClosing) this.sink.endElement(name);
      this.pos = gt + 1;
      return true;
    }

    // A stray '<' that doesn't begin markup (e.g. "a < b" in free text): treat as text.
    this.report('Stray "<" in content');
    if (this.sink.wantsText) this.sink.text('<');
    this.pos = p + 1;
    return true;
  }
}

// ───────────────────────────── Scalar parsers (pure closures) ─────────────────────────────

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

type BoundsNames = readonly [string, string, string, string];

const makeScalars = (issue: Report, validateCoordinates: boolean) => {
  const num = (v: string | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
    const t = v.trim();
    if (!NUM_RE.test(t)) {
      issue(`Invalid ${label} "${v}"`);
      return undefined;
    }
    return Number(t);
  };

  const int = (v: string | undefined, label: string): number | undefined => {
    const n = num(v, label);
    if (n !== undefined && !Number.isSafeInteger(n)) {
      issue(`Invalid ${label} "${v}" (not a safe integer)`);
      return undefined;
    }
    return n;
  };

  const id = (v: string | undefined, what: string, attr: string): number | undefined => {
    if (v === undefined) {
      issue(`${what} is missing required "${attr}" attribute`);
      return undefined;
    }
    return int(v, `${what} ${attr}`);
  };

  const bool = (v: string | undefined, label: string): boolean | undefined => {
    if (v === undefined) return undefined;
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
    issue(`Invalid boolean for ${label}: "${v}"`);
    return undefined;
  };

  const latlon = (latS: string | undefined, lonS: string | undefined): LatLon | undefined => {
    if (latS === undefined && lonS === undefined) return undefined;
    if (latS === undefined || lonS === undefined) {
      issue('Coordinate has only one of lat/lon');
      return undefined;
    }
    const lat = num(latS, 'lat');
    const lon = num(lonS, 'lon');
    if (lat === undefined || lon === undefined) return undefined;
    if (validateCoordinates) {
      if (lat < -90 || lat > 90) issue(`Latitude out of range: ${lat}`);
      if (lon < -180 || lon > 180) issue(`Longitude out of range: ${lon}`);
    }
    return { lat, lon };
  };

  const bounds = (a: Attrs, names: BoundsNames): Bounds | undefined => {
    if (names.every((n) => a[n] === undefined)) return undefined;
    const v = names.map((n) => num(a[n], n));
    if (v.some((x) => x === undefined)) {
      issue('Incomplete bounds');
      return undefined;
    }
    const [minLat, minLon, maxLat, maxLon] = v as [number, number, number, number];
    return { minLat, minLon, maxLat, maxLon };
  };

  return { num, int, id, bool, latlon, bounds };
};

type Scalars = ReturnType<typeof makeScalars>;

// ───────────────────────────── OSM reader ─────────────────────────────

type Role =
  | 'root'
  | 'container' // <create>/<modify>/<delete>/<action>/<new>
  | 'node'
  | 'way'
  | 'relation'
  | 'changeset'
  | 'member'
  | 'note'
  | 'remark'
  | 'leaf' // fully handled on open; children ignored
  | 'skip'; // ignored subtree

type Built = OsmNode | OsmWay | OsmRelation | OsmChangeset;

interface Frame {
  name: string;
  role: Role;
  el?: Built;
  member?: OsmMember;
  action?: string;
  ndCount: number;
  text: string;
}

type ResolvedOptions = Required<Omit<OsmParseOptions, 'types'>> & { types: Set<string> };

interface Ctx {
  readonly o: ResolvedOptions;
  readonly h: OsmHandlers;
  readonly header: OsmHeader;
  readonly issue: Report;
  readonly s: Scalars;
  unknown(name: string, parent: Frame | undefined): void;
}

const KNOWN_ROOTS = new Set<string>(['osm', 'osmChange', 'osmAugmentedDiff']);
const TEXT_ROLES = new Set<Role>(['note', 'remark']);
const ELEMENT_NAMES = new Set<string>(['node', 'way', 'relation', 'changeset']);

// ── element construction (table-driven, no shared mutable state) ──

function applyMeta(c: Ctx, el: OsmMeta, a: Attrs, containerAction?: string): void {
  const { int, bool } = c.s;
  const version = int(a.version, 'version');
  if (version !== undefined) el.version = version;
  if (a.timestamp !== undefined) el.timestamp = a.timestamp;
  const changeset = int(a.changeset, 'changeset');
  if (changeset !== undefined) el.changeset = changeset;
  const uid = int(a.uid, 'uid');
  if (uid !== undefined) el.uid = uid;
  if (a.user !== undefined) el.user = a.user;
  const visible = bool(a.visible, 'visible');
  if (visible !== undefined) el.visible = visible;
  const action = a.action ?? containerAction;
  if (action !== undefined) el.action = action;
  if (c.o.keepRawAttributes) el.rawAttributes = { ...a };
}

type Builder = (c: Ctx, id: number, a: Attrs, action?: string) => Built;

const BUILDERS: Record<string, Builder> = Object.assign(dict<Builder>(), {
  node: (c, id, a, action): OsmNode => {
    const n: OsmNode = { type: 'node', id, tags: dict() };
    applyMeta(c, n, a, action);
    const ll = c.s.latlon(a.lat, a.lon);
    if (ll) {
      n.lat = ll.lat;
      n.lon = ll.lon;
    }
    return n;
  },
  way: (c, id, a, action): OsmWay => {
    const w: OsmWay = { type: 'way', id, nodeRefs: [], tags: dict() };
    applyMeta(c, w, a, action);
    return w;
  },
  relation: (c, id, a, action): OsmRelation => {
    const r: OsmRelation = { type: 'relation', id, members: [], tags: dict() };
    applyMeta(c, r, a, action);
    return r;
  },
  changeset: (c, id, a): OsmChangeset => {
    const { bool, int, bounds } = c.s;
    const cs: OsmChangeset = { type: 'changeset', id, tags: dict() };
    if (a.created_at !== undefined) cs.createdAt = a.created_at;
    if (a.closed_at !== undefined) cs.closedAt = a.closed_at;
    const open = bool(a.open, 'open');
    if (open !== undefined) cs.open = open;
    if (a.user !== undefined) cs.user = a.user;
    const uid = int(a.uid, 'uid');
    if (uid !== undefined) cs.uid = uid;
    const nc = int(a.num_changes ?? a.changes_count, 'num_changes');
    if (nc !== undefined) cs.numChanges = nc;
    const cc = int(a.comments_count, 'comments_count');
    if (cc !== undefined) cs.commentsCount = cc;
    const b = bounds(a, ['min_lat', 'min_lon', 'max_lat', 'max_lon']);
    if (b) cs.bounds = b;
    if (c.o.keepRawAttributes) cs.rawAttributes = { ...a };
    return cs;
  },
} satisfies Record<string, Builder>);

function addTag(c: Ctx, tags: Tags, a: Attrs): void {
  const k = a.k;
  if (k === undefined) {
    c.issue('<tag> is missing "k"');
    return;
  }
  let v = a.v;
  if (v === undefined) {
    c.issue(`<tag k="${k}"> is missing "v"`);
    v = '';
  }
  if (k in tags) c.issue(`Duplicate tag key "${k}" (last value wins)`);
  tags[k] = v;
}

function pushGeometry(
  c: Ctx,
  target: { geometry?: (LatLon | null)[] },
  frame: Frame,
  a: Attrs
): void {
  const ll = c.s.latlon(a.lat, a.lon) ?? null;
  if (ll && !target.geometry) target.geometry = new Array<LatLon | null>(frame.ndCount).fill(null);
  target.geometry?.push(ll);
  frame.ndCount++;
}

// ── openers: <root> children, and children of node/way/relation/changeset ──

type ScopedOpener = (c: Ctx, f: Frame, name: string, a: Attrs, parent: Frame) => void;

const openElement: ScopedOpener = (c, f, name, a, parent) => {
  if (!c.o.types.has(name)) return; // filtered out: whole subtree skipped
  const id = c.s.id(a.id, `<${name}>`, 'id');
  if (id === undefined) return; // can't use an element without an id; subtree skipped
  f.el = BUILDERS[name]!(c, id, a, parent.action);
  f.role = name as Role;
};

const setHeaderBounds = (c: Ctx, b: Bounds): void => {
  if (c.header.bounds) return;
  c.header.bounds = b;
  c.h.onBounds?.(b);
};

const openContainer =
  (
    action: (name: string, a: Attrs, parent: Frame) => string | undefined,
    rootOnly = false
  ): ScopedOpener =>
  (c, f, name, a, parent) => {
    if (rootOnly && parent.role !== 'root') return c.unknown(name, parent);
    f.role = 'container';
    f.action = action(name, a, parent);
  };

const SCOPED: Record<string, ScopedOpener> = Object.assign(dict<ScopedOpener>(), {
  node: openElement,
  way: openElement,
  relation: openElement,
  changeset: openElement,

  bounds: (c, f, _n, a) => {
    f.role = 'leaf';
    const b = c.s.bounds(a, ['minlat', 'minlon', 'maxlat', 'maxlon']);
    if (b) setHeaderBounds(c, b);
  },

  // Legacy/JOSM: <bound box="minlat,minlon,maxlat,maxlon" origin="…"/>
  bound: (c, f, _n, a) => {
    f.role = 'leaf';
    if (a.box === undefined) return;
    const p = a.box.split(',');
    const n = p.length === 4 ? p.map((x) => c.s.num(x, 'bound box')) : [];
    if (n.length !== 4 || n.some((x) => x === undefined)) {
      c.issue(`Invalid <bound box="${a.box}">`);
      return;
    }
    const [minLat, minLon, maxLat, maxLon] = n as [number, number, number, number];
    setHeaderBounds(c, { minLat, minLon, maxLat, maxLon });
  },

  meta: (c, f, _n, a) => {
    f.role = 'leaf';
    if (a.osm_base !== undefined) c.header.osmBase = a.osm_base;
    if (a.areas !== undefined) c.header.osmAreas = a.areas;
  },

  note: (_c, f) => {
    f.role = 'note';
  },
  remark: (_c, f) => {
    f.role = 'remark';
  },

  create: openContainer((name) => name, true),
  modify: openContainer((name) => name, true),
  delete: openContainer((name) => name, true),
  action: openContainer((_n, a) => a.type), // augmented diff
  new: openContainer((_n, _a, parent) => parent.action), // augmented diff: <new> is authoritative
  old: () => undefined, // augmented diff: <old> subtree skipped
} satisfies Record<string, ScopedOpener>);

/** Child opener: returns false when the child isn't valid in this context (→ "unknown element"). */
type ChildOpener = (c: Ctx, f: Frame, a: Attrs, parent: Frame, el: Built) => boolean;

const CHILDREN: Record<string, ChildOpener> = Object.assign(dict<ChildOpener>(), {
  tag: (c, f, a, _p, el) => {
    addTag(c, el.tags, a);
    f.role = 'leaf';
    return true;
  },

  nd: (c, f, a, parent, el) => {
    if (el.type !== 'way') return false;
    const ref = a.ref !== undefined ? c.s.id(a.ref, '<nd>', 'ref') : undefined;
    if (ref !== undefined) el.nodeRefs.push(ref);
    pushGeometry(c, el, parent, a);
    f.role = 'leaf';
    return true;
  },

  member: (c, f, a, _p, el) => {
    if (el.type !== 'relation') return false;
    const type = a.type;
    if (type !== 'node' && type !== 'way' && type !== 'relation') {
      c.issue(`<member> has invalid type "${type ?? ''}"`);
      return true;
    }
    const ref = c.s.id(a.ref, '<member>', 'ref');
    if (ref === undefined) return true;
    const m: OsmMember = { type, ref, role: a.role ?? '' };
    const ll = c.s.latlon(a.lat, a.lon);
    if (ll) {
      m.lat = ll.lat;
      m.lon = ll.lon;
    }
    el.members.push(m);
    f.role = 'member';
    f.member = m;
    return true;
  },

  bounds: (c, f, a, _p, el) => {
    if (el.type !== 'way' && el.type !== 'relation') return false;
    const b = c.s.bounds(a, ['minlat', 'minlon', 'maxlat', 'maxlon']);
    if (b) el.bounds = b;
    f.role = 'leaf';
    return true;
  },

  center: (c, f, a, _p, el) => {
    if (el.type !== 'way' && el.type !== 'relation') return false;
    const ll = c.s.latlon(a.lat, a.lon);
    if (ll) el.center = ll;
    f.role = 'leaf';
    return true;
  },
} satisfies Record<string, ChildOpener>);

// ── emitters ──

const EMITTERS: Record<Built['type'], (h: OsmHandlers, el: Built) => void> = {
  node: (h, el) => h.onNode?.(el as OsmNode),
  way: (h, el) => h.onWay?.(el as OsmWay),
  relation: (h, el) => h.onRelation?.(el as OsmRelation),
  changeset: (h, el) => h.onChangeset?.(el as OsmChangeset),
};

class OsmReader implements XmlSink {
  readonly header: OsmHeader = { remarks: [] };
  readonly warnings: OsmWarning[] = [];
  droppedWarnings = 0;
  locate: () => { line: number; column: number } = () => ({ line: 0, column: 0 });

  private readonly stack: Frame[] = [];
  private rootSeen = false;

  private readonly h: OsmHandlers;
  private readonly o: ResolvedOptions;
  private readonly ctx: Ctx;

  constructor(h: OsmHandlers, o: ResolvedOptions) {
    this.h = h;
    this.o = o;
    this.ctx = {
      o,
      h,
      header: this.header,
      issue: this.issue,
      s: makeScalars(this.issue, o.validateCoordinates),
      unknown: (name, parent) => {
        if (o.warnOnUnknownElements) {
          this.issue(`Unexpected element <${name}>${parent ? ` inside <${parent.name}>` : ''}`);
        }
      },
    };
  }

  // ── problem reporting (location is computed only when actually needed) ──

  readonly issue = (message: string): void => {
    const strict = this.o.strict;
    if (!strict && this.warnings.length >= this.o.maxWarnings) {
      this.droppedWarnings++;
      return;
    }
    const { line, column } = this.locate();
    if (strict) throw new OsmParseError(message, line, column);
    const w: OsmWarning = { message, line, column };
    this.warnings.push(w);
    this.h.onWarning?.(w);
  };

  // ── XmlSink ──

  /** Text is only materialised for <note>/<remark> (and in strict mode, to validate entities). */
  get wantsText(): boolean {
    if (this.o.strict) return true;
    const top = this.stack[this.stack.length - 1];
    return !!top && TEXT_ROLES.has(top.role);
  }

  startElement(name: string, a: Attrs): void {
    const parent = this.stack[this.stack.length - 1];
    const f: Frame = { name, role: 'skip', ndCount: 0, text: '' };
    this.stack.push(f);
    const c = this.ctx;

    if (!parent) return this.openRoot(f, name, a);

    switch (parent.role) {
      case 'root':
      case 'container': {
        const open = SCOPED[name];
        return open ? open(c, f, name, a, parent) : c.unknown(name, parent);
      }
      case 'node':
      case 'way':
      case 'relation':
      case 'changeset': {
        const open = parent.el ? CHILDREN[name] : undefined;
        if (!parent.el) return; // parent was skipped (e.g. filtered by `types`)
        if (!open || !open(c, f, a, parent, parent.el)) c.unknown(name, parent);
        return;
      }
      case 'member':
        if (name === 'nd' && parent.member) {
          pushGeometry(c, parent.member, parent, a);
          f.role = 'leaf';
        } else c.unknown(name, parent);
        return;
      default:
        return; // inside leaf/skip/note/remark: ignore
    }
  }

  endElement(name: string): void {
    const stack = this.stack;
    if (stack.length === 0) {
      this.issue(`Unexpected closing tag </${name}>`);
      return;
    }
    const top = stack[stack.length - 1]!;
    if (top.name !== name) {
      const idx = stack.findLastIndex((fr) => fr.name === name);
      this.issue(
        idx === -1
          ? `Closing tag </${name}> does not match any open element`
          : `Closing tag </${name}> does not match <${top.name}>`
      );
      if (idx === -1) return;
      while (stack.length > idx + 1) this.close(stack.pop()!);
    }
    this.close(stack.pop()!);
  }

  text(t: string): void {
    const f = this.stack[this.stack.length - 1];
    if (f && TEXT_ROLES.has(f.role)) f.text += t;
  }

  /** Called once after the last chunk. */
  finish(): void {
    if (this.stack.length > 0) {
      const names = this.stack.map((f) => `<${f.name}>`).join(' > ');
      this.stack.length = 0;
      this.issue(
        `Unexpected end of document (truncated?); unclosed: ${names}. Incomplete element discarded`
      );
    }
    if (!this.rootSeen) this.issue('Document contains no elements');
  }

  // ── root / close ──

  private openRoot(f: Frame, name: string, a: Attrs): void {
    f.role = 'root';
    if (this.rootSeen) {
      this.issue(`Multiple root elements (<${name}>)`);
      return;
    }
    this.rootSeen = true;
    if (!KNOWN_ROOTS.has(name)) this.issue(`Unexpected root element <${name}>`);
    const hd = this.header;
    hd.root = name;
    (['version', 'generator', 'copyright', 'attribution', 'license', 'upload'] as const).forEach(
      (k) => {
        if (a[k] !== undefined) hd[k] = a[k];
      }
    );
    this.h.onHeader?.(hd);
  }

  private close(f: Frame): void {
    if (ELEMENT_NAMES.has(f.role)) {
      const el = f.el!;
      EMITTERS[el.type](this.h, el);
      this.h.onElement?.(el);
      return;
    }
    const t = f.text.trim();
    if (!t) return;
    if (f.role === 'note') this.header.note = t;
    else if (f.role === 'remark') {
      this.header.remarks.push(t);
      this.h.onRemark?.(t);
    }
  }
}

// ───────────────────────────── Public parser ─────────────────────────────

export type Chunk = string | Uint8Array;

/**
 * Push parser. Feed it strings or bytes in any chunking, then call `end()`.
 * Elements are delivered to the handlers as soon as they are complete.
 */
export class OsmParser {
  private readonly reader: OsmReader;
  private readonly tokenizer: XmlTokenizer;
  private readonly strict: boolean;
  private decoder?: TextDecoder;
  private started = false;
  private finished = false;

  constructor(handlers: OsmHandlers = {}, options: OsmParseOptions = {}) {
    const o: ResolvedOptions = {
      strict: options.strict ?? false,
      validateCoordinates: options.validateCoordinates ?? true,
      keepRawAttributes: options.keepRawAttributes ?? false,
      warnOnUnknownElements: options.warnOnUnknownElements ?? false,
      maxWarnings: options.maxWarnings ?? 1000,
      maxTokenLength: options.maxTokenLength ?? 16 * 1024 * 1024,
      types: new Set(options.types ?? ['node', 'way', 'relation', 'changeset']),
    };
    this.strict = o.strict;
    this.reader = new OsmReader(handlers, o);
    this.tokenizer = new XmlTokenizer(
      this.reader,
      this.reader.issue,
      o.strict,
      o.maxTokenLength,
      (msg) => {
        const { line, column } = this.tokenizer.location;
        throw new OsmParseError(msg, line, column);
      }
    );
    this.reader.locate = () => this.tokenizer.location;
  }

  get header(): OsmHeader {
    return this.reader.header;
  }
  get warnings(): readonly OsmWarning[] {
    return this.reader.warnings;
  }
  get droppedWarnings(): number {
    return this.reader.droppedWarnings;
  }

  write(chunk: Chunk | ArrayBuffer): this {
    if (this.finished) throw new Error('OsmParser: write() after end()');
    let text: string;
    if (typeof chunk === 'string') {
      text = chunk;
    } else {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (bytes.length === 0) return this;
      this.decoder ??= new TextDecoder(sniffEncoding(bytes), { fatal: this.strict });
      try {
        text = this.decoder.decode(bytes, { stream: true });
      } catch {
        const { line, column } = this.tokenizer.location;
        throw new OsmParseError('Invalid byte sequence for the detected encoding', line, column);
      }
    }
    if (!this.started && text) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.tokenizer.write(text);
    return this;
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.decoder) {
      try {
        const rest = this.decoder.decode();
        if (rest) this.tokenizer.write(rest);
      } catch {
        const { line, column } = this.tokenizer.location;
        throw new OsmParseError('Truncated multi-byte sequence at end of input', line, column);
      }
    }
    this.tokenizer.end();
    this.reader.finish();
  }
}

const sniffEncoding = (b: Uint8Array): string =>
  b.length >= 2 && b[0] === 0xff && b[1] === 0xfe
    ? 'utf-16le'
    : b.length >= 2 && b[0] === 0xfe && b[1] === 0xff
      ? 'utf-16be'
      : 'utf-8';

// ───────────────────────────── Convenience APIs ─────────────────────────────

/** Parse a complete document held in memory. */
export function parseOsm(
  input: string | Uint8Array | ArrayBuffer,
  options: OsmParseOptions = {}
): OsmDocument {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const changesets: OsmChangeset[] = [];
  const parser = new OsmParser(
    {
      onNode: (n) => nodes.push(n),
      onWay: (w) => ways.push(w),
      onRelation: (r) => relations.push(r),
      onChangeset: (c) => changesets.push(c),
    },
    options
  );
  parser.write(input).end();
  return {
    ...parser.header,
    nodes,
    ways,
    relations,
    changesets,
    warnings: [...parser.warnings],
    droppedWarnings: parser.droppedWarnings,
  };
}

export interface ReadableStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: Chunk }>; releaseLock(): void };
}
export type OsmSource = AsyncIterable<Chunk> | Iterable<Chunk> | ReadableStreamLike;

async function* chunksOf(source: OsmSource): AsyncGenerator<Chunk> {
  if (typeof (source as ReadableStreamLike).getReader === 'function') {
    const reader = (source as ReadableStreamLike).getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        if (r.value !== undefined) yield r.value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    yield* source as AsyncIterable<Chunk>;
  }
}

/**
 * Parse from any stream of strings/bytes: Node Readable, fetch() body, async iterables, arrays.
 * Memory use is bounded by the largest single element, not the file size.
 */
export async function parseOsmStream(
  source: OsmSource,
  handlers: OsmHandlers,
  options: OsmParseOptions = {}
): Promise<OsmHeader> {
  const parser = new OsmParser(handlers, options);
  for await (const chunk of chunksOf(source)) parser.write(chunk);
  parser.end();
  return parser.header;
}

/** Pull-style iteration over elements. The generator's return value is the final header. */
export async function* iterateOsm(
  source: OsmSource,
  options: OsmParseOptions = {}
): AsyncGenerator<OsmElement, OsmHeader, void> {
  const queue: OsmElement[] = [];
  const parser = new OsmParser({ onElement: (e) => queue.push(e) }, options);
  for await (const chunk of chunksOf(source)) {
    parser.write(chunk);
    yield* queue.splice(0);
  }
  parser.end();
  yield* queue.splice(0);
  return parser.header;
}

// ───────────────────────────── Utilities ─────────────────────────────

export interface OsmIndex {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
}

/** Index by id. For history/diff files with repeated ids, the last occurrence wins. */
export function buildIndex(doc: Pick<OsmDocument, 'nodes' | 'ways' | 'relations'>): OsmIndex {
  const byId = <T extends { id: number }>(xs: readonly T[]) =>
    new Map<number, T>(xs.map((x) => [x.id, x] as const));
  return { nodes: byId(doc.nodes), ways: byId(doc.ways), relations: byId(doc.relations) };
}

/**
 * Resolve a way's coordinates from the node index, falling back to inline Overpass geometry.
 * Unresolvable node ids (common in clipped extracts) are returned in `missingRefs`.
 */
export function wayCoordinates(
  way: OsmWay,
  nodes: ReadonlyMap<number, OsmNode>
): { coordinates: LatLon[]; missingRefs: number[] } {
  const geom = way.geometry;
  if (way.nodeRefs.length === 0 && geom) {
    return { coordinates: geom.filter((g): g is LatLon => g !== null), missingRefs: [] };
  }
  const aligned = geom !== undefined && geom.length === way.nodeRefs.length;
  const resolved = way.nodeRefs.map((ref, i) => {
    const n = nodes.get(ref);
    const point: LatLon | null =
      n && n.lat !== undefined && n.lon !== undefined
        ? { lat: n.lat, lon: n.lon }
        : ((aligned ? geom![i] : null) ?? null);
    return { ref, point };
  });
  return {
    coordinates: resolved.flatMap((r) => (r.point ? [r.point] : [])),
    missingRefs: resolved.filter((r) => !r.point).map((r) => r.ref),
  };
}

/** True if the way's first and last node coincide and it has at least 4 nodes. */
export function isClosedWay(way: OsmWay): boolean {
  const r = way.nodeRefs;
  if (r.length >= 4) return r[0] === r[r.length - 1];
  const g = way.geometry;
  if (r.length === 0 && g && g.length >= 4) {
    const a = g[0];
    const b = g[g.length - 1];
    return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  }
  return false;
}

/** Lazily yields every coordinate present in the document (no intermediate arrays). */
function* pointsOf(doc: Pick<OsmDocument, 'nodes' | 'ways' | 'relations'>): Generator<LatLon> {
  for (const n of doc.nodes) if (n.lat !== undefined && n.lon !== undefined) yield n as LatLon;
  for (const w of doc.ways) {
    for (const g of w.geometry ?? []) if (g) yield g;
    if (w.center) yield w.center;
  }
  for (const r of doc.relations) {
    if (r.center) yield r.center;
    for (const m of r.members) {
      if (m.lat !== undefined && m.lon !== undefined) yield m as LatLon;
      for (const g of m.geometry ?? []) if (g) yield g;
    }
  }
}

/** Bounding box of all coordinates present in the document (nodes, inline geometry, centers). */
export function computeBounds(
  doc: Pick<OsmDocument, 'nodes' | 'ways' | 'relations'>
): Bounds | undefined {
  const b: Bounds = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  for (const { lat, lon } of pointsOf(doc)) {
    if (lat < b.minLat) b.minLat = lat;
    if (lat > b.maxLat) b.maxLat = lat;
    if (lon < b.minLon) b.minLon = lon;
    if (lon > b.maxLon) b.maxLon = lon;
  }
  return b.minLat === Infinity ? undefined : b;
}
