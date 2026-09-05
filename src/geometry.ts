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

 * Breathing space pass. The converter packs nodes per its own (often wrong)
 * measurements, so labels collide. This iteratively pushes overlapping boxes
 * apart and drags attached arrow endpoints + labels along (arrows here are
 * free-floating: start/end are plain id refs, no live bindings).
 */
export function declutter(elements: Record<string, unknown>[]): Record<string, unknown>[] {
  type Box = { x: number; y: number; w: number; h: number };
  const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
  const boxOf = (e: Record<string, unknown>): Box => ({
    x: num(e.x),
    y: num(e.y),
    w: Math.max(1, num(e.width, 10)),
    h: Math.max(1, num(e.height, 10)),
  });
  const movers = elements.filter(
    (e) =>
      (e.type === "rectangle" || e.type === "diamond" || e.type === "ellipse") &&
      !((e.groupIds as string[] | undefined) ?? []).some((g) => typeof g === "string" && g.startsWith("icon-")),
  );
  // Sanitize stored dimensions: math below is guarded, but a NaN width/height
  // must never reach the file/canvas.
  for (const m of movers) {
    m.width = Math.max(1, num(m.width, 10));
    m.height = Math.max(1, num(m.height, 10));
    m.x = num(m.x);
    m.y = num(m.y);
  }
  // Icon groups (icon-as-node replacements deleted their container rect):
  // treat each group bbox as a mover; moves translate all members.
  // Returns nodeId for arrow attachment (group `icon-X` -> node `X`).
  const groupOf = (e: Record<string, unknown>): string | null => {
    const g = e.groupIds as string[] | undefined;
    if (!Array.isArray(g)) return null;
    const hit = g.find((x) => typeof x === "string" && x.startsWith("icon-"));
    return hit ?? null;
  };
  const membersOf = (group: string): Record<string, unknown>[] =>
    elements.filter((e) => ((e.groupIds as string[] | undefined) ?? []).includes(group));
  const bboxOf = (members: Record<string, unknown>[]): Box | null => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const e of members) {
      const x = num(e.x, NaN);
      const y = num(e.y, NaN);
      const w = num(e.width, NaN);
      const h = num(e.height, NaN);
      if (![x, y, w, h].every((v) => isFinite(v))) continue;
      xs.push(x, x + w);
      ys.push(y, y + h);
    }
    if (xs.length === 0) return null;
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
  };
  interface ProxyMover { __proxy: string; nodeId: string; x: number; y: number; width: number; height: number }
  const proxies: ProxyMover[] = [];
  {
    const seen = new Set<string>();
    for (const e of elements) {
      const g = groupOf(e);
      if (!g || seen.has(g)) continue;
      seen.add(g);
      const members = membersOf(g);
      // Skip groups whose container rect still exists (moved as container).
      // Skip groups whose container rect still exists (moved as container).
      const b = bboxOf(members);
      if (!b) continue;
      const hasContainer = members.some(
        (m) => (m.type === "rectangle" || m.type === "diamond" || m.type === "ellipse") && movers.includes(m),
      );
      if (hasContainer) continue;
      proxies.push({ __proxy: g, nodeId: g.replace(/^icon-/, ""), x: b.x, y: b.y, width: b.w, height: b.h });
    }
  }
  const allMovers: Record<string, unknown>[] = [...movers, ...(proxies as unknown as Record<string, unknown>[])];

  // Dynamic PAD: scale with LARGEST element (icons 130-150px) not average,
  // so big elements always get enough breathing room.
  const maxDim = (() => {
    let mx = 0;
    for (const m of allMovers) {
      const w = num(m.width, 0);
      const h = num(m.height, 0);
      mx = Math.max(mx, w, h);
    }
    return mx || 60;
  })();
  const PAD = Math.max(50, maxDim * 0.4);

  const moveText = (containerId: string, dx: number, dy: number, moved: Set<string>): void => {
    for (const e of elements) {
      if (e.type === "text" && e.containerId === containerId && !moved.has(String(e.id))) {
        e.x = num(e.x) + dx;
        e.y = num(e.y) + dy;
        moved.add(String(e.id));
      }
    }
  };

  /** Move everything grouped with the container (icon art, captions) as one unit. */
  const moveGroup = (containerId: string, dx: number, dy: number, moved: Set<string>): void => {
    const anchor = elements.find((e) => String(e.id) === containerId);
    const groups = new Set((anchor?.groupIds as string[] | undefined) ?? []);
    if (groups.size === 0) return;
    for (const e of elements) {
      if (moved.has(String(e.id))) continue;
      const g = e.groupIds as string[] | undefined;
      if (Array.isArray(g) && g.some((x) => groups.has(x))) {
        e.x = num(e.x) + dx;
        e.y = num(e.y) + dy;
        moved.add(String(e.id));
      }
    }
  };

  /** Shift arrow endpoints attached to `id` by (dx,dy); point coords are
   *  coerced — a single null/undefined point must not NaN the whole arrow. */
  const moveArrowEnds = (id: string, dx: number, dy: number): { dx: number; dy: number }[] => {
    const deltas: { dx: number; dy: number }[] = [];
    for (const e of elements) {
      if (e.type !== "arrow") continue;
      const raw = e.points as [number, number][] | undefined;
      if (!raw || raw.length === 0) continue;
      const pts = raw.map(([px, py]) => [num(px), num(py)] as [number, number]);
      e.points = pts;
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

  /** Translate a mover (real element or icon-group proxy) and its attachments. */
  const translate = (M: Record<string, unknown>, dx: number, dy: number, touched: Set<string>): void => {
    const proxy = M.__proxy as string | undefined;
    if (proxy) {
      for (const m of membersOf(proxy)) {
        if (touched.has(String(m.id))) continue;
        m.x = num(m.x) + dx;
        m.y = num(m.y) + dy;
        touched.add(String(m.id));
      }
      M.x = num(M.x) + dx;
      M.y = num(M.y) + dy;
      // Arrows still reference the original node id.
      moveArrowEnds((M as unknown as ProxyMover).nodeId, dx, dy);
      return;
    }
    M.x = num(M.x) + dx;
    M.y = num(M.y) + dy;
    touched.add(String(M.id));
    moveText(String(M.id), dx, dy, touched);
    moveGroup(String(M.id), dx, dy, touched);
    moveArrowEnds(String(M.id), dx, dy);
  };

  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < allMovers.length; i++) {
      for (let j = i + 1; j < allMovers.length; j++) {
        const A = allMovers[i]!;
        const B = allMovers[j]!;
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
        const touched = new Set<string>([String(A.id), String(B.id)]);
        translate(A, dxA, dyA, touched);
        translate(B, dxB, dyB, touched);
      }
    }
    if (!moved) break;
  }

  // Keep arrow labels near their (possibly moved) arrows: re-seat each label
  // at its arrow's midpoint if it drifted more than 120px away.
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const raw = e.points as [number, number][] | undefined;
    if (!raw || raw.length === 0) continue;
    const ox = num(e.x);
    const oy = num(e.y);
    const mid = raw[Math.floor(raw.length / 2)]!;
    const mx = ox + num(mid[0]);
    const my = oy + num(mid[1]);
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

 * Mermaid centers edge labels on arrow midpoints, which on short edges lands
 * inside a node box. Slide such labels along the arrow until clear. Bound
 * text stays associated via containerId, so this never detaches meaning.
 */
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
  // Node captions carry containerId pointing at their own rectangle (or sit
  // in an icon-* group). They are anchored by design — marchOut must only
  // ever touch arrow-bound edge labels. Hoisted here so both marchOut loops
  // below can use it.
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
  const marchOut = (t: Record<string, unknown>): void => {    let cx = num(t.x) + num(t.width) / 2;
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
    if (isCaption(t)) continue;
    if ([t.x, t.y, t.width, t.height].some((v) => typeof v !== "number" || !isFinite(v as number))) continue;
    marchOut(t);
  }
  // Pairwise label-label separation. Push apart along the center-connecting
  // line (least-overlap axis fails for same-line pairs: it slides them along
  // the shared edge instead of apart). Node captions are anchored — when a
  // caption collides with a free label, only the label moves.
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
    if (isCaption(t)) continue;
    if ([t.x, t.y, t.width, t.height].some((v) => typeof v !== "number" || !isFinite(v as number))) continue;
    marchOut(t);
  }
  separatePairs();
  // Endpoints moved (declutter/reanchor) but dagre-era midpoints never did —
  // collapsing them kills the stale S-curves. Runs here so every caller
  // (diagram.ts, applyDecorations, MCP path) gets it; endpoints untouched so
  // label positions from the passes above stay valid.
  straightenArrows(elements);
  return elements;
}

/**
 * Collapse stale intermediate arrow waypoints onto the straight segment
 * between the (already re-anchored) endpoints. declutter/moveArrowEnds only
 * ever move pts[0]/pts[last]; dagre-era middles survive and render as loops
 * once nodes have shifted. Endpoints untouched; degenerate input skipped.
 */
export function straightenArrows(elements: Record<string, unknown>[]): void {
  const num = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : NaN);
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    const pts = e.points as [number, number][] | undefined;
    if (!pts || pts.length < 3) continue;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const fx = num(first[0]);
    const fy = num(first[1]);
    const lx = num(last[0]);
    const ly = num(last[1]);
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(lx) || !isFinite(ly)) continue;
    const n = pts.length;
    for (let i = 1; i < n - 1; i++) {
      const t = i / (n - 1);
      pts[i] = [fx + (lx - fx) * t, fy + (ly - fy) * t];
    }
  }
}

/**
 * Detach arrow-bound labels: Excalidraw re-snaps bound arrow text to the
 * arrow midpoint at render time, undoing the separation above. Must be
 * called LAST — after all declutter/slide passes — so labels move with
 * their arrows while still bound.
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
    if (typeof el.width !== "number" || !Number.isFinite(el.width)) {
      el.width = Math.max(20, label.text.length * fontSize * 0.6) + 20;
    }
    if (typeof el.height !== "number" || !Number.isFinite(el.height)) {
      el.height = fontSize * 1.3 + 12;
    }
    const w = el.width as number;
    const h = el.height as number;
    const x = typeof el.x === "number" ? el.x : 0;
    const y = typeof el.y === "number" ? el.y : 0;
    const textW = Math.max(20, label.text.length * fontSize * 0.6);
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
