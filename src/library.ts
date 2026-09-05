import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

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
  scale?: number;
  x?: number;
  y?: number;
}

/**
 * Clone library items onto the scene with fresh ids + remapped internal refs,
 * scaled, auto-tiled along the bottom row unless explicit x/y given.
 */
export async function applyDecorations(
  elements: Record<string, unknown>[],
  decorations: Decoration[],
): Promise<{ added: number; placed: { library: string; itemIndex: number; elementIds: string[] }[] }> {
  if (decorations.length > 6) throw new Error("Max 6 decorations per render (keeps diagrams readable).");
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  const xs = elements.flatMap((e) => (typeof e.x === "number" && typeof e.width === "number" ? [e.x as number, (e.x as number) + (e.width as number)] : []));
  const ys = elements.flatMap((e) => (typeof e.y === "number" && typeof e.height === "number" ? [e.y as number, (e.y as number) + (e.height as number)] : []));
  let cursorX = xs.length ? Math.min(...xs) : 0;
  const baseY = ys.length ? Math.max(...ys) + 60 : 0;
  const placed: { library: string; itemIndex: number; elementIds: string[] }[] = [];
  let added = 0;
  for (const d of decorations) {
    const { groups } = await loadLibraryBySlug(d.library, d.libraryUrl);
    const template = groups[d.itemIndex];
    if (!template) throw new Error(`Item ${d.itemIndex} out of range for "${d.library}" (0–${groups.length - 1}). Use list_library_items to repick.`);
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
  return { added, placed };
}

/**
 * Fit a library item's artwork into a node card: strip its own caption text
 * (the node's label stays), normalize coords, scale into the top of the box,
 * node caption pinned to the bottom strip.
 */
export function instantiateIcon(
  template: Record<string, unknown>[],
  box: { x: number; y: number; w: number; h: number },
  groupId: string,
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
  const targetH = Math.max(24, box.h - 46);
  const targetW = Math.max(24, box.w - 24);
  const s = Math.min(targetW / natW, targetH / natH);
  const offX = box.x + box.w / 2 - (natW * s) / 2 - minX * s;
  const offY = box.y + 10 - minY * s;
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  return art.map((e) => ({
    ...e,
    id: freshId(),
    groupIds: [groupId],
    x: num(e.x) * s + offX,
    y: num(e.y) * s + offY,
    width: num(e.width) * s,
    height: num(e.height) * s,
    seed: Math.floor(Math.random() * 2 ** 31),
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  }));
}
