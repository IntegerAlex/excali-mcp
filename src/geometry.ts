/** Shared scene geometry: converter output post-processing.
 *  No local imports — safe for diagram.ts, library.ts (MCP path) alike.
 *  All coordinate math is finite-guarded: degenerate input shifts nothing.
 */

let autoIdCounter = 0;

/** Move arrow endpoints attached to `id` out onto the border of `box`.
 *  All point math is coerced — degenerate input shifts nothing, never NaN. */
export function reanchor(elements: Record<string, unknown>[], id: string, box: { x: number; y: number; w: number; h: number }): void {
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const anchor = (px: number, py: number): [number, number] => {
    const dx = num(px) - cx;
    const dy = num(py) - cy;
    if (dx === 0 && dy === 0) return [cx, box.y - 2];
    const sx = dx !== 0 ? box.w / 2 / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? box.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy) + 2 / Math.max(Math.abs(dx), Math.abs(dy), 1);
    if (!isFinite(t)) return [cx, box.y - 2];
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
  // Identity-based throughout: the SDK reuses one id for parallel same-pair
  // arrows ("A_B" x2) and leaves others id-less, so id strings can never
  // identify a single element. Keeper claims its label first (labels are
  // created in element order, matching their arrows).
  const seen = new Map<string, Record<string, unknown>>();
  const drop = new Set<Record<string, unknown>>();
  const claimed = new Set<Record<string, unknown>>();
  const labelFor = (arrow: Record<string, unknown>): Record<string, unknown> | undefined =>
    elements.find((e) => e.type === "text" && e.containerId === arrow.id && !drop.has(e) && !claimed.has(e));

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
    const keepLabel = labelFor(keeper);
    if (keepLabel) claimed.add(keepLabel);
    const dupLabel = labelFor(e);
    if (dupLabel) claimed.add(dupLabel);
    if (dupLabel && typeof dupLabel.text === "string" && dupLabel.text) {
      if (keepLabel && keepLabel !== dupLabel && typeof keepLabel.text === "string" && keepLabel.text) {
        const merged = `${keepLabel.text} · ${dupLabel.text as string}`;
        keepLabel.text = merged;
        keepLabel.originalText = merged;
        const fs = typeof keepLabel.fontSize === "number" ? keepLabel.fontSize : 16;
        keepLabel.width = Math.max(20, merged.length * fs * 0.6);
      } else if (!keepLabel) {
        dupLabel.containerId = keeper.id;
        const bound = keeper.boundElements as { id: string; type: string }[] | undefined;
        if (Array.isArray(bound)) bound.push({ id: String(dupLabel.id), type: "text" });
      }
    }
    drop.add(e);
    if (dupLabel && dupLabel.containerId === e.id) drop.add(dupLabel);
  }
  if (drop.size === 0) return elements;
  return elements.filter((e) => !drop.has(e));
}





/**
 * Detach arrow-bound labels: Excalidraw re-snaps bound arrow text to the
 * arrow midpoint at render time. Must be called LAST — after icon
 * replacement — so labels move with their arrows while still bound.
 */
export function detachArrowLabels(elements: Record<string, unknown>[]): void {
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const bound = e.boundElements as { id: string; type: string }[] | undefined;
    if (!Array.isArray(bound)) continue;
    e.boundElements = bound.filter((b) => {
      const t = elements.find((x) => x.id === b.id && x.type === "text");
      if (!t) return false;
      delete t.containerId;
      return false;
    });
  }
}

/**

 * @excalidraw/mermaid-to-excalidraw v2 emits node text as a non-standard
 * `label: { text, fontSize }` prop that the canvas ignores. Rewrite each into
 * a real bound `text` element wired via containerId/boundElements.
 */
export function withBoundLabels(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  const out = [...elements];
  for (const el of elements) {
    // The SDK leaves some skeletons id-less (frame labels, notes). Excalidraw
    // needs unique ids — synthesize before wiring anything by id.
    if (typeof el.id !== "string" || !el.id) {
      el.id = `auto-${Date.now().toString(36)}${(autoIdCounter++).toString(36)}`;
    }
    const label = el.label as { text?: string; fontSize?: number } | undefined;
    if (!label || typeof label.text !== "string" || !label.text) continue;
    const fontSize = label.fontSize ?? 20;
    // The SDK intentionally leaves label-driven boxes (e.g. alt-frame tags)
    // unsized ("width calculated based on label"): fill from text metrics so
    // no element ships with non-finite geometry. Real geometry is never touched.
    // Measure per-LINE: label.text routinely spans lines ("A\nB") and the old
    // whole-string metrics made multiline captions single-line height (26px
    // for 2 lines at fs=20) — every spacing pass downstream inherited it.
    const labelLines = label.text.split("\n");
    const longestLine = Math.max(1, ...labelLines.map((l) => l.length));
    if (typeof el.width !== "number" || !Number.isFinite(el.width)) {
      el.width = Math.max(20, longestLine * fontSize * 0.6) + 20;
    }
    if (typeof el.height !== "number" || !Number.isFinite(el.height)) {
      el.height = labelLines.length * fontSize * 1.3 + 12;
    }
    const w = el.width as number;
    const h = el.height as number;
    const x = typeof el.x === "number" ? el.x : 0;
    const y = typeof el.y === "number" ? el.y : 0;
    const textW = Math.max(20, longestLine * fontSize * 0.6);
    const textH = labelLines.length * fontSize * 1.3;
    const textId = `${String(el.id)}-label`;
    out.push({
      id: textId,
      type: "text",
      x: x + w / 2 - textW / 2,
      y: y + h / 2 - textH / 2,
      width: textW,
      height: textH,
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
