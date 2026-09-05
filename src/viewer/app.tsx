import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

interface Ctx {
  rev: number;
  prompt: string;
  scene: { elements: Record<string, unknown>[] };
}

interface LibItem {
  id: string;
  status: string;
  elements: Record<string, unknown>[];
}

/** JSON-faithful, order-insensitive hash. Live Excalidraw objects carry
 *  `undefined` fields that JSON drops on save — plain comparison would see
 *  phantom diffs and rewrite the file on every load. */
function canon(v: unknown): string {
  if (v === undefined) return "null";
  if (typeof v === "number" && !isFinite(v)) return "null";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon(o[k]))}}`;
  }
  return JSON.stringify(v) ?? "";
}

import { mergeElements } from "../merge.js";

/** Frame all elements (verified working; retry once late for font settling). */
function fitView(a: ExcalidrawImperativeAPI): void {
  try {
    a.scrollToContent();
  } catch {
    /* ignore */
  }
}

interface Vp {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}

/** Viewport framing computed BEFORE mount — no timers, no animation races. */
export function fitViewport(
  elements: { x: number; y: number; width: number; height: number }[],
  vw: number,
  vh: number,
): Vp {
  const finite = elements.filter(
    (e) => [e.x, e.y, e.width, e.height].every((v) => typeof v === "number" && isFinite(v)),
  );
  if (finite.length === 0) return { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  const pad = 60;
  const topPad = 132; // clear the floating toolbar + hint text
  const minX = Math.min(...finite.map((e) => e.x)) - pad;
  const minY = Math.min(...finite.map((e) => e.y)) - pad;
  const maxX = Math.max(...finite.map((e) => e.x + e.width)) + pad;
  const maxY = Math.max(...finite.map((e) => e.y + e.height)) + pad;
  const zoom = Math.min(2, Math.min(vw / (maxX - minX), (vh - topPad) / (maxY - minY)));
  return {
    scrollX: (-(minX + maxX) / 2) * zoom + vw / 2,
    scrollY: -minY * zoom + topPad,
    zoom: { value: isFinite(zoom) && zoom > 0 ? zoom : 1 },
  };
}

function App(): React.ReactElement {
  const [initial, setInitial] = useState<Ctx | null>(null);
  const [library, setLibrary] = useState<LibItem[] | null>(null);
  const [rev, setRev] = useState<number>(-1);
  const [sync, setSync] = useState("loading…");
  const [error, setError] = useState<string | null>(null);
  const revRef = useRef(-1);
  const lastEdit = useRef(0);
  const lastSaved = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/context")
      .then((r) => {
        if (!r.ok) throw new Error(`context: HTTP ${r.status}`);
        return r.json() as Promise<Ctx>;
      })
      .then((c) => {
        revRef.current = c.rev;
        setRev(c.rev);
        setInitial(c);
        lastSaved.current = canon(c.scene.elements);
        setSync("synced");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Libraries are best-effort: viewer works without them.
    fetch("/api/libraries")
      .then((r) => (r.ok ? (r.json() as Promise<LibItem[]>) : null))
      .then((l) => {
        if (l) setLibrary(l);
      })
      .catch(() => {});
  }, []);

  const saveNow = useCallback(async () => {
    const a = (window as unknown as { __exaApi?: ExcalidrawImperativeAPI }).__exaApi;
    if (!a) return;
    const elements = a.getSceneElements() as unknown[];
    // Don't write when nothing changed — onChange also fires on load/scroll,
    // and every write bumps rev (which would ping-pong with the poller).
    const hash = canon(elements);
    if (hash === lastSaved.current) {
      setSync("synced");
      return;
    }
    setSync("saving…");
    try {
      const r = await fetch("/api/scene", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rev: revRef.current, elements }),
      });
      if (r.status === 409) {
        // Someone (agent/CLI) wrote first: merge our edits on top of theirs
        // and retry once with the fresh rev, instead of discarding our work.
        const fresh = (await r.json()) as { context: Ctx };
        const merged = mergeElements(
          fresh.context.scene.elements,
          elements as Record<string, unknown>[],
        );
        const r2 = await fetch("/api/scene", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rev: fresh.context.rev, elements: merged }),
        });
        if (r2.status === 409 || !r2.ok) {
          // Lost the race twice — take remote, user can re-apply.
          const latest = r2.status === 409 ? ((await r2.json()) as { context: Ctx }).context : fresh.context;
          revRef.current = latest.rev;
          setRev(latest.rev);
          lastSaved.current = canon(latest.scene.elements);
          a.updateScene({ elements: latest.scene.elements as never });
          setSync("remote won — re-apply your edit");
          return;
        }
        const data2 = (await r2.json()) as { rev: number };
        revRef.current = data2.rev;
        setRev(data2.rev);
        lastSaved.current = canon(merged);
        a.updateScene({ elements: merged as never });
        setSync("merged with remote change");
        return;
      }
      if (!r.ok) throw new Error(`save: HTTP ${r.status}`);
      const data = (await r.json()) as { rev: number };
      revRef.current = data.rev;
      setRev(data.rev);
      lastSaved.current = hash;
      setSync("synced");
    } catch (e) {
      setSync("save failed — retrying");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveNow(), 3000);
    }
  }, []);

  const onChange = useCallback(() => {
    lastEdit.current = Date.now();
    setSync("editing…");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), 800);
  }, [saveNow]);

  // Live updates: server watches the context file and pushes rev bumps
  // over SSE. Applies only when no local edit is in flight.
  // (EventSource reconnects by itself on drop.)
  useEffect(() => {
    const src = new EventSource("/api/live");
    src.addEventListener("rev", () => {
      void (async () => {
        if (Date.now() - lastEdit.current < 3000) return;
        try {
          const r = await fetch("/api/context");
          if (!r.ok) return;
          const ctx = (await r.json()) as Ctx;
          if (ctx.rev === revRef.current) return;
          revRef.current = ctx.rev;
          setRev(ctx.rev);
          lastSaved.current = canon(ctx.scene.elements);
          const a = (window as unknown as { __exaApi?: ExcalidrawImperativeAPI }).__exaApi;
          if (a) {
            // Elements only — never touch the viewport here, or every agent
            // render would yank the user's zoom/pan. Initial framing happens
            // once via initialData.
            a.updateScene({ elements: ctx.scene.elements as never });
          }
          setSync("updated from file");
          setTimeout(() => setSync("synced"), 2000);
        } catch {
          /* keep old state */
        }
      })();
    });
    return () => src.close();
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h2>Failed to load</h2>
        <pre>{error}</pre>
        <p>Is the diagram-tool server running? Expected <code>/api/context</code> on this host.</p>
      </div>
    );
  }
  if (!initial) return <div style={{ padding: 24, fontFamily: "system-ui" }}>loading…</div>;
  const title = initial.prompt.length > 80 ? initial.prompt.slice(0, 80) + "…" : initial.prompt || "diagram";
  const vp = fitViewport(
    initial.scene.elements as { x: number; y: number; width: number; height: number }[],
    window.innerWidth,
    window.innerHeight - 40,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header style={{ padding: "8px 12px", borderBottom: "1px solid #eee", fontSize: 13, color: "#444" }}>
        {title} · Diagram Tool · rev {rev} ·{" "}
        <a href="/scene.excalidraw.json" download>
          download .excalidraw
        </a>{" "}
        · <a href="/scene.mmd" download>download .mmd</a> · <span>{sync}</span>
      </header>
      <div style={{ flex: 1 }}>
        <Excalidraw
          excalidrawAPI={(a) => {
            (window as unknown as { __exaApi?: ExcalidrawImperativeAPI }).__exaApi = a;
          }}
          initialData={{ elements: initial.scene.elements as never, appState: vp as never, libraryItems: (library ?? undefined) as never }}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
