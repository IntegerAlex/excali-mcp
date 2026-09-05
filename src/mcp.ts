/** diagram-tool mcp — hand-rolled MCP JSON-RPC over stdio. No deps, stderr-only logs. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext, saveContext } from "./context.js";
import { convertToScene, lintEdgeLabels, lintFanIn, validateMermaid } from "./diagram.js";
import { detachArrowLabels } from "./geometry.js";
import { applyDecorations, listLibraries, loadLibraryBySlug, type Decoration } from "./library.js";
import { startServer, type StartedServer } from "./server.js";
import {
  GET_DESCRIPTION, GUIDE, LIST_ITEMS_DESCRIPTION, LIST_LIBRARIES_DESCRIPTION,
  RENDER_DESCRIPTION, SERVER_INSTRUCTIONS,
} from "./guide.js";

interface RpcMsg {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Package version for diagnostics (which code served this render?). Sync + cached. */
let versionCache: string | null = null;
export function getVersion(): string {
  if (versionCache) return versionCache;
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version?: string };
    versionCache = pkg.version ?? "dev";
  } catch {
    versionCache = "dev";
  }
  return versionCache;
}

const TOOLS = [
  {
    name: "render_diagram",
    description: RENDER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        mermaidSource: { type: "string", description: "Full mermaid diagram source." },
        prompt: { type: "string", description: "Short label of what changed (stored in context)." },
        decorations: {
          type: "array",
          description:
            "Optional library icons (max 6). Discover via list_libraries + list_library_items. IMPORTANT: set `node` to the target diagram node id or label for each icon (you know the mapping, e.g. SQS icon -> node 'SQS Queue') — the icon then BECOMES that node. Omit `node` only to auto-match by name; unmatched icons tile below the diagram.",
          items: {
            type: "object",
            properties: {
              library: { type: "string", description: "Library slug, e.g. aws-serverless." },
              itemIndex: { type: "integer", description: "Item index from list_library_items." },
              node: { type: "string", description: "Target diagram node id or label. REQUIRED for a clean result — without it the icon may land in a disconnected row." },
              allowGrow: { type: "boolean", description: "Enlarge the node box to fit art + caption (default false = art scales to fit the SDK box). Growth applies only if the grown rect is clear of neighbors; otherwise it silently fits. Use when the icon renders too small." },
              libraryUrl: { type: "string", description: "Custom .excalidrawlib URL (rarely needed)." },
              scale: { type: "number", description: "Scale multiplier, default 1." },
              x: { type: "number", description: "Explicit x (default: auto-tiled row)." },
              y: { type: "number", description: "Explicit y (default: below diagram)." },
            },
            required: ["library", "itemIndex"],
          },
        },
      },
      required: ["mermaidSource"],
    },
  },
  {
    name: "get_diagram",
    description: GET_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_libraries",
    description: LIST_LIBRARIES_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'aws', 'network'. Empty = top picks." },
      },
    },
  },
  {
    name: "list_library_items",
    description: LIST_ITEMS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        library: { type: "string", description: "Slug from list_libraries." },
        search: { type: "string", description: "Filter by name substring." },
        libraryUrl: { type: "string", description: "Custom .excalidrawlib URL." },
      },
      required: ["library"],
    },
  },
];

const RESOURCES = [
  { uri: "diagram-tool://guide", name: "Diagram Tool agent guide", mimeType: "text/markdown" },
];

export interface McpOptions {
  context: string;
  port: number;
  noServe: boolean;
}

export async function runMcp(opts: McpOptions): Promise<void> {
  let singleton: StartedServer | null = null;
  const ensureUrl = async (): Promise<string | null> => {
    if (opts.noServe) return null;
    if (!singleton) singleton = await startServer(opts.context, opts.port);
    return singleton.url;
  };

  const callTool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    switch (name) {
      case "render_diagram": {
        const source = args.mermaidSource;
        if (typeof source !== "string" || !source.trim()) {
          return { text: JSON.stringify({ error: "mermaidSource (string) is required." }), isError: true };
        }
        try {
          await validateMermaid(source.trim());
        } catch (e) {
          return { text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), isError: true };
        }
        const long = lintEdgeLabels(source.trim());
        if (long.length > 0) {
          return {
            text: JSON.stringify({
              error: `Edge labels too long — they blob on canvas. Rewrite each to ≤4 words and move detail into node labels: ${long.map((l) => `"${l.label}" (${l.words} words)`).join("; ")}. Then retry with the full source.`,
            }),
            isError: true,
          };
        }
        let scene;
        try {
          scene = await convertToScene(source.trim());
        } catch (e) {
          return { text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), isError: true };
        }
        let placed: unknown = undefined;
        const decos = args.decorations as Decoration[] | undefined;
        if (Array.isArray(decos) && decos.length > 0) {
          try {
            const r = await applyDecorations(scene.elements as Record<string, unknown>[], decos);
            placed = r.placed;
          } catch (e) {
            return { text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), isError: true };
          }
        } else {
          // No decorations: detach arrow labels here (applyDecorations does it when present).
          detachArrowLabels(scene.elements as Record<string, unknown>[]);
        }
        const next = await saveContext(opts.context, {
          ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
          mermaidSource: source.trim(),
          elements: scene.elements as unknown[],
        });
        const url = await ensureUrl();
        const base = opts.context.replace(/\.context\.json$/, "").replace(/\.json$/, "");
        const fanIn = lintFanIn(source.trim());
        return {
          text: JSON.stringify({
            rev: next.rev, elements: (scene.elements as unknown[]).length, url,
            server: `diagram-tool@${getVersion()}`,
            excalidrawJson: `${base}.excalidraw.json`, mmd: `${base}.mmd`,
            ...(placed !== undefined ? { placed } : {}),
            ...(fanIn.length > 0
              ? {
                  warnings: [
                    `Fan-in hot spots (>5 edges on one node — layout degrades past this; split via hub/intermediate nodes toward ≤3/node): ${fanIn.map((f) => `${f.node} (${f.degree})`).join(", ")}.`,
                  ],
                }
              : {}),
          }),
        };
      }
      case "get_diagram": {
        const ctx = await loadContext(opts.context);
        return { text: JSON.stringify({ rev: ctx.rev, prompt: ctx.prompt, mermaidSource: ctx.mermaidSource }) };
      }
      case "list_libraries": {
        const q = typeof args.query === "string" ? args.query : "";
        return { text: JSON.stringify(listLibraries(q)) };
      }
      case "list_library_items": {
        const lib = args.library;
        if (typeof lib !== "string" || !lib) {
          return { text: JSON.stringify({ error: "library (slug string) is required." }), isError: true };
        }
        try {
          const { groups, names } = await loadLibraryBySlug(
            lib, typeof args.libraryUrl === "string" ? args.libraryUrl : undefined,
          );
          const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
          const items = groups.map((els, index) => {
            const kinds = els.map((e) => String(e.type));
            const kind = kinds.sort((a, b) =>
              kinds.filter((k) => k === a).length - kinds.filter((k) => k === b).length).pop() ?? "unknown";
            return { index, name: names[index] ?? `item ${index}`, kind };
          }).filter((it) => !search || it.name.toLowerCase().includes(search));
          return { text: JSON.stringify({ library: lib, count: groups.length, items }) };
        } catch (e) {
          return { text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), isError: true };
        }
      }
      default:
        return { text: JSON.stringify({ error: `Unknown tool "${name}".` }), isError: true };
    }
  };

  const handle = async (msg: RpcMsg): Promise<Record<string, unknown> | null> => {
    const id = msg.id ?? null;
    const respond = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (msg.method) {
        case "initialize":
          return respond({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "diagram-tool", version: getVersion() },
            instructions: SERVER_INSTRUCTIONS,
          });
        case "ping":
          return respond({});
        case "tools/list":
          return respond({ tools: TOOLS });
        case "tools/call": {
          const p = msg.params ?? {};
          const r = await callTool(String(p.name), (p.arguments as Record<string, unknown>) ?? {});
          return respond({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        }
        case "resources/list":
          return respond({ resources: RESOURCES });
        case "resources/read": {
          const uri = String((msg.params ?? {}).uri ?? "");
          if (uri === "diagram-tool://guide" || uri === "diagram-tool:///guide") {
            return respond({ contents: [{ uri: "diagram-tool://guide", mimeType: "text/markdown", text: GUIDE }] });
          }
          return fail(-32602, `Unknown resource "${uri}".`);
        }
        default:
          // Notifications (no id) get no response; unknown requests get Method-not-found.
          if (id === null || id === undefined) return null;
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      if (id === null || id === undefined) return null;
      return fail(-32603, e instanceof Error ? e.message : String(e));
    }
  };

  // Framing: MCP stdio is newline-delimited JSON; also accept Content-Length framing.
  let buf = Buffer.alloc(0);
  const dispatch = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  };
  const pump = async (): Promise<void> => {
    for (;;) {
      const text = buf.toString("utf8");
      const clMatch = /^Content-Length:\s*(\d+)\r?\n/i.exec(text);
      if (clMatch) {
        const len = Number(clMatch[1]);
        const headerEnd = text.indexOf("\n\n") !== -1 ? text.indexOf("\n\n") + 2 : text.indexOf("\r\n\r\n") + 4;
        const start = Buffer.byteLength(text.slice(0, headerEnd));
        if (buf.length < start + len) break;
        const body = buf.subarray(start, start + len).toString("utf8");
        buf = buf.subarray(start + len);
        await dispatch(body);
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      await dispatch(line);
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    pending++;
    void pump()
      .catch((e) => console.error(`[mcp] pump: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        pending--;
        void maybeExit();
      });
  });
  let stdinEnded = false;
  let pending = 0;
  const maybeExit = async (): Promise<void> => {
    if (stdinEnded && pending === 0) {
      // flush stdout before exiting
      await new Promise((r) => setTimeout(r, 20));
      process.exit(0);
    }
  };
  process.stdin.on("end", () => {
    stdinEnded = true;
    void maybeExit();
  });
  process.stdin.resume();
}
