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
export function slideEdgeLabelsOutOfNodes(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  const boxes = elements.filter(
    (e) =>
      (e.type === "rectangle" || e.type === "diamond" || e.type === "ellipse") &&
      [e.x, e.y, e.width, e.height].every((v) => typeof v === "number" && isFinite(v)),
  );
  if (boxes.length === 0) return elements;
  // Icon groups have no container rect (deleted on replacement) — their bbox
  // is an obstacle too, or labels land on top of icon art.
  {
    const seen = new Set<string>();
    for (const e of elements) {
      const g = (e.groupIds as string[] | undefined) ?? [];
      const icon = g.find((x) => typeof x === "string" && x.startsWith("icon-"));
      if (!icon || seen.has(icon)) continue;
      seen.add(icon);
      const members = elements.filter((m) => ((m.groupIds as string[] | undefined) ?? []).includes(icon));
      const xs: number[] = [];
      const ys: number[] = [];
      for (const m of members) {
        if ([m.x, m.y, m.width, m.height].every((v) => typeof v === "number" && isFinite(v))) {
          xs.push(num(m.x), num(m.x) + num(m.width));
          ys.push(num(m.y), num(m.y) + num(m.height));
        }
      }
      if (xs.length > 0) {
        boxes.push({
          type: "__iconbox",
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        });
      }
    }
  }
  // Dynamic margin: icons (80-150px) need more clearance than text boxes.
  const avgBoxDim = (() => {
    let s = 0, n = 0;
    for (const b of boxes) { s += num(b.width) + num(b.height); n += 2; }
    return n > 0 ? s / n : 40;
  })();
  const MARGIN = Math.max(16, avgBoxDim * 0.25);
  const inside = (x: number, y: number): boolean =>
    boxes.some((b) => {
      const bx = num(b.x);
      const by = num(b.y);
      const bw = num(b.width);
      const bh = num(b.height);
      return x >= bx - MARGIN && x <= bx + bw + MARGIN && y >= by - MARGIN && y <= by + bh + MARGIN;
    });
  const marchOut = (t: Record<string, unknown>): void => {
    let cx = num(t.x) + num(t.width) / 2;
    let cy = num(t.y) + num(t.height) / 2;
    if (!inside(cx, cy)) return;
    const arrow = elements.find((e) => e.type === "arrow" && e.id === (t as { containerId?: string }).containerId);
    // Detached labels lost containerId — fall back to vertical exit.
    const pts = (arrow?.points as [number, number][] | undefined) ?? [];
    const first = pts[0];
    const last = pts[pts.length - 1];
    let dx = last && first ? num(last[0]) - num(first[0]) : 0;
    let dy = last && first ? num(last[1]) - num(first[1]) : 0;
    const len = Math.hypot(dx, dy);
    if (!isFinite(len) || len < 1) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    const march = (sx: number, sy: number): number => {
      let d = 0;
      while (d < 800 && inside(cx + sx * d, cy + sy * d)) d += 6;
      return d;
    };
    const fwd = march(dx, dy);
    const back = march(-dx, -dy);
    const [ux, uy] = fwd <= back ? [dx, dy] : [-dx, -dy];
    const dist = Math.min(fwd, back) + 6;
    t.x = num(t.x) + ux * dist;
    t.y = num(t.y) + uy * dist;
  };
  for (const t of elements) {
    if (t.type !== "text" || typeof t.containerId !== "string") continue;
    if ([t.x, t.y, t.width, t.height].some((v) => typeof v !== "number" || !isFinite(v as number))) continue;
    // Arrow-bound edge labels only: node captions (containerId = box id)
    // are centered in their boxes by construction — "inside" is correct.
    if (!elements.some((e) => e.type === "arrow" && e.id === t.containerId)) continue;
    marchOut(t);
  }
  // Pairwise label-label separation. Push apart along the center-connecting
  // line (least-overlap axis fails for same-line pairs: it slides them along
  // the shared edge instead of apart). Node captions are anchored — when a
  // caption collides with a free label, only the label moves.
  const isCaption = (e: Record<string, unknown>): boolean => {
    if (e.type !== "text") return false;
    const cid = e.containerId;
    if (typeof cid === "string") {
      const c = elements.find((x) => x.id === cid);
      if (c && (c.type === "rectangle" || c.type === "diamond" || c.type === "ellipse")) return true;
    }
    const g = e.groupIds as string[] | undefined;
    return Array.isArray(g) && g.some((x) => typeof x === "string" && x.startsWith("icon-"));
  };
  const labels = elements.filter(
    (e) =>
      e.type === "text" &&
      [e.x, e.y, e.width, e.height].every((v) => typeof v === "number" && isFinite(v)),
  );
  const center = (e: Record<string, unknown>): [number, number] => [
    num(e.x) + num(e.width) / 2,
    num(e.y) + num(e.height) / 2,
  ];
  const separatePairs = (): void => {
    for (let iter = 0; iter < 10; iter++) {
      let moved = false;
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const A = labels[i]!;
          const B = labels[j]!;
        const [ax, ay] = center(A);
        const [bx, by] = center(B);
        const ox = (num(A.width) + num(B.width)) / 2 - Math.abs(ax - bx) + 14;
        const oy = (num(A.height) + num(B.height)) / 2 - Math.abs(ay - by) + 14;
        if (ox <= 0 || oy <= 0) continue;
        const capA = isCaption(A);
        const capB = isCaption(B);
        if (capA && capB) continue; // two anchored captions: leave to node pass
        // Direction: center-connecting line. Anchored captions don't move.
        let dx = ax - bx;
        let dy = ay - by;
        const len = Math.hypot(dx, dy);
        if (!isFinite(len) || len < 1) {
          dx = 1;
          dy = 0;
        } else {
          dx /= len;
          dy /= len;
        }
        const step = (Math.min(ox, oy) + 14) / 2;
        moved = true;
        if (!capA) {
          A.x = num(A.x) + dx * step;
          A.y = num(A.y) + dy * step;
        }
        if (!capB) {
          B.x = num(B.x) - dx * step;
          B.y = num(B.y) - dy * step;
        }
        if (capA !== capB) {
          // Anchored side stays: give the free side the full distance.
          const F = capA ? B : A;
          const s = capA ? -1 : 1;
          F.x = num(F.x) + dx * s * step;
          F.y = num(F.y) + dy * s * step;
        }
      }
    }
    if (!moved) break;
  }
  };
  separatePairs();
  // Pairwise splits can push labels back inside boxes — march out again.
  // This pass covers detached labels too (vertical fallback, no arrow needed).
  // Pairwise runs once more after, so the final word on label-label
  // collisions is separation, not box-escape.
  for (const t of elements) {
    if (t.type !== "text") continue;
    if ([t.x, t.y, t.width, t.height].some((v) => typeof v !== "number" || !isFinite(v as number))) continue;
    // Anchored captions live inside their boxes by design — only free and
    // detached edge labels march here.
    if (isCaption(t)) continue;
    marchOut(t);
  }
  separatePairs();
  return elements;
}

