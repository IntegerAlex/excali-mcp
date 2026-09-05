import "./dom-shim.js";
import mermaid from "mermaid";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { complete, type ChatMsg, type LlmOpts } from "./llm.js";
import { instantiateIcon, loadIconTemplates } from "./library.js";
import { existsSync } from "node:fs";

export interface Scene {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
}

const SYSTEM = `You author Mermaid diagrams like a diagramming craftsman. Output ONLY one fenced \`\`\`mermaid block (one short sentence before it allowed). Never prose instead of a diagram.

TYPE CHOICE:
- processes / decisions / architecture -> flowchart (LR for wide, TD for tall)
- interactions over time -> sequenceDiagram; data models -> erDiagram
- OOP structure -> classDiagram; states -> stateDiagram-v2
- Supported types ONLY: flowchart/graph, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2.

FLOWCHART CRAFT (applies to every flowchart):
- Start with this init line for breathing room (exact syntax):
  %%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 90, "curve": "linear"}}}%%
- Use SELF-EXPLANATORY node ids (CLI, CTXFILE, WEBUI — never A/B/C).
- Declare ALL nodes first (one per line), then edges grouped with blank lines between logical groups. Add %% comments per group.
- Structure with %% section comments + blank lines, NOT subgraphs: the renderer cannot draw subgraphs and degrades the whole diagram. Example:
  %% -- agent loop --
  AGENT["OpenCode agent loop"]
  LLM["OpenRouter LLM"]
  AGENT-->|prompts|LLM
  LLM-->|completion|AGENT
- Shared nodes (one target, many sources) get their own line each — never hide a fan-in inside a chain.
- Edge labels use pipe syntax ONLY: -->|reads| (never -- reads -->). Every non-obvious edge gets a label.
- Quote labels with special chars: ["label (x)"].
- Shape by role, renderer-safe only: rhombus {..} for decisions, plain [...] for everything else (stadium/cylinder silently collapse to rectangles, so don't rely on them).
- End every flowchart with this palette + a class on EVERY node:
  classDef actor fill:#e3f2fd,stroke:#1e88e5,stroke-width:2px
  classDef store fill:#fff3e0,stroke:#fb8c00,stroke-width:2px
  classDef flow fill:#e8f5e9,stroke:#43a047,stroke-width:2px
  classDef ext fill:#f3e5f5,stroke:#8e24aa,stroke-width:2px
  (actor = people/agents, store = files/data, flow = processes, ext = external services)
- Max ~12 nodes. Split unrelated concerns instead of shrinking. LR for wide flows, TD for tall ones.
- Hub content (many edges through one shared node) → use TD: hubs laid horizontally always collide; vertical stacking gives edges room.
- Fan-in discipline: max 3 edges into any single node. More than that, introduce an intermediate collector node (e.g. CTXWRITE["writes"] vs CTXREAD["reads"]) or split the flow — hub-and-spoke layouts always overlap.
- One edge per node pair, always: if several actions share the same source and target, combine them into ONE edge with a joint label (CLI-->|generate · edit · render · serve|CTXWRITE). Parallel duplicate arrows are forbidden.
- People/nodes with real-world meaning get an icon class IN ADDITION to their color class: class USER icon_user (available: icon_user, icon_users, icon_home, icon_lock, icon_search, icon_chart, icon_email, icon_calendar, icon_location, icon_payment). Example: class USER actor,icon_user. Only use these ten — never invent others.

SEQUENCE CRAFT: participants declared first with aliases (participant C as Client); every request has a matching -->> reply; activate/deactivate around long handlers.

Example (note ids, declare-first, section comments, classes):
\`\`\`mermaid
%%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 90, "curve": "linear"}}}%%
flowchart LR
    USER(["User"])
    CLI["diagram-tool CLI"]
    CTXFILE["diagram-tool.context.json"]
    WEBUI["React Excalidraw UI"]

    %% invoke + generate
    USER-->|invokes|CLI
    CLI-->|writes rev|CTXFILE

    %% view loop (no subgraphs — the renderer cannot draw them)
    CTXFILE-->|polls|WEBUI

    classDef actor fill:#e3f2fd,stroke:#1e88e5,stroke-width:2px
    classDef store fill:#fff3e0,stroke:#fb8c00,stroke-width:2px
    classDef flow fill:#e8f5e9,stroke:#43a047,stroke-width:2px
    classDef ext fill:#f3e5f5,stroke:#8e24aa,stroke-width:2px
    class USER actor
    class CLI,WEBUI flow
    class CTXFILE store
\`\`\`
`;

const SUPPORTED = new Set(["flowchart", "graph", "sequenceDiagram", "erDiagram", "classDiagram", "stateDiagram-v2", "stateDiagram"]);

let mermaidInit = false;
function ensureMermaid(): void {
  if (!mermaidInit) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    mermaidInit = true;
  }
}

export function extractMermaid(raw: string): string {
  const m = /```mermaid\s*([\s\S]*?)```/i.exec(raw);
  if (m?.[1]?.trim()) return m[1].trim();
  throw new Error("Model did not return a ```mermaid block. Raw output:\n" + raw.slice(0, 1000));
}

export async function validateMermaid(source: string): Promise<string> {
  ensureMermaid();
  // Strip leading %% comments / %%{init}%% directives before type detection.
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("%%"))
    .join("\n")
    .trim();
  const diagramType = code.split(/\s+/)[0] ?? "";
  if (!SUPPORTED.has(diagramType)) {
    throw new Error(`Unsupported diagram type "${diagramType}". Supported: flowchart, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2.`);
  }
  await mermaid.parse(source); // strict: throws on syntax errors
  return diagramType;
}

export async function convertToScene(mermaidSource: string): Promise<Scene> {
  const { elements } = await parseMermaidToExcalidraw(mermaidSource, {
    flowchart: { curve: "linear" },
    themeVariables: { fontSize: "20px" },
    maxEdges: 500,
  });
  const els = (elements ?? []) as Record<string, unknown>[];
  // The converter degrades to a single `image` placeholder (or empty) when it
  // hits constructs it can't render (e.g. subgraphs). Never save that —
  // throw so the caller repairs/retries instead of persisting a broken scene.
  if (els.length === 0 || els.every((e) => e.type === "image")) {
    throw new Error(
      "Converter produced no drawable elements (likely an unsupported construct such as subgraph — flatten it into plain nodes + edges).",
    );
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "diagram-tool",
    elements: declutter(await applyIcons(declutter(dedupeArrows(withBoundLabels(els))), mermaidSource)),
    appState: {},
  };
}

/** nodeId -> icon slug from `class NODE icon_slug` statements in the source. */
export function parseIconClasses(mermaidSource: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of mermaidSource.split("\n")) {
    const m = /^\s*class\s+([\w,\s]+?)\s+([\w,\s]+?)\s*$/.exec(line);
    if (!m) continue;
    const nodes = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    const classes = m[2]!.split(",").map((s) => s.trim()).filter(Boolean);
    if (nodes.includes("classDef") || classes.includes("classDef")) continue;
    for (const n of nodes) {
      for (const c of classes) {
        if (c.startsWith("icon_")) out.set(n, c);
      }
    }
  }
  return out;
}

let iconCache: Promise<Map<string, Record<string, unknown>[]>> | null = null;

/**
 * Dress node cards with library artwork: icon glyph fitted into the top of
 * the box, node caption pinned to the bottom strip, all grouped for UI drag.
 * Unknown slugs / missing libraries degrade to plain boxes (never throw).
 */
export async function applyIcons(
  elements: Record<string, unknown>[],
  mermaidSource: string,
  libraryDir = "libraries",
): Promise<Record<string, unknown>[]> {
  const mapping = parseIconClasses(mermaidSource);
  if (mapping.size === 0 || !existsSync(libraryDir)) return elements;
  if (!iconCache) iconCache = loadIconTemplates(libraryDir);
  const templates = await iconCache;
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  for (const [nodeId, slug] of mapping) {
    const node = elements.find((e) => String(e.id) === nodeId && (e.type === "rectangle" || e.type === "diamond"));
    const template = templates.get(slug);
    if (!node || !template) continue;
    // Grow small converter boxes into icon cards (centered), then re-anchor
    // attached arrow endpoints onto the new border.
    const caption = elements.find((e) => e.type === "text" && e.containerId === nodeId) as
      | { width?: number; fontSize?: number }
      | undefined;
    const capW = caption ? num(caption.width, 40) + 34 : 0;
    const oldBox = { x: num(node.x), y: num(node.y), w: Math.max(1, num(node.width, 80)), h: Math.max(1, num(node.height, 40)) };
    const newW = Math.max(oldBox.w, 132, capW);
    const newH = Math.max(oldBox.h, 108);
    node.x = oldBox.x - (newW - oldBox.w) / 2;
    node.y = oldBox.y - (newH - oldBox.h) / 2;
    node.width = newW;
    node.height = newH;
    const box = { x: num(node.x), y: num(node.y), w: newW, h: newH };
    reanchor(elements, nodeId, box);
    const groupId = `icon-${nodeId}`;
    const art = instantiateIcon(template, box, groupId);
    if (art.length === 0) continue;
    if (caption) {
      const c = caption as Record<string, unknown>;
      const fs = num(c.fontSize, 16);
      c.y = box.y + box.h - fs * 1.5 - 6;
      c.x = box.x + box.w / 2 - num(c.width, 40) / 2;
      const g = c.groupIds as string[] | undefined;
      c.groupIds = [...(g ?? []), groupId];
    }
    const g = node.groupIds as string[] | undefined;
    node.groupIds = [...(g ?? []), groupId];
    elements.push(...art);
  }
  return elements;
}

/** Move arrow endpoints attached to `id` out onto the border of `box`. */
function reanchor(elements: Record<string, unknown>[], id: string, box: { x: number; y: number; w: number; h: number }): void {
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const anchor = (px: number, py: number): [number, number] => {
    const dx = px - cx;
    const dy = py - cy;
    if (dx === 0 && dy === 0) return [cx, box.y - 2];
    const sx = dx !== 0 ? box.w / 2 / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? box.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy) + 2 / Math.max(Math.abs(dx), Math.abs(dy), 1);
    return [cx + dx * t, cy + dy * t];
  };
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const pts = e.points as [number, number][] | undefined;
    if (!pts || pts.length === 0) continue;
    const ox = num(e.x);
    const oy = num(e.y);
    const start = e.start as { id?: string } | undefined;
    const end = e.end as { id?: string } | undefined;
    if (start?.id === id && pts[0]) {
      const [ax, ay] = anchor(ox + pts[0][0], oy + pts[0][1]);
      const ddx = ax - (ox + pts[0][0]);
      const ddy = ay - (oy + pts[0][1]);
      pts[0] = [pts[0][0] + ddx, pts[0][1] + ddy];
      shiftArrowLabel(elements, e, ddx / 2, ddy / 2);
    }
    if (end?.id === id && pts.length > 1) {
      const last = pts[pts.length - 1]!;
      const [ax, ay] = anchor(ox + last[0], oy + last[1]);
      const ddx = ax - (ox + last[0]);
      const ddy = ay - (oy + last[1]);
      pts[pts.length - 1] = [last[0] + ddx, last[1] + ddy];
      shiftArrowLabel(elements, e, ddx / 2, ddy / 2);
    }
  }
}

function shiftArrowLabel(elements: Record<string, unknown>[], arrow: Record<string, unknown>, dx: number, dy: number): void {
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  for (const t of elements) {
    if (t.type === "text" && t.containerId === arrow.id) {
      t.x = num(t.x) + dx;
      t.y = num(t.y) + dy;
    }
  }
}

/**
 * Merge parallel arrows (same source id -> same target id) into one. The
 * model sometimes emits one edge per action (generate/edit/render/serve),
 * which renders as stacked duplicate arrows. Keeper = first arrow; labels
 * are concatenated with " · " and surplus arrows + labels removed.
 */
export function dedupeArrows(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  const keyOf = (e: Record<string, unknown>): string | null => {
    const s = (e.start as { id?: string } | undefined)?.id;
    const t = (e.end as { id?: string } | undefined)?.id;
    return s && t ? `${s}\u0000${t}` : null;
  };
  const seen = new Map<string, Record<string, unknown>>();
  const drop = new Set<string>();
  const labelOf = (arrowId: string): Record<string, unknown> | undefined =>
    elements.find((e) => e.type === "text" && e.containerId === arrowId && !drop.has(String(e.id)));

  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const k = keyOf(e);
    if (!k) continue;
    const keeper = seen.get(k);
    if (!keeper) {
      seen.set(k, e);
      continue;
    }
    // duplicate: fold its label into the keeper's, then remove arrow + label
    const dupLabel = labelOf(String(e.id));
    if (dupLabel && typeof dupLabel.text === "string" && dupLabel.text) {
      const keepLabel = labelOf(String(keeper.id));
      if (keepLabel && typeof keepLabel.text === "string" && keepLabel.text) {
        const merged = `${keepLabel.text} · ${dupLabel.text as string}`;
        keepLabel.text = merged;
        keepLabel.originalText = merged;
        const fs = typeof keepLabel.fontSize === "number" ? keepLabel.fontSize : 16;
        keepLabel.width = Math.max(20, merged.length * fs * 0.55);
      } else if (!keepLabel) {
        dupLabel.containerId = keeper.id;
        const bound = keeper.boundElements as { id: string; type: string }[] | undefined;
        if (Array.isArray(bound)) bound.push({ id: String(dupLabel.id), type: "text" });
      }
    }
    drop.add(String(e.id));
    if (dupLabel && dupLabel.containerId === e.id) drop.add(String(dupLabel.id));
  }
  if (drop.size === 0) return elements;
  return elements.filter((e) => !drop.has(String(e.id)));
}

/**
 * Breathing space pass. The converter packs nodes per its own (often wrong)
 * measurements, so labels collide. This iteratively pushes overlapping boxes
 * apart and drags attached arrow endpoints + labels along (arrows here are
 * free-floating: start/end are plain id refs, no live bindings).
 */
export function declutter(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  type Box = { x: number; y: number; w: number; h: number };
  const PAD = 36;
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  const boxOf = (e: Record<string, unknown>): Box => ({
    x: num(e.x),
    y: num(e.y),
    w: Math.max(1, num(e.width, 10)),
    h: Math.max(1, num(e.height, 10)),
  });
  const movers = elements.filter((e) => e.type === "rectangle" || e.type === "diamond" || e.type === "ellipse");

  const moveText = (containerId: string, dx: number, dy: number): void => {
    for (const e of elements) {
      if (e.type === "text" && e.containerId === containerId) {
        e.x = num(e.x) + dx;
        e.y = num(e.y) + dy;
      }
    }
  };

  /** Shift arrow endpoints attached to `id` by (dx,dy); returns actual applied delta for labels. */
  const moveArrowEnds = (id: string, dx: number, dy: number): { dx: number; dy: number }[] => {
    const deltas: { dx: number; dy: number }[] = [];
    for (const e of elements) {
      if (e.type !== "arrow") continue;
      const pts = e.points as [number, number][] | undefined;
      if (!pts || pts.length === 0) continue;
      const start = e.start as { id?: string } | undefined;
      const end = e.end as { id?: string } | undefined;
      let usedDx = 0;
      let usedDy = 0;
      if (start?.id === id && pts[0]) {
        pts[0] = [pts[0][0] + dx, pts[0][1] + dy];
        usedDx += dx;
        usedDy += dy;
      }
      const last = pts[pts.length - 1]!;
      if (end?.id === id && pts.length > 1) {
        pts[pts.length - 1] = [last[0] + dx, last[1] + dy];
        usedDx += dx;
        usedDy += dy;
      }
      if (usedDx !== 0 || usedDy !== 0) {
        deltas.push({ dx: usedDx / 2, dy: usedDy / 2 });
        // drag the arrow's own label along with the midpoint shift
        for (const t of elements) {
          if (t.type === "text" && t.containerId === e.id) {
            t.x = num(t.x) + usedDx / 2;
            t.y = num(t.y) + usedDy / 2;
          }
        }
      }
    }
    return deltas;
  };

  const overlaps = (a: Box, b: Box): { ox: number; oy: number } | null => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + PAD;
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + PAD;
    return ox > 0 && oy > 0 ? { ox, oy } : null;
  };

  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const A = movers[i]!;
        const B = movers[j]!;
        const ov = overlaps(boxOf(A), boxOf(B));
        if (!ov) continue;
        moved = true;
        // Push along the axis of least overlap.
        let dxA = 0;
        let dyA = 0;
        let dxB = 0;
        let dyB = 0;
        if (ov.ox < ov.oy) {
          const dir = boxOf(A).x + boxOf(A).w / 2 <= boxOf(B).x + boxOf(B).w / 2 ? -1 : 1;
          dxA = (dir * ov.ox) / 2;
          dxB = (-dir * ov.ox) / 2;
        } else {
          const dir = boxOf(A).y + boxOf(A).h / 2 <= boxOf(B).y + boxOf(B).h / 2 ? -1 : 1;
          dyA = (dir * ov.oy) / 2;
          dyB = (-dir * ov.oy) / 2;
        }
        A.x = num(A.x) + dxA;
        A.y = num(A.y) + dyA;
        B.x = num(B.x) + dxB;
        B.y = num(B.y) + dyB;
        moveText(String(A.id), dxA, dyA);
        moveText(String(B.id), dxB, dyB);
        moveArrowEnds(String(A.id), dxA, dyA);
        moveArrowEnds(String(B.id), dxB, dyB);
      }
    }
    if (!moved) break;
  }

  // Keep arrow labels near their (possibly moved) arrows: re-seat each label
  // at its arrow's midpoint if it drifted more than 120px away.
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const pts = e.points as [number, number][] | undefined;
    if (!pts || pts.length === 0) continue;
    const ox = num(e.x);
    const oy = num(e.y);
    const mid = pts[Math.floor(pts.length / 2)]!;
    const mx = ox + mid[0];
    const my = oy + mid[1];
    for (const t of elements) {
      if (t.type === "text" && t.containerId === e.id) {
        const cx = num(t.x) + num(t.width, 0) / 2;
        const cy = num(t.y) + num(t.height, 0) / 2;
        if (Math.hypot(mx - cx, my - cy) > 120) {
          t.x = mx - num(t.width, 0) / 2;
          t.y = my - num(t.height, 0) / 2;
        }
      }
    }
  }
  return elements;
}

/**
 * @excalidraw/mermaid-to-excalidraw v2 emits node text as a non-standard
 * `label: { text, fontSize }` prop that the canvas ignores. Rewrite each into
 * a real bound `text` element wired via containerId/boundElements.
 */
export function withBoundLabels(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  const out = [...elements];
  for (const el of elements) {
    const label = el.label as { text?: string; fontSize?: number } | undefined;
    if (!label || typeof label.text !== "string" || !label.text) continue;
    const fontSize = label.fontSize ?? 20;
    const w = typeof el.width === "number" ? el.width : 80;
    const h = typeof el.height === "number" ? el.height : 30;
    const x = typeof el.x === "number" ? el.x : 0;
    const y = typeof el.y === "number" ? el.y : 0;
    const textW = Math.max(20, label.text.length * fontSize * 0.55);
    const textId = `${String(el.id)}-label`;
    out.push({
      id: textId,
      type: "text",
      x: x + w / 2 - textW / 2,
      y: y + h / 2 - fontSize * 0.65,
      width: textW,
      height: fontSize * 1.3,
      angle: 0,
      strokeColor: (el.strokeColor as string) ?? "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      seed: typeof el.seed === "number" ? el.seed + 1 : 1,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      isDeleted: false,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: [],
      updated: Date.now(),
      locked: false,
      text: label.text,
      originalText: label.text,
      fontSize,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      containerId: el.id,
      autoResize: true,
    });
    el.boundElements = [...((el.boundElements as unknown[]) ?? []), { id: textId, type: "text" }];
    delete el.label;
  }
  return out;
}

export interface GenerateOpts extends LlmOpts {
  existingMermaid?: string;
}

export interface GenerateResult {
  scene: Scene;
  mermaidSource: string;
  attempts: number;
  repaired: boolean;
}

/** Prompt -> Mermaid -> validate (2 repairs, error fed back) -> Excalidraw scene. */
export async function generate(prompt: string, opts: GenerateOpts): Promise<GenerateResult> {
  const base: ChatMsg[] = [{ role: "system", content: SYSTEM }];
  let user = `Request: ${prompt}\n\nReturn the diagram as one \`\`\`mermaid block.`;
  if (opts.existingMermaid?.trim()) {
    user =
      `Current diagram (EDIT it, preserve node IDs unless told otherwise):\n\`\`\`mermaid\n${opts.existingMermaid.trim()}\n\`\`\`\n\nEdit instruction: ${prompt}\n\nReturn the FULL updated diagram as one \`\`\`mermaid block.`;
  }
  let messages: ChatMsg[] = [...base, { role: "user", content: user }];
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await complete(messages, opts);
    let source: string;
    try {
      source = extractMermaid(raw);
      await validateMermaid(source);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.error(`attempt ${attempt}: ${lastErr.split("\n")[0]}`);
      if (attempt === 3) throw new Error(`Mermaid invalid after 3 attempts. Last error: ${lastErr}`);
      messages = [...base, { role: "user", content: `Your previous Mermaid failed:\n${lastErr}\n\nPrevious output:\n\`\`\`mermaid\n${raw.slice(0, 2000)}\n\`\`\`\n\nFix ONLY the syntax and return the full diagram as one \`\`\`mermaid block.` }];
      continue;
    }
    const scene = await convertToScene(source).catch((e) => {
      lastErr = e instanceof Error ? e.message : String(e);
      console.error(`attempt ${attempt}: conversion failed: ${lastErr.split("\n")[0]}`);
      return null;
    });
    if (!scene) {
      if (attempt === 3) throw new Error(`Conversion failed after 3 attempts. Last error: ${lastErr}`);
      messages = [...base, { role: "user", content: `Your Mermaid parses but cannot be rendered:\n${lastErr}\n\nPrevious output:\n\`\`\`mermaid\n${source.slice(0, 2000)}\n\`\`\`\n\nRewrite WITHOUT the unsupported construct (flatten subgraphs into plain nodes + edges) and return the full diagram as one \`\`\`mermaid block.` }];
      continue;
    }
    return { scene, mermaidSource: source, attempts: attempt, repaired: attempt > 1 };
  }
  throw new Error(`unreachable (last: ${lastErr})`);
}
