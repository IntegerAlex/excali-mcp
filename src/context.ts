import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * The context file is the single source of truth shared by CLI, UI and agents.
 * OpenCode workflow: read it, change `mermaidSource` (or `elements`), then run
 * `diagram-tool render` to re-derive the scene — or just edit elements directly.
 */
export interface DiagramContext {
  version: 1;
  /** incremented on every write; UI polls this to pick up CLI/agent edits */
  rev: number;
  prompt: string;
  mermaidSource: string;
  scene: {
    type: "excalidraw";
    version: 2;
    elements: unknown[];
  };
  updatedAt: string;
}

export const DEFAULT_CONTEXT = "diagram-tool.context.json";
/** Pre-rename default. Read as fallback; first save migrates to DEFAULT_CONTEXT. */
export const LEGACY_CONTEXT = "diagramforge.context.json";

export function blankContext(prompt = ""): DiagramContext {
  return {
    version: 1,
    rev: 0,
    prompt,
    mermaidSource: "",
    scene: { type: "excalidraw", version: 2, elements: [] },
    updatedAt: new Date().toISOString(),
  };
}

export async function loadContext(path: string): Promise<DiagramContext> {
  if (!existsSync(path) && path === DEFAULT_CONTEXT && existsSync(LEGACY_CONTEXT)) {
    path = LEGACY_CONTEXT; // pre-rename file: read it, next save migrates
  }
  if (!existsSync(path)) return blankContext();
  const raw = await readFile(path, "utf8");
  try {
    const c = JSON.parse(raw) as DiagramContext;
    if (!c.scene) c.scene = { type: "excalidraw", version: 2, elements: [] };
    if (typeof c.rev !== "number") c.rev = 0;
    if (typeof c.mermaidSource !== "string") c.mermaidSource = "";
    return c;
  } catch (e) {
    // Corrupt file (crash mid-write, hand-edit gone wrong): quarantine it,
    // start blank. Never crash the server/CLI on a bad JSON file.
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      await writeFile(backup, raw);
    } catch {
      /* best effort */
    }
    console.error(`[context] ${path} is corrupt (${e instanceof Error ? e.message : String(e)}); backed up to ${backup}, starting blank.`);
    return blankContext();
  }
}

/** Crash-safe write: tmp file + rename, so readers never see half a JSON. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Applies patch, bumps rev, writes file + sidecars. Returns the new context. */
export async function saveContext(
  path: string,
  patch: Partial<Pick<DiagramContext, "prompt" | "mermaidSource">> & { elements?: unknown[] },
): Promise<DiagramContext> {
  const prev = await loadContext(path);
  const next: DiagramContext = {
    ...prev,
    version: 1,
    rev: prev.rev + 1,
    updatedAt: new Date().toISOString(),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    ...(patch.mermaidSource !== undefined ? { mermaidSource: patch.mermaidSource } : {}),
    scene: {
      type: "excalidraw",
      version: 2,
      elements: patch.elements !== undefined ? patch.elements : prev.scene.elements,
    },
  };
  await writeAtomic(path, JSON.stringify(next, null, 2));
  // sidecars for direct import into excalidraw.com
  const base = path.replace(/\.context\.json$/, "").replace(/\.json$/, "");
  await writeAtomic(`${base}.excalidraw.json`, JSON.stringify({ ...next.scene, source: "diagram-tool", appState: {} }, null, 2));
  await writeAtomic(`${base}.mmd`, (next.mermaidSource ? next.mermaidSource + "\n" : ""));
  return next;
}
