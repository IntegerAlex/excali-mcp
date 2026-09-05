/** Minimal DOM so mermaid works in Node. Import BEFORE mermaid. */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true });

function setGlobal(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>;
  if (g[key] !== undefined) return;
  try {
    g[key] = value;
  } catch {
    try {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    } catch {
      /* leave built-in (e.g. Node 22 getter-only navigator) */
    }
  }
}

const w = dom.window as unknown as Record<string, unknown>;
setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
for (const k of [
  "DOMParser", "XMLSerializer", "Element", "SVGElement", "SVGSVGElement",
  "HTMLElement", "Node", "Text", "CSSStyleSheet", "CustomEvent", "Event",
  "MutationObserver", "navigator", "location", "self", "DOMRect",
]) {
  setGlobal(k, w[k]);
}
for (const k of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia"]) {
  const v = w[k];
  setGlobal(k, typeof v === "function" ? (v as (...a: never[]) => unknown).bind(dom.window) : v);
}

// jsdom has no SVG layout engine, but both mermaid (during render) and
// @excalidraw/mermaid-to-excalidraw (when converting) call getBBox() on ALL
// node kinds — rects, groups, text — exactly like a browser would. A
// text-length guess for everything collapses container geometry (actors at
// 0,0,30px). So: real geometry from attributes for shapes, positioned text
// measurement for text, child unions for containers, transforms applied.
type Box = { x: number; y: number; width: number; height: number };

function numAttr(el: Element, name: string, d = 0): number {
  const v = parseFloat(el.getAttribute?.(name) ?? "");
  return Number.isFinite(v) ? v : d;
}

/** Non-rendered subtrees never contribute to a bbox (per SVG spec). */
function isRendered(el: Element): boolean {
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "defs" || tag === "style" || tag === "title" || tag === "desc" ||
      tag === "metadata" || tag === "mask" || tag === "clippath" || tag === "script") return false;
  const display = el.getAttribute?.("display") ?? "";
  const visibility = el.getAttribute?.("visibility") ?? "";
  return display !== "none" && visibility !== "hidden" && visibility !== "collapse";
}

function union(a: Box | null, b: Box): Box {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function textBox(el: Element): Box {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const width = Math.max(30, text.length * 12); // ~0.6em Virgil advance; overestimate beats collapse
  const height = 28;
  const anchor = (el.getAttribute?.("text-anchor") ?? "").trim();
  const ax = numAttr(el, "x", 0);
  const ay = numAttr(el, "y", 0);
  return { x: anchor === "middle" ? ax - width / 2 : ax, y: ay - height, width, height };
}

/** Compose a transform attribute into a 2D matrix [a,b,c,d,e,f], left-to-right. */
function parseTransform(t: string | null): [number, number, number, number, number, number] {
  let m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  if (!t) return m;
  const mul = (o: [number, number, number, number, number, number]): void => {
    const [a, b, c, d, e, f] = m;
    const [a2, b2, c2, d2, e2, f2] = o;
    m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
  };
  const re = /(translate|scale|rotate|matrix)\s*\(\s*([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(t))) {
    const nums = match[2].split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (match[1] === "translate") {
      const a = nums[0] ?? 0;
      mul([1, 0, 0, 1, a, nums[1] ?? a]);
    } else if (match[1] === "scale") {
      const a = nums[0] ?? 1;
      mul([a, 0, 0, nums[1] ?? a, 0, 0]);
    } else if (match[1] === "rotate") {
      const rad = ((nums[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = nums[1] ?? 0;
      const cy = nums[2] ?? 0;
      mul([1, 0, 0, 1, cx, cy]);
      mul([cos, sin, -sin, cos, 0, 0]);
      mul([1, 0, 0, 1, -cx, -cy]);
    } else if (match[1] === "matrix" && nums.length >= 6) {
      mul([nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]);
    }
  }
  return m;
}

function applyTransform(el: Element, b: Box): Box {
  const [a, bb, c, d, e, f] = parseTransform(el.getAttribute?.("transform"));
  if (a === 1 && bb === 0 && c === 0 && d === 1 && e === 0 && f === 0) return b;
  const xs = [b.x, b.x + b.width].map((x) => [a * x + c * b.y + e, a * x + c * (b.y + b.height) + e]).flat();
  const ys = [b.y, b.y + b.height].map((y) => [bb * b.x + d * y + f, bb * (b.x + b.width) + d * y + f]).flat();
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Geometry in the element's own coordinate frame (no transform). */
function localBox(el: Element): Box | null {
  const tag = (el.tagName ?? "").toLowerCase();
  switch (tag) {
    case "rect":
    case "image":
    case "use":
      return { x: numAttr(el, "x"), y: numAttr(el, "y"), width: Math.max(0, numAttr(el, "width")), height: Math.max(0, numAttr(el, "height")) };
    case "circle": {
      const r = Math.max(0, numAttr(el, "r"));
      return { x: numAttr(el, "cx") - r, y: numAttr(el, "cy") - r, width: 2 * r, height: 2 * r };
    }
    case "ellipse": {
      const rx = Math.max(0, numAttr(el, "rx"));
      const ry = Math.max(0, numAttr(el, "ry"));
      return { x: numAttr(el, "cx") - rx, y: numAttr(el, "cy") - ry, width: 2 * rx, height: 2 * ry };
    }
    case "line": {
      const x1 = numAttr(el, "x1");
      const y1 = numAttr(el, "y1");
      const x2 = numAttr(el, "x2", x1);
      const y2 = numAttr(el, "y2", y1);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
    case "polyline":
    case "polygon": {
      const nums = (el.getAttribute?.("points") ?? "").split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
      if (nums.length < 4) return null;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        xs.push(nums[i]!);
        ys.push(nums[i + 1]!);
      }
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case "path": {
      // Tight curve math is overkill for measurement: bound all coordinates.
      // Arc flags/radii may widen it slightly — safe direction for layout.
      const nums = (el.getAttribute?.("d") ?? "").split(/[^0-9.+-]+/).filter(Boolean).map(Number).filter(Number.isFinite);
      if (nums.length < 4) return null;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        xs.push(nums[i]!);
        ys.push(nums[i + 1]!);
      }
      if (!xs.length) return null;
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case "text":
    case "tspan":
    case "textpath":
    case "altglyph":
      return textBox(el);
    default: {
      const kids = (el as Element).children ? Array.from((el as Element).children) : [];
      const rendered = kids.filter(isRendered);
      if (!rendered.length) {
        // Unknown leaf (foreignObject etc.): legacy text-length guess.
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return { x: 0, y: 0, width: Math.max(30, text.length * 12), height: 28 };
      }
      let acc: Box | null = null;
      for (const kid of rendered) {
        const b = boxInParent(kid as Element);
        if (b) acc = union(acc, b);
      }
      return acc;
    }
  }
}

/** Box in the parent frame: local geometry plus the element's own transform. */
function boxInParent(el: Element): Box | null {
  const local = localBox(el);
  if (!local) return null;
  return applyTransform(el, local);
}

function measuredBox(el: Element): Box {
  const b = boxInParent(el);
  const box = b ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height,
  } as Box;
}

try {
  const scope = dom.window as unknown as Record<string, { prototype: Record<string, unknown> }>;
  const svgProto = scope.SVGElement?.prototype ?? scope.Element?.prototype;
  if (svgProto) {
    svgProto.getBBox = function (this: Element) {
      return measuredBox(this);
    };
  }
  const textProto = scope.SVGTextContentElement?.prototype;
  if (textProto && typeof textProto.getComputedTextLength !== "function") {
    textProto.getComputedTextLength = function (this: { textContent?: string | null }) {
      return Math.max(30, (this.textContent ?? "").length * 12);
    };
  }
} catch {
  /* best-effort */
}
