import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve as serveHono } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { loadContext, saveContext } from "./context.js";
import { loadLibraryItems, libraryDir } from "./library.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/
const PUBLIC = join(HERE, "public");

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><title>Diagram Tool</title>
<link rel="stylesheet" href="/viewer.css">
<style>html,body{margin:0;height:100%}#app{height:100%}</style>
</head><body>
<div id="app"><div style="padding:24px;font-family:system-ui">loading…</div></div>
<script type="module" src="/viewer.js"></script>
</body></html>`;

const STATIC_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

export async function serve(contextPath: string, port: number): Promise<void> {
  const app = buildApp(contextPath);
  await new Promise<void>((resolve, reject) => {
    try {
      const server = serveHono({ fetch: app.fetch, port }, () => {
        console.log(`\nDiagram live at http://localhost:${port}  (context: ${contextPath}, Ctrl+C to stop)`);
        resolve();
      });
      server.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
  await new Promise(() => {}); // run until killed
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Non-blocking start for embedding (MCP server). Shares buildApp with serve().
 * Falls back to a free port on EADDRINUSE; url always reflects the actual port. */
export async function startServer(contextPath: string, port: number): Promise<StartedServer> {
  const app = buildApp(contextPath);
  let server: ReturnType<typeof serveHono>;
  const listen = (p: number): Promise<ReturnType<typeof serveHono>> => {
    const s = serveHono({ fetch: app.fetch, port: p });
    const on = s as unknown as { once(e: string, l: (arg?: unknown) => void): void };
    return new Promise((resolve, reject) => {
      on.once("listening", () => resolve(s));
      on.once("error", (err) => reject(err));
    });
  };
  try {
    server = await listen(port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE" && port !== 0) {
      server = await listen(0);
    } else {
      throw e;
    }
  }
  const actual = (server.address() as { port: number }).port;
  const url = `http://localhost:${actual}`;
  console.error(`Diagram live at ${url}  (context: ${contextPath})`);
  return {
    url,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { close(cb: () => void): void }).close(() => resolve());
      }),
  };
}

function buildApp(contextPath: string): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(SHELL));

  app.get("/api/context", async (c) => {
    try {
      return c.json(await loadContext(contextPath));
    } catch (e) {
      return c.text(`error: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  });

  app.post("/api/scene", async (c) => {
    let body: { rev?: number; elements?: unknown[] };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!Array.isArray(body.elements)) return c.json({ error: "elements[] required" }, 400);
    const current = await loadContext(contextPath);
    if (typeof body.rev === "number" && body.rev !== current.rev) {
      return c.json({ error: "rev conflict", context: current }, 409);
    }
    const next = await saveContext(contextPath, { elements: body.elements });
    console.error(`[sync] rev ${current.rev} -> ${next.rev} (${body.elements.length} elements)`);
    return c.json({ rev: next.rev });
  });

  app.get("/api/libraries", async (c) => {
    const items = await loadLibraryItems(libraryDir());
    return c.json(items.map((it) => ({ id: it.id, status: "published", elements: it.elements })));
  });

  // Live updates: watch the context file, push rev bumps over SSE.
  // Viewer refetches /api/context on each event (small event, big payload stays on pull).
  app.get("/api/live", (c) => {
    return streamSSE(c, async (stream) => {
      let lastRev = (await loadContext(contextPath).catch(() => ({ rev: -1 }))).rev;
      await stream.writeSSE({ event: "hello", data: String(lastRev) });
      const watcher = watch(contextPath, async () => {
        try {
          const ctx = await loadContext(contextPath);
          if (ctx.rev !== lastRev) {
            lastRev = ctx.rev;
            await stream.writeSSE({ event: "rev", data: String(ctx.rev) });
          }
        } catch {
          /* context temporarily unreadable mid-write — next event retries */
        }
      });
      stream.onAbort(() => watcher.close());
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
    });
  });

  app.get("/scene.excalidraw.json", async (c) => {
    const ctx = await loadContext(contextPath);
    return c.json({ ...ctx.scene, source: "diagram-tool", appState: {} });
  });

  app.get("/scene.mmd", async (c) => {
    const ctx = await loadContext(contextPath);
    return c.text(ctx.mermaidSource ? ctx.mermaidSource + "\n" : "");
  });

  // Pre-bundled viewer + fonts (dist/public, absolute path so CWD doesn't matter).
  app.use("/*", async (c, next) => {
    const p = c.req.path;
    if (p.startsWith("/api/") || p === "/" || p === "/scene.excalidraw.json" || p === "/scene.mmd") {
      return next();
    }
    if (!/^\/[A-Za-z0-9._-]+$/.test(p)) return c.text("not found", 404);
    try {
      const body = await readFile(join(PUBLIC, p.slice(1)));
      const type = STATIC_TYPES[extname(p)] ?? "application/octet-stream";
      const cache = p === "/viewer.js" || p === "/viewer.css" ? "no-store" : "max-age=86400";
      c.header("content-type", type);
      c.header("cache-control", cache);
      return c.body(body);
    } catch {
      return c.text("not found", 404);
    }
  });

  return app;
}
