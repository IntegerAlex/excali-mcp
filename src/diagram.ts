import "./dom-shim.js";
import mermaid from "mermaid";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { complete, type ChatMsg, type LlmOpts } from "./llm.js";
import { loadIconTemplates } from "./library.js";
import { declutter, dedupeArrows, detachArrowLabels, reanchor, slideEdgeLabelsOutOfNodes, withBoundLabels } from "./geometry.js";
export { declutter, dedupeArrows, detachArrowLabels, reanchor, slideEdgeLabelsOutOfNodes, straightenArrows, withBoundLabels } from "./geometry.js";
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
  %%{init: {"flowchart": {"nodeSpacing": 100, "rankSpacing": 140, "curve": "linear"}}}%%
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
- Hub content (many edges through one shared node: monitoring, context files, queues) → use TD. Hubs laid horizontally always collide; vertical stacking gives edges room.
- Max ~5 nodes per rank/row. More than that, restructure (chain through intermediates or switch direction) instead of one long row.
- Hub content (many edges through one shared node) → use TD: hubs laid horizontally always collide; vertical stacking gives edges room.
- Fan-in discipline: max 3 edges into any single node. More than that, introduce an intermediate collector node (e.g. CTXWRITE["writes"] vs CTXREAD["reads"]) or split the flow — hub-and-spoke layouts always overlap.
- One edge per node pair, always: if several actions share the same source and target, combine them into ONE edge with a joint label (CLI-->|generate · edit · render · serve|CTXWRITE). Parallel duplicate arrows are forbidden.
- People/nodes with real-world meaning get an icon class IN ADDITION to their color class: class USER actor,icon_user (available: icon_user, icon_users, icon_home, icon_lock, icon_search, icon_chart, icon_email, icon_calendar, icon_location, icon_payment). Example: class USER actor,icon_user. Only use these ten — never invent others. The icon BECOMES the node (box replaced, arrows re-attached).

SEQUENCE CRAFT: participants declared first with aliases (participant C as Client); every request has a matching -->> reply; activate/deactivate around long handlers.

Example (note ids, declare-first, section comments, classes):
\`\`\`mermaid
%%{init: {"flowchart": {"nodeSpacing": 100, "rankSpacing": 140, "curve": "linear"}}}%%
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

/** First non-comment token: flowchart, sequenceDiagram, erDiagram, ... */
export function sniffDiagramType(source: string): string {
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("%%"))
    .join("\n")
    .trim();
  return code.split(/\s+/)[0] ?? "";
}

export function extractMermaid(raw: string): string {
  const m = /```mermaid\s*([\s\S]*?)```/i.exec(raw);
  if (m?.[1]?.trim()) return m[1].trim();
  throw new Error("Model did not return a ```mermaid block. Raw output:\n" + raw.slice(0, 1000));
}

export async function validateMermaid(source: string): Promise<string> {
  ensureMermaid();
  const diagramType = sniffDiagramType(source);
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
  // dedupeArrows exists for the model's flowchart habit of emitting one edge
  // per action between the same pair. In sequences/ER/class diagrams repeated
  // same-pair links are meaningful — merging deletes real messages. Gate it.
  const isFlow = sniffDiagramType(mermaidSource) === "flowchart" || sniffDiagramType(mermaidSource) === "graph";
  let out = withBoundLabels(els);
  if (isFlow) out = dedupeArrows(out);
  out = declutter(out);
  if (isFlow) out = await applyIcons(out, mermaidSource);
  out = declutter(out);
  out = slideEdgeLabelsOutOfNodes(out);
  // NOTE: detachArrowLabels is NOT called here. When decorations are
  // applied, labels must stay bound during declutter so they move with
  // arrows. The MCP handler (or applyDecorations) calls detach last.
  return {
    type: "excalidraw",
    version: 2,
    source: "diagram-tool",
    elements: out,
    appState: {},
  };
}

/** nodeId -> icon slug from `class NODE icon_slug` statements in the source. */
export function parseIconClasses(mermaidSource: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of mermaidSource.split("\n")) {
    const m = /^\s*class\s+([\w,\s-]+?)\s+([\w,\s-]+?)\s*$/.exec(line);
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

/** Pipe-form edge labels (`-->|label|`) from flowchart source (comments skipped). */
export function edgeLabels(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("%%")) continue;
    for (const m of t.matchAll(/\|([^|\n]+)\|/g)) {
      const label = m[1]!.trim();
      if (label) out.push(label);
    }
  }
  return out;
}

export interface LongLabel {
  label: string;
  chars: number;
  words: number;
}

/** Labels that blob on canvas: >50 chars or >7 words. Hard-gate these. */
export function lintEdgeLabels(source: string): LongLabel[] {
  const bad: LongLabel[] = [];
  for (const label of edgeLabels(source)) {
    const chars = label.length;
    const words = label.split(/\s+/).filter(Boolean).length;
    if (chars > 50 || words > 7) bad.push({ label, chars, words });
  }
  return bad;
}

let iconCache: Promise<Map<string, Record<string, unknown>[]>> | null = null;

/**
 * icon_* classes (e.g. class USER actor,icon_user): the library icon BECOMES
 * the node — box deleted, art fitted, caption stacked below, arrows
 * re-anchored. Delegates to library.replaceNodeWithIcon (same path as MCP
 * decoration matching). Unknown slugs / missing libraries leave plain boxes.
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
  const { replaceNodeWithIcon } = await import("./library.js");
  for (const [nodeId, slug] of mapping) {
    const template = templates.get(slug);
    if (!template) continue;
    replaceNodeWithIcon(elements, nodeId, template);
  }
  return elements;
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
