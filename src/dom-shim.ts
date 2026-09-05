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

// jsdom has no SVG geometry; mermaid's renderer calls getBBox while measuring.
// Approximate from text length — browser canvas is the source of truth.
try {
  const scope = dom.window as unknown as Record<string, { prototype: Record<string, unknown> }>;
  const svgProto = scope.SVGElement?.prototype ?? scope.Element?.prototype;
  if (svgProto && typeof svgProto.getBBox !== "function") {
    svgProto.getBBox = function (this: { textContent?: string | null }) {
      // ~Excalidraw/Virgil metrics at the converter's default 20px: wider is
      // safer than narrow — underestimates collapse the whole layout.
      const text = (this.textContent ?? "").replace(/\s+/g, " ").trim();
      const width = Math.max(30, text.length * 11);
      const height = 28;
      return { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height };
    };
  }
  const textProto = scope.SVGTextContentElement?.prototype;
  if (textProto && typeof textProto.getComputedTextLength !== "function") {
    textProto.getComputedTextLength = function (this: { textContent?: string | null }) {
      return Math.max(30, (this.textContent ?? "").length * 11);
    };
  }
} catch {
  /* best-effort */
}
