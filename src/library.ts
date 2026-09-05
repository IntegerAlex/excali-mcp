import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { detachArrowLabels, reanchor } from "./geometry.js";

export interface LibraryItem {
  id: string;
  elements: Record<string, unknown>[];
}

/** libraries/*.excalidrawlib in both formats (libraryItems[] and legacy library[]). */
export async function loadLibraryItems(dir: string): Promise<LibraryItem[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".excalidrawlib"));
  const out: LibraryItem[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8")) as {
        libraryItems?: { id?: string; elements?: Record<string, unknown>[] }[];
        library?: unknown;
      };
      if (Array.isArray(d.libraryItems)) {
        for (const it of d.libraryItems) {
          if (it && Array.isArray(it.elements)) out.push({ id: String(it.id ?? `${f}#${out.length}`), elements: it.elements });
        }
      } else if (Array.isArray(d.library)) {
        const lib = d.library as unknown[];
        if (lib.length > 0 && Array.isArray(lib[0])) {
          // oldest format: library = list of element-groups
          for (let i = 0; i < lib.length; i++) {
            out.push({ id: `${f}#${i}`, elements: lib[i] as Record<string, unknown>[] });
          }
        } else {
          for (let i = 0; i < lib.length; i++) {
            const e = lib[i] as Record<string, unknown>;
            out.push({ id: String(e.id ?? `${f}#${i}`), elements: [e] });
          }
        }
      }
    } catch {
      /* skip corrupt files */
    }
  }
  return out;
}

/**
 * Named icon slots for generation. Pinned by file + index, verified by the
 * caption text inside the item at load time (index shifts are detected).
 */
const ICON_SLOTS: { slug: string; file: string; index: number; expect: string }[] = [
  { slug: "icon_user", file: "awesome-icons.excalidrawlib", index: 13, expect: "User" },
  { slug: "icon_users", file: "awesome-icons.excalidrawlib", index: 14, expect: "Users" },
  { slug: "icon_home", file: "awesome-icons.excalidrawlib", index: 4, expect: "Home" },
  { slug: "icon_lock", file: "awesome-icons.excalidrawlib", index: 5, expect: "Lock" },
  { slug: "icon_search", file: "awesome-icons.excalidrawlib", index: 2, expect: "Search" },
  { slug: "icon_chart", file: "awesome-icons.excalidrawlib", index: 8, expect: "Chart" },
  { slug: "icon_email", file: "awesome-icons.excalidrawlib", index: 22, expect: "email" },
  { slug: "icon_calendar", file: "awesome-icons.excalidrawlib", index: 10, expect: "Calendar" },
  { slug: "icon_location", file: "awesome-icons.excalidrawlib", index: 17, expect: "Location" },
  { slug: "icon_payment", file: "awesome-icons.excalidrawlib", index: 11, expect: "Payment" },
];

function captionOf(elements: Record<string, unknown>[]): string {
  return elements
    .filter((e) => e.type === "text" && typeof e.text === "string")
    .map((e) => e.text as string)
    .join(" ");
}

/** Resolve slugs to templates, skipping any whose caption drifted. */
export async function loadIconTemplates(dir: string): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const slot of ICON_SLOTS) {
    try {
      const d = JSON.parse(await readFile(join(dir, slot.file), "utf8")) as {
        library?: unknown;
        libraryItems?: { elements?: Record<string, unknown>[] }[];
      };
      let elements: Record<string, unknown>[] | null = null;
      if (Array.isArray(d.libraryItems) && d.libraryItems[slot.index]?.elements) {
        elements = d.libraryItems[slot.index].elements!;
      } else if (Array.isArray(d.library) && Array.isArray(d.library[0])) {
        elements = (d.library as unknown[][])[slot.index] as Record<string, unknown>[];
      }
      if (elements && captionOf(elements).includes(slot.expect)) {
        out.set(slot.slug, elements);
      } else {
        console.error(`[library] slot ${slot.slug}: caption drift, skipping`);
      }
    } catch (e) {
      console.error(`[library] slot ${slot.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

let idCounter = 0;
const freshId = (): string => `lib${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/* ------------------------------------------------------------------ */
/* Catalog + on-demand fetch (plan §7). index covers all ~100 upstream  */
/* libs; only 6 payloads ship in npm. Rest lazy-fetch + disk cache.     */
/* ------------------------------------------------------------------ */

export interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  keywords: string;
  /** upstream path under libraries/, e.g. "slobodan/aws-serverless.excalidrawlib" */
  source: string;
  /** local filename for bundled/cache lookup */
  file: string;
  sampleItems: string[];
  bundled: boolean;
  /** per-index names from upstream libraries.json (v2 libs); preferred over element text */
  itemNames?: string[];
}

const UPSTREAM_BASE =
  "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries";

export { CATALOG } from "./catalog.generated.js";
import { CATALOG } from "./catalog.generated.js";

const LOGIC_ONLY = /\b(sequence|er\b|class diagram|state diagram|flowchart of logic|algorithm)\b/i;

export interface LibraryHit {
  slug: string;
  name: string;
  description: string;
  itemCount: number | null;
  sampleItems: string[];
  bundled: boolean;
}

/** Keyword-ranked catalog search. Logic-only queries return [] + no-libs hint. */
export function listLibraries(query = ""): { hits: LibraryHit[]; noLibsHint?: string } {
  const q = query.trim().toLowerCase();
  if (q && LOGIC_ONLY.test(q)) {
    return { hits: [], noLibsHint: "Logic-only diagram — use pure mermaid, no libraries." };
  }
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = CATALOG.map((e) => {
    let score = 0;
    if (!terms.length) score = e.bundled ? 2 : 1;
    for (const t of terms) {
      if (e.slug.includes(t)) score += 3;
      if (e.keywords.includes(t)) score += 2;
      if (e.name.toLowerCase().includes(t)) score += 2;
      if (e.description.toLowerCase().includes(t)) score += 1;
    }
    // Prefer libs with real per-item names — but only among actual matches.
    if (terms.length && score > 0 && e.itemNames?.length) score += 1;
    return { e, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return {
    hits: scored.map((s) => ({
      slug: s.e.slug, name: s.e.name, description: s.e.description,
      // Counts only from upstream itemNames (true counts). Otherwise null =
      // unknown until list_library_items fetches it — never a sample length.
      itemCount: s.e.itemNames?.length ?? null,
      sampleItems: (s.e.sampleItems.length ? s.e.sampleItems : (s.e.itemNames ?? [])).slice(0, 5),
      bundled: s.e.bundled,
    })),
  };
}

function cacheDir(): string {
  return join(homedir(), ".cache", "diagram-tool", "libraries");
}

function bundledDir(): string {
  // dist/library.js -> ../libraries ; src/library.ts -> ../libraries (repo root)
  return join(dirname(fileURLToPath(import.meta.url)), "..", "libraries");
}

/** Local library dir: project ./libraries if present, else the shipped bundle. */
export function libraryDir(): string {
  const local = join(process.cwd(), "libraries");
  if (existsSync(local)) return local;
  return bundledDir();
}

const payloadCache = new Map<string, Record<string, unknown>[][]>();

/** Parse v1 + v2 payloads into item element-groups. Skips image items (need files map). */
export function normalizePayload(raw: unknown, label: string): Record<string, unknown>[][] {
  const d = raw as {
    type?: string; libraryItems?: { elements?: Record<string, unknown>[] }[]; library?: unknown;
  };
  if (!d || typeof d !== "object" || d.type !== "excalidrawlib") {
    throw new Error(`Not an .excalidrawlib payload: ${label}`);
  }
  const groups: Record<string, unknown>[][] = [];
  if (Array.isArray(d.libraryItems)) {
    for (const it of d.libraryItems) {
      if (it && Array.isArray(it.elements)) {
        const els = it.elements.filter((e) => e.type !== "image");
        if (els.length) groups.push(els);
      }
    }
  } else if (Array.isArray(d.library)) {
    const lib = d.library as unknown[];
    if (lib.length > 0 && Array.isArray(lib[0])) {
      for (const g of lib as unknown[][]) {
        const els = (g as Record<string, unknown>[]).filter((e) => e.type !== "image");
        if (els.length) groups.push(els);
      }
    }
  }
  return groups;
}

async function readPayloadFile(path: string): Promise<Record<string, unknown>[][]> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return normalizePayload(raw, path);
}

/** Pre-generated-catalog slugs, kept resolving so saved decorations don't break. */
const SLUG_ALIASES: Record<string, string> = {
  "network-topology": "network-topology-icons",
  "azure-cloud": "azure-cloud-services",
  "aws-architecture": "aws-architecture-icons",
  "uml-er": "uml-er-library",
};

/** Resolve a library slug to item groups: cwd/libraries → cache → bundled → upstream fetch. */
export async function loadLibraryBySlug(rawSlug: string, libraryUrl?: string): Promise<{ entry: CatalogEntry | null; groups: Record<string, unknown>[][]; names: string[] }> {
  const slug = SLUG_ALIASES[rawSlug] ?? rawSlug;
  const entry = CATALOG.find((e) => e.slug === slug) ?? null;
  const cacheKey = libraryUrl ?? slug;
  const cached = payloadCache.get(cacheKey);
  if (cached) return { entry, groups: cached, names: namesOf(cached, entry?.itemNames) };

  const candidates: string[] = [];
  if (entry) {
    candidates.push(join(process.cwd(), "libraries", entry.file));
    candidates.push(join(cacheDir(), entry.file));
    candidates.push(join(bundledDir(), entry.file));
  }
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const groups = await readPayloadFile(p);
        payloadCache.set(cacheKey, groups);
        return { entry, groups, names: namesOf(groups, entry?.itemNames) };
      } catch { /* try next */ }
    }
  }
  // On-demand upstream fetch (explicit URL wins, else catalog source).
  const url = libraryUrl ?? (entry ? `${UPSTREAM_BASE}/${entry.source}` : null);
  if (!url) throw new Error(`Unknown library "${slug}". Use list_libraries to discover slugs.`);
  if (!entry && libraryUrl) {
    if (!/^https:\/\/raw\.githubusercontent\.com\/excalidraw\/excalidraw-libraries\//.test(libraryUrl)) {
      throw new Error("libraryUrl must point at the excalidraw-libraries repo (or save the file locally).");
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Library fetch failed: HTTP ${res.status} (${url}). Offline? Use one of the 6 bundled libs.`);
  const raw = await res.json();
  const groups = normalizePayload(raw, url);
  payloadCache.set(cacheKey, groups);
  // Persist to disk cache (best effort, 7-day TTL enforced on read).
  try {
    if (entry) {
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(join(cacheDir(), entry.file), JSON.stringify(raw));
    }
  } catch { /* cache write optional */ }
  return { entry, groups, names: namesOf(groups, entry?.itemNames) };
}

function namesOf(groups: Record<string, unknown>[][], itemNames?: string[]): string[] {
  if (itemNames && itemNames.length === groups.length) return [...itemNames];
  return groups.map((els, i) => {
    const t = els.find((e) => e.type === "text" && typeof e.text === "string");
    const name = t ? String(t.text).slice(0, 40) : "";
    return name || `item ${i}`;
  });
}

/** TTL check helper for cache freshness messaging (7 days). */
export async function isCacheFresh(file: string): Promise<boolean> {
  try {
    const st = await stat(join(cacheDir(), file));
    return Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

export interface Decoration {
  library: string;
  itemIndex: number;
  libraryUrl?: string;
  /** Target diagram node id or label, e.g. "SQS". The agent knows the mapping — prefer this over auto-match. */
  node?: string;
  scale?: number;
  /** Opt-in box enlargement: grow to fit art + caption only when the grown
   *  rect (20px margin) is clear of every other element. Default false =
   *  scale-to-fit inside the SDK box (never invalidates dagre spacing). */
  allowGrow?: boolean;
  x?: number;
  y?: number;
}

/** Normalize for name matching: case/punctuation-insensitive. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Node label text via `label` prop or bound text element. */
function nodeLabel(elements: Record<string, unknown>[], id: string): string {
  const node = elements.find((e) => String(e.id) === id);
  const label = node?.label as { text?: string } | undefined;
  if (label && typeof label.text === "string" && label.text) return label.text;
  const bound = elements.find((e) => e.type === "text" && e.containerId === id);
  if (bound && typeof bound.text === "string") return bound.text;
  return "";
}

/** Find a container node for a decoration. Exact label/id match first, then
 *  substring fallback ("s3" matches "S3 bucket"). First match wins. */
export function matchNodeByName(elements: Record<string, unknown>[], name: string): string | null {
  const want = normalizeName(name);
  if (!want) return null;
  const containers = elements.filter(
    (e) => e.type === "rectangle" || e.type === "diamond" || e.type === "ellipse",
  );
  for (const e of containers) {
    if (normalizeName(nodeLabel(elements, String(e.id))) === want) return String(e.id);
  }
  for (const e of containers) {
    if (normalizeName(String(e.id)) === want) return String(e.id);
  }
  if (want.length < 2) return null;
  for (const e of containers) {
    const label = normalizeName(nodeLabel(elements, String(e.id)));
    if (label.includes(want) || want.includes(label)) return String(e.id);
  }
  return null;
}

/** Node labels available for explicit `node` targeting (for error messages). */
export function nodeNames(elements: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of elements) {
    if (e.type !== "rectangle" && e.type !== "diamond" && e.type !== "ellipse") continue;
    const label = nodeLabel(elements, String(e.id));
    out.push(label ? `${String(e.id)} ("${label}")` : String(e.id));
  }
  return out;
}

const numf = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);

/**
 * Single bounded collision check for allowGrow: is `rect` (plus margin)
 * clear of every element except the node being replaced (its box dies and
 * its captions move with it)? One O(n) test per decoration — not an
 * iterative global pass. Arrows count via their point bboxes, so growth
 * never swallows a routed edge either.
 */
function grownRectClear(
  elements: Record<string, unknown>[],
  selfIds: Set<string>,
  rect: { x: number; y: number; w: number; h: number },
  margin = 20,
): boolean {
  const rx1 = rect.x - margin;
  const ry1 = rect.y - margin;
  const rx2 = rect.x + rect.w + margin;
  const ry2 = rect.y + rect.h + margin;
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : NaN);
  for (const e of elements) {
    if (selfIds.has(String(e.id))) continue;
    let x1 = num(e.x);
    let y1 = num(e.y);
    let x2 = NaN;
    let y2 = NaN;
    if (e.type === "arrow") {
      // Incident arrows terminate on this node by design (reanchor moves
      // their endpoints onto the grown border) — only pass-through edges
      // count as collisions.
      const sId = (e.start as { id?: string } | undefined)?.id;
      const tId = (e.end as { id?: string } | undefined)?.id;
      if ((sId !== undefined && selfIds.has(String(sId))) || (tId !== undefined && selfIds.has(String(tId)))) continue;
      const pts = e.points as [number, number][] | undefined;
      if (!Array.isArray(pts) || pts.length === 0) continue;
      const ox = num(e.x);
      const oy = num(e.y);
      if (!isFinite(ox) || !isFinite(oy)) continue;
      const px = pts.map((p) => ox + num(p[0])).filter((v) => isFinite(v));
      const py = pts.map((p) => oy + num(p[1])).filter((v) => isFinite(v));
      if (px.length === 0 || py.length === 0) continue;
      x1 = Math.min(...px);
      y1 = Math.min(...py);
      x2 = Math.max(...px);
      y2 = Math.max(...py);
    } else {
      const w = num(e.width);
      const h = num(e.height);
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(w) || !isFinite(h)) continue;
      x2 = x1 + w;
      y2 = y1 + h;
    }
    if (rx1 < x2 && rx2 > x1 && ry1 < y2 && ry2 > y1) return false;
  }
  return true;
}

/**
 * Icon-AS-node: delete the converter box, put library art in its place with
 * the mermaid caption stacked below, re-anchor arrows onto the final border.
 *
 * Scale-to-fit by default: the box keeps dagre's exact rect, so neighbor
 * spacing stays valid — art takes the box minus the caption strip. Small
 * boxes mean small art; pass allowGrow to enlarge instead, which applies
 * only when the grown rect has slack (single bounded check, else fit).
 * Unknown/degenerate input degrades to unreplaced — never throws.
 */
export function replaceNodeWithIcon(
  elements: Record<string, unknown>[],
  nodeId: string,
  template: Record<string, unknown>[],
  opts: { allowGrow?: boolean } = {},
): { replaced: boolean; grew: boolean } {
  const none = { replaced: false, grew: false };
  const idx = elements.findIndex(
    (e) => String(e.id) === nodeId && (e.type === "rectangle" || e.type === "diamond" || e.type === "ellipse"),
  );
  if (idx === -1) return none;
  const node = elements[idx]!;
  const captions = elements.filter((e) => e.type === "text" && e.containerId === nodeId);
  const capW = Math.max(0, ...captions.map((c) => numf(c.width, 40)), 40) + 34;
  // Reserve a caption strip BELOW the art: stacking captions inside the art
  // rect renders as "empty box + label spilling out". Art scales into the
  // box minus this strip; captions land fully below the artwork. Height is
  // measured from line count — stored heights historically assume one line.
  const capLines = (t: Record<string, unknown>): number =>
    typeof t.text === "string" ? t.text.split("\n").length : 1;
  const capH = captions.reduce(
    (a, c) => a + Math.max(numf(c.height, 0), capLines(c) * numf(c.fontSize, 16) * 1.3) + 4,
    0,
  );
  const stripH = capH > 0 ? capH + 14 : 0;
  const oldBox = {
    x: numf(node.x),
    y: numf(node.y),
    w: Math.max(1, numf(node.width, 80)),
    h: Math.max(1, numf(node.height, 40)),
  };
  const wantW = Math.max(oldBox.w, 132, capW);
  const wantH = Math.max(oldBox.h, 140) + stripH;
  // Default: dagre's rect stands (neighbor spacing stays valid). Grow only
  // on explicit allowGrow AND proven slack — otherwise silently fit.
  let box = { ...oldBox };
  let grew = false;
  if (opts.allowGrow && (wantW > oldBox.w + 1 || wantH > oldBox.h + 1)) {
    const grown = {
      x: oldBox.x - (wantW - oldBox.w) / 2,
      y: oldBox.y - (wantH - oldBox.h) / 2,
      w: wantW,
      h: wantH,
    };
    const selfIds = new Set([nodeId, ...captions.map((c) => String(c.id))]);
    if (grownRectClear(elements, selfIds, grown)) {
      box = grown;
      grew = true;
    }
  }
  const groupId = `icon-${nodeId}`;
  // Commit: remove box, place art. Grown boxes stack captions in the bottom
  // strip; fit keeps dagre's rect and sets art left, caption right.
  elements.splice(idx, 1);
  // The box dies but its identity shouldn't: re-add the same rect (dagre
  // geometry + the node's own colors) behind the art, or decorated nodes
  // render as floating text while every plain node keeps its colored box.
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  elements.splice(idx, 0, {
    id: freshId(),
    type: "rectangle",
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: 0,
    strokeColor: node.strokeColor ?? "#1e1e1e",
    backgroundColor: node.backgroundColor ?? "transparent",
    fillStyle: node.fillStyle ?? "solid",
    strokeWidth: num(node.strokeWidth) || 2,
    strokeStyle: node.strokeStyle ?? "solid",
    roughness: num(node.roughness) || 1,
    opacity: num(node.opacity) || 100,
    ...(node.roundness !== undefined ? { roundness: node.roundness } : {}),
    groupIds: [groupId],
    seed: Math.floor(Math.random() * 2 ** 31),
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  });
  if (grew) {
    const art = instantiateIcon(template, box, groupId, stripH);
    if (art.length === 0) return none;
    elements.push(...art);
    let cy = box.y + box.h - 6;
    const stacked = [...captions].reverse();
    for (const c of stacked) {
      const fs = numf(c.fontSize, 16);
      const ch = numf(c.height, fs * 1.3);
      cy -= ch + 4;
      c.y = cy;
      c.x = box.x + box.w / 2 - numf(c.width, 40) / 2;
      delete c.containerId;
      const g = c.groupIds as string[] | undefined;
      c.groupIds = [...(g ?? []), groupId];
    }
  } else {
    const artSize = Math.max(8, box.h - 16);
    const art = instantiateIcon(template, box, groupId, 0, artSize);
    if (art.length === 0) return none;
    elements.push(...art);
    const ax2 = Math.max(...art.map((a) => numf(a.x) + numf(a.width, 0)));
    const ax = ax2 + 12;
    const boxRight = box.x + box.w;
    for (const c of captions) {
      const capW = numf(c.width, 40);
      const remaining = boxRight - ax;
      // Center in the space right of the art; wider captions left-align at
      // the art edge and spill right into the rank gap (never over the art).
      c.x = capW <= remaining ? ax + (remaining - capW) / 2 : ax;
      delete c.containerId;
      const g = c.groupIds as string[] | undefined;
      c.groupIds = [...(g ?? []), groupId];
    }
  }
  // Paint order = array order, and art was just pushed last: move captions
  // to the end so text always paints above icon strokes. The SDK does the
  // same (labels appended last); replacement must not invert it.
  for (const c of captions) {
    const i = elements.indexOf(c);
    if (i !== -1) elements.splice(i, 1);
    elements.push(c);
  }
  reanchor(elements, nodeId, box);
  return { replaced: true, grew };
}

/**
 * Clone library items onto the scene with fresh ids + remapped internal refs,
 * scaled, auto-tiled along the bottom row unless explicit x/y given.
 */
export async function applyDecorations(
  elements: Record<string, unknown>[],
  decorations: Decoration[],
): Promise<{ added: number; placed: { library: string; itemIndex: number; elementIds: string[]; node?: string; grew?: boolean }[] }> {
  if (decorations.length > 6) throw new Error("Max 6 decorations per render (keeps diagrams readable).");
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  const xs = elements.flatMap((e) => (typeof e.x === "number" && typeof e.width === "number" ? [e.x as number, (e.x as number) + (e.width as number)] : []));
  const ys = elements.flatMap((e) => (typeof e.y === "number" && typeof e.height === "number" ? [e.y as number, (e.y as number) + (e.height as number)] : []));
  let cursorX = xs.length ? Math.min(...xs) : 0;
  const baseY = ys.length ? Math.max(...ys) + 60 : 0;
  const placed: { library: string; itemIndex: number; elementIds: string[]; node?: string; grew?: boolean }[] = [];
  let added = 0;
  for (const d of decorations) {
    const { groups, names } = await loadLibraryBySlug(d.library, d.libraryUrl);
    const template = groups[d.itemIndex];
    if (!template) throw new Error(`Item ${d.itemIndex} out of range for "${d.library}" (0–${groups.length - 1}). Use list_library_items to repick.`);
    const itemName = names[d.itemIndex] ?? "";
    // Glyph check: background-only templates (rectangles, no drawn glyph)
    // render as empty squares — fail loud so the agent repicks instead of
    // shipping a blank box (node target or tiled alike).
    const artKinds = template.filter((e) => e.type !== "text").map((e) => String(e.type));
    if (artKinds.length > 0 && !artKinds.some((t) => t === "line" || t === "freedraw" || t === "image" || t === "ellipse" || t === "arrow")) {
      throw new Error(
        `Decoration "${itemName || d.library}#${d.itemIndex}" has no drawable glyph (background-only art). Pick another item via list_library_items.`,
      );
    }
    // Icon-as-node: the agent knows the mapping, so an explicit `node`
    // (id or label) wins. Otherwise auto-match by item name, else tile below.
    // A failed explicit target is an error (with valid names) — silent tiling
    // is what produced the disconnected-icon screenshots.
    let nodeId: string | null = null;
    if (typeof d.node === "string" && d.node) {
      const direct = elements.find((e) => String(e.id) === d.node);
      nodeId =
        direct && (direct.type === "rectangle" || direct.type === "diamond" || direct.type === "ellipse")
          ? String(direct.id)
          : matchNodeByName(elements, d.node);
      if (!nodeId) {
        throw new Error(
          `Decoration "${itemName || d.library}#${d.itemIndex}" targets unknown node "${d.node}". Available nodes: ${nodeNames(elements).join(", ") || "(none)"}.`,
        );
      }
    } else if (d.x !== undefined || d.y !== undefined) {
      // Explicit coordinates: tiling where told is intentional, no match needed.
      nodeId = null;
    } else {
      nodeId = matchNodeByName(elements, itemName);
      if (!nodeId) {
        throw new Error(
          `Decoration "${itemName || d.library}#${d.itemIndex}" matched no node (auto-match by item name failed). Pass explicit "node" (id or label). Available nodes: ${nodeNames(elements).join(", ") || "(none)"}.`,
        );
      }
    }
    if (nodeId && d.x === undefined && d.y === undefined) {
      const r = replaceNodeWithIcon(elements, nodeId, template, { allowGrow: d.allowGrow === true });
      if (r.replaced) {
        placed.push({ library: d.library, itemIndex: d.itemIndex, elementIds: [nodeId], node: nodeId, grew: r.grew });
        continue;
      }
    }
    const scale = d.scale ?? 1;
    // bbox of template
    const tx = template.flatMap((e) => (typeof e.x === "number" && typeof e.width === "number" ? [e.x as number, (e.x as number) + (e.width as number)] : []));
    const ty = template.flatMap((e) => (typeof e.y === "number" && typeof e.height === "number" ? [e.y as number, (e.y as number) + (e.height as number)] : []));
    if (!tx.length || !ty.length) continue;
    const minX = Math.min(...tx);
    const minY = Math.min(...ty);
    const w = Math.max(1, Math.max(...tx) - minX) * scale;
    const targetX = d.x ?? cursorX;
    const targetY = d.y ?? baseY;
    const idMap = new Map<string, string>();
    for (const e of template) {
      if (typeof e.id === "string") idMap.set(e.id, freshId());
    }
    const groupId = freshId();
    const ids: string[] = [];
    for (const e of template) {
      const nid = idMap.get(String(e.id)) ?? freshId();
      ids.push(nid);
      const clone: Record<string, unknown> = {
        ...e, id: nid, groupIds: [...((e.groupIds as string[]) ?? []), groupId],
        x: num(e.x) * scale + (targetX - minX * scale),
        y: num(e.y) * scale + (targetY - minY * scale),
        width: num(e.width) * scale, height: num(e.height) * scale,
        seed: Math.floor(Math.random() * 2 ** 31),
        versionNonce: Math.floor(Math.random() * 2 ** 31),
      };
      // remap internal refs
      if (typeof e.containerId === "string" && idMap.has(e.containerId)) clone.containerId = idMap.get(e.containerId);
      const be = e.boundElements as { id: string; type: string }[] | undefined;
      if (Array.isArray(be)) clone.boundElements = be.map((b) => ({ ...b, id: idMap.get(b.id) ?? b.id }));
      const start = e.start as { id?: string } | undefined;
      const end = e.end as { id?: string } | undefined;
      if (start?.id && idMap.has(start.id)) clone.start = { ...start, id: idMap.get(start.id) };
      if (end?.id && idMap.has(end.id)) clone.end = { ...end, id: idMap.get(end.id) };
      elements.push(clone);
      added++;
    }
    if (d.x === undefined) cursorX += w + 40;
    placed.push({ library: d.library, itemIndex: d.itemIndex, elementIds: ids });
  }
  // No layout passes after replacement: boxes keep dagre rects (fit) or
  // provably-clear grown rects, so there is nothing to repair. Detach last —
  // labels stay bound through reanchor shifts; Excalidraw would re-snap
  // bound text to arrow midpoints at render time.
  detachArrowLabels(elements);
  return { added, placed };
}

/**
 * Fit a library item's artwork into a node card: strip its own caption text
 * (the node's label stays), normalize coords, scale into place.
 *
 * Two layouts, both footprint-preserving:
 * - stack (grown boxes): art scales into the box minus `bottomStrip`;
 *   node captions stack in the strip below the artwork.
 * - side (scale-to-fit): art is a left-hand square of `sideArtSize`;
 *   the caption keeps its size/height and shifts right of the art. Dagre
 *   boxes are wide+short, so side-by-side is the only fit without growth.
 */
export function instantiateIcon(
  template: Record<string, unknown>[],
  box: { x: number; y: number; w: number; h: number },
  groupId: string,
  bottomStrip = 0,
  sideArtSize = 0,
): Record<string, unknown>[] {
  const art = template.filter((e) => e.type !== "text");
  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of art) {
    // Finite-only: one corrupt coordinate must not NaN the whole icon.
    if (typeof e.x === "number" && isFinite(e.x) && typeof e.width === "number" && isFinite(e.width)) {
      xs.push(e.x, e.x + e.width);
    }
    if (typeof e.y === "number" && isFinite(e.y) && typeof e.height === "number" && isFinite(e.height)) {
      ys.push(e.y, e.y + e.height);
    }
  }
  if (xs.length === 0 || ys.length === 0) return [];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const natW = Math.max(1, Math.max(...xs) - minX);
  const natH = Math.max(1, Math.max(...ys) - minY);
  // Captions live in the reserved strip below, so the art area is whatever
  // the box has left after it — no minimum floor (floors reintroduce the
  // spill that scale-to-fit is meant to end; small boxes mean small art).
  // Side layout instead fits a left-hand square of sideArtSize.
  const side = sideArtSize > 0;
  const targetH = side ? Math.max(8, sideArtSize) : Math.max(8, box.h - Math.max(0, bottomStrip) - 24);
  const targetW = side ? Math.max(8, sideArtSize) : Math.max(24, box.w - 24);
  const s = Math.min(targetW / natW, targetH / natH);
  const offX = side ? box.x + 8 - minX * s : box.x + box.w / 2 - (natW * s) / 2 - minX * s;
  const offY = side
    ? box.y + box.h / 2 - (natH * s) / 2 - minY * s
    : box.y + 10 - minY * s;
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  // Points are relative to element x/y: scale them too, or art renders at
  // template-native size inside a scaled box (tiny glyph in a big card).
  const scalePts = (p: unknown): [number, number][] | undefined =>
    Array.isArray(p)
      ? (p as [number, number][]).map(([px, py]) => [num(px) * s, num(py) * s] as [number, number])
      : undefined;
  return art.map((e) => ({
    ...e,
    id: freshId(),
    groupIds: [groupId],
    x: num(e.x) * s + offX,
    y: num(e.y) * s + offY,
    width: num(e.width) * s,
    height: num(e.height) * s,
    ...(Array.isArray(e.points) ? { points: scalePts(e.points) } : {}),
    ...(Array.isArray(e.lastCommittedPoint)
      ? { lastCommittedPoint: scalePts([e.lastCommittedPoint])![0] }
      : {}),
    seed: Math.floor(Math.random() * 2 ** 31),
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  }));
}
