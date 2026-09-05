# Source notes — text measurement math + server-side options

## How Excalidraw measures (ground truth; vendored in research/sources/)
- `research/sources/excalidraw-textMeasurements.ts` (from excalidraw repo):
  per-line `canvas.measureText(line).width` (advance width) → `getTextWidth` = max over
  lines; height = `fontSize × lineHeight × lineCount` (W3C line-height model).
  `charWidth` cache wraps single-char `measureText` for wrapping decisions.
  `setCustomTextMetricsProvider()` hook exists precisely for server-side override.
- Font string: `getFontString({fontSize, fontFamily})` → e.g. `"20px Virgil, Segoe UI…"`;
  canvas resolves the first *loaded* family. Node has no canvas/DOM → must supply metrics.

## The math (font-file → pixels, no canvas needed)
- For a shaped run: `width_px = Σ advances + Σ kernings`, where per-glyph
  `advance_px = (hmtx.advanceWidth / unitsPerEm) × fontSize`.
  Sum over `font.layout(text)` glyph positions (`xAdvance`), **not** over raw char count.
- Multi-line: `width = max(line widths)`; `height = lineCount × fontSize × lineHeight`
  (Excalidraw default lineHeight 1.25; bound-text containers add `BOUND_TEXT_PADDING`).
- Container fitting: node width = text width + horizontal padding + border; current code's
  `text.length × fontSize × 0.55 + 20` is a char-count heuristic that fails on
  narrow/wide chars (`i` vs `W`), CJK (full-width), bold/italic, and Virgil's hand-drawn
  variance. Per-glyph advances fix all of these at once.

## Average-advance ratios (fallback only, when font file unavailable)
- System sans (Helvetica/Arial/Segoe): mean lowercase advance ≈ 0.50–0.55 em; mixed-case
  English prose ≈ **0.50 em**; all-caps ≈ 0.65–0.70 em; digits ≈ 0.55–0.60 em (often tabular).
- Handwriting/comic fonts (Virgil — Excalidraw's bundled hand font; Segoe Print / Caveat
  analogues): wider + more variance, mixed-case ≈ **0.55–0.60 em**, so the current 0.55
  factor is a sane Virgil mean but has ±20% per-string error (hence post-pass collisions).
- Rule: heuristic ratio is fine for *long* strings (errors average out) but worst for
  *short* labels (1–8 chars, e.g. `yes/no`) where one wide glyph dominates — exactly the
  labels that collide most. Never trust ratios for short text; measure glyphs.

## Server-side options (Node, no browser)
| Option | Accuracy | Cost | Notes |
|---|---|---|---|
| **fontkit/opentype.js on bundled Virgil woff2** | exact advances + kerning (matches canvas to ~1–2%) | one small dep, sync load at startup | **recommended**: `fontkit.openSync(virgil.woff2)` → `font.layout(line).advances`; implement `TextMetricsProvider.getLineWidth` via it |
| node-canvas (`createCanvas().measureText`) | pixel-exact (real HarfBuzz/shaping) | native build, heavy CI dep | exact but overkill; needs system fonts installed |
| `node-pretext` (node-canvas wrapper) | same as above | same + extra dep | convenient API (`width/measure/wrap`) if canvas accepted |
| cached per-char table (224-entry lookup, LogicAI/modern-text pattern) | == canvas after one-time init | needs canvas once | good perf optimization *after* real metrics work |
| char-count × ratio (status quo) | ±20% | free | keep only as last-resort fallback |

## fontkit specifics (API verified: https://github.com/foliojs/fontkit)
- `fontkit.openSync(path)` / `fontkit.create(buffer)`; WOFF/WOFF2/TTF/OTF supported.
- `font.layout(string)` → `GlyphRun { glyphs, positions: [{xAdvance…}] }`;
  `width_units = Σ positions.xAdvance`; `width_px = width_units × fontSize / unitsPerEm`.
- Glyph `advanceWidth` + GPOS kerning handled inside `layout()` — use it, not manual hmtx.
- Virgil source: `@excalidraw/excalidraw` npm ships `Virgil.woff2` (check
  `node_modules/@excalidraw/excalidraw/dist/...` or the fonts dir after install);
  load once at startup, cache per `(fontFamily, fontSize)` line-width function.
- Wire-in: `setCustomTextMetricsProvider({ getLineWidth: (t, fontStr) => px })` if running
  inside Excalidraw runtime, or replicate `measureText()` (max-line + lineHeight math)
  in the MCP server before emitting elements.

## Practical alternatives seen in diagram tools
- **ELK-via-wasm/browser**: layout in browser where canvas exists — sidesteps measurement
  but wrong architecture for an MCP server emitting static scenes.
- **dagre + post-pass** (status quo): viable only if node sizes fed to dagre are already
  correct — garbage in (0.55 heuristic) → post-pass damage control. Fix measurement first.
- **mermaid-to-excalidraw server path**: same trap (jsdom has no font engine); upstream
  issues confirm label-size mis-estimation is endemic — hence the local `declutter()`.
