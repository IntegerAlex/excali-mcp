# Mermaid v10/v11 internals — headless Node (jsdom) pipeline notes

Target pipeline in this repo (`src/diagram.ts` + `src/dom-shim.ts`):
`mermaid.parse(source)` (strict validation) → `parseMermaidToExcalidraw(source, …)`
from `@excalidraw/mermaid-to-excalidraw@2.2.2`, with mermaid `11.17.2`.
The Excalidraw helper itself calls `mermaid.mermaidAPI.getDiagramFromText` +
`mermaid.render` into an off-screen div, then reads geometry out of the SVG.
So "headless conversion" = a **full mermaid render**, not a pure parse.
Sources saved under `research/sources/` (docs HTML + `mermaidAPI.ts`,
`createText.ts`, `common.ts`, `flowDb.ts` raw from `develop`).

## 1. Flowchart grammar

Parser entry: jison grammar → `FlowDB` (`packages/mermaid/src/diagrams/flowchart/flowDb.ts`).
Key methods (all verified in saved `flowDb.ts`):

- **Node shapes.** `addVertex(id, textObj, type, style, classes, dir, props, metadata)`.
  Legacy bracket forms map to `vertex.type` (`square`, `round`, `ellipse`, …);
  `getTypeFromVertex()` maps to renderer shapes (`squareRect`, `roundedRect`, …).
  v11.3+ generic form `A@{ shape: rect }` / `@{ img:…, icon:…, … }` is parsed as
  YAML metadata (`yaml.load`) in `addVertex`: `shape` must be lowercase, no
  underscores, and `isValidShape()` (`rendering-util/rendering-elements/shapes.js`)
  else `throw No such shape`. `img`/`icon` with no label blanks the text
  (`vertex.text = ''`). Note the repo SYSTEM prompt claim "stadium/cylinder
  silently collapse" is wrong directionally — they render, just as distinct
  shapes the Excalidraw converter may not reproduce.
- **Edges.** `addSingleLink(start, end, type, id)` + `destructLink/destructEndLink/
  destructStartLink`. Stroke sniffing: `=` → `thick`, `.` (counted) → `dotted`,
  `~` → `invisible`; head char `>/x/o` → `arrow_point/arrow_cross/arrow_circle`,
  leading `< /x/o` → `double_*`; mismatched start/end strokes or types →
  `{type:'INVALID'}`. `length` clamped to 10 (`type.length > 10 ? 10`).
  Extra dashes lengthen the rank span (`-->`, `--->`, `---->`; `==>`/`-.->`
  families analogous). `A---oB` / `A---xB` are **circle/cross edges**, not typos —
  hence the docs warning to write `dev--- ops` / capitalize.
- **Edge labels — the deprecated one.** Canonical: `A-->|text|B` (also `---|text|`,
  `-->|text|` with arrow, dotted/thick variants). The mid-link form
  `A-- text -->B` is the legacy/deprecated syntax: it still parses but is
  fragile (spaces/special chars break tokenization; docs now only show pipe
  form). The repo prompt already enforces pipe-only — keep it. Edge ids
  `e1@-->` (v11.10+) route through the same `addVertex` metadata path to set
  `animate/animation/curve` on the edge.
- **Subgraphs.** `addSubGraph(_id, list, _title)`: `subgraph [id] [title] … end`,
  dedupes members across subgraphs (`makeUniq`), nested order recovered by
  pre-order walk (`subGraphParent`, `declarationIndex`). Semantics that matter:
  `direction` statement inside a subgraph sets `subGraph.dir`, **but if any
  member node links outside, the subgraph inherits the parent direction**
  (documented limitation, still true in v11). `flowchart.inheritDir` (default
  `false`) controls whether dir-less subgraphs inherit global direction at all.
  v11.17+ collapsible: `subgraph id [Title] … end` + `id@{ view: collapsed }`
  draws one `collapsedGroup` node; boundary-crossing edges redirect to the
  outermost collapsed ancestor; purely internal edges are dropped (would be
  self-loops). `getData()` implements all of this.
- **Directives/comments.** `%%` line comments (never `%%{…}%%` inside a comment —
  confuses the directive lexer, issue #1968). Directives `%%{init: {...}}%%`
  deprecated since v10.5 in favor of frontmatter (`--- config: … ---`), but both
  still work via `preprocessDiagram()` in `mermaidAPI.ts`. `secure` list
  (`secure, securityLevel, startOnLoad, maxTextSize, suppressErrorRendering,
  maxEdges`) **cannot** be set via directive/frontmatter — initialize-only.
- **classDef/class/linkStyle.** `addClass(ids, styles)` (comma→`;` split with
  `\,` escape → `§§§` placeholder), `setClass(ids, className)` applies to
  vertices, edges (by user id), and subgraphs. `updateLink(positions, style)`
  is **index-based** (`linkStyle 3 …` = 4th edge in definition order) and throws
  out-of-bounds (`index … Valid indices … 0..N-1`); `default` targets all.
  `click`/`setClickFun` is a no-op unless `securityLevel: 'loose'`.
- **Direction.** `setDirection`: regex on `< ^ > v` chars → `RL/BT/LR/TB`;
  `TD` normalized to `TB`. Valid: `TB, TD, BT, RL, LR`. Global `direction` +
  per-subgraph `dir` (subject to the override above).

## 2. Layout engine (dagre wrapper)

- **Which engine.** `flowchart.defaultRenderer` default is `"dagre-wrapper"`
  (enum `dagre-d3 | dagre-wrapper | elk`). Top-level `layout` schema default on
  `develop` is now `"elk"` (bundled), but flowchart rendering still goes through
  the dagre path unless `layout: elk` + `defaultRenderer: elk` are set and the
  elk loader is registered. `tiny` build omits ELK entirely (falls back to
  dagre). Repo pipeline sets only `flowchart.curve: 'linear'` → dagre-wrapper.
- **Rank construction** (verified in
  `node_modules/mermaid/dist/chunks/mermaid.core/dagre-GXQ25YYZ.mjs`,
  `prepareLayoutForDagre`): graphlib `Graph({multigraph:true, compound:true})`
  with
  `rankdir = data4Layout.direction`,
  `nodesep = data4Layout.config?.nodeSpacing || data4Layout.nodeSpacing || data4Layout.config?.flowchart?.nodeSpacing`,
  `ranksep = … rankSpacing …` (same precedence), `marginx/marginy = 8`.
  Node sizes (`width/height` on the graphlib nodes) come from the **measured**
  render pass (see §3) — dagre never measures text itself. Self-loops
  (`edge.start === edge.end`) are split via synthetic `id---id---1/2` nodes.
  Compound parents come from `parentDB` (subgraph containment).
- **Config knobs that move boxes.** `flowchart.nodeSpacing` (default 50,
  same-rank axis), `flowchart.rankSpacing` (default 50, cross-rank axis),
  `curve` (default `basis`; repo uses `linear` — fewer path overshoots, safer
  for `computeEdgePositions`), `diagramPadding` (20), `wrappingWidth` (200, max
  text width before wrap for markdown strings), `padding` (8–15, label↔shape
  gap), `htmlLabels` (**root-level only**; `flowchart.htmlLabels` deprecated
  since v11.12.3, root takes precedence), `maxEdges` (500, secure), `maxTextSize`
  (50000, secure), `deterministicIds` (+`deterministicIDSeed`, stable SVG ids
  across renders — useful for snapshot tests, irrelevant to geometry),
  `elk.*` (only when ELK path active: `mergeEdges`, `nodePlacementStrategy`,
  `nodePlacementAlignment`, `layeringStrategy`, presets `default/legacy/
  modelOrder/depthFirst`).
- **ELK vs dagre status (v11.17).** Dagre = default, stable, what the Excalidraw
  converter exercises. ELK = opt-in advanced layout (better large-graph
  crossings, needs explicit registration + `layout: elk`); `tidy-tree` /
  `cose-bilkent` exist for mindmap/architecture only. Do not set ELK for this
  pipeline — the converter's position extraction assumes dagre output.

## 3. Text measurement (the headless failure point)

`packages/mermaid/src/rendering-util/createText.ts` (saved) has two paths:

- `useHtmlLabels: true` (root `htmlLabels`, default in practice): `addHtmlSpan`
  appends `foreignObject > xhtml:div > span`, sanitizes, then
  `fastdom.measure(() => div.node().getBoundingClientRect())` — **twice**
  (second pass if `bbox.width === width` switches to table/wrap layout).
  jsdom returns **0 × 0** for `getBoundingClientRect` always.
- `useHtmlLabels: false`: `createFormattedText` → per-line
  `computeWidthOfText` appends a probe `<text>` and calls
  `tspan.getComputedTextLength()`; background rect sized from
  `textElement.getBBox()`. `splitLineToFitWidth` loops on
  `getComputedTextLength()`. jsdom throws `undefined is not a function` for
  both (`SVGTextContentElement` has no layout engine).

Font inputs: `config.fontFamily` (default `"trebuchet ms", verdana, arial,
sans-serif;`), `themeVariables.fontSize/fontFamily` (theme tables, `theming.html`
saved), `fontSize` (16), per-class text styles. Measurement never loads a font —
it reads whatever the SVG DOM reports, so headless output is only as good as
the stub.

What must be stubbed (exactly): `SVGElement.prototype.getBBox` (mermaid core
**and** converter call it on rects, groups, and text — `338 getBBox()` hits in
dist), `SVGTextContentElement.prototype.getComputedTextLength`, and
`Element.prototype.getBoundingClientRect` for the foreignObject path (returns
zeros in jsdom; the current `src/dom-shim.ts` stubs the first two but **not**
the third — htmlLabels path still measures 0). `parseMermaid.js` additionally
uses `svgEl.getBoundingClientRect()` for the `graphImage` fallback.

## 4. `mermaid.parse` vs `mermaid.render`

From saved `mermaidAPI.ts` (`parse`, `renderDiagram`, `processAndSetConfigs`):

- `parse(text, {suppressErrors?})` = `preprocessDiagram` (frontmatter/directive
  extraction + `configApi.reset/addDirective`) → `Diagram.fromText(code)` (lex +
  parse + `db` build) only. Returns `{diagramType, config}`. **No layout, no
  measurement, no DOM writes** — so it passes in plain Node with zero shims.
  Invalid input throws unless `suppressErrors: true`, in which case it returns
  `false`. `parseError` hook is legacy; prefer try/catch.
- `render(id, text, container?)` = same preprocess + `maxTextSize` guard (over-
  size swaps in `graph TB;a[Maximum text size…]`) → `Diagram.fromText` →
  `createUserStyles` (`new CSSStyleSheet()`, falls back to string concat where
  `replaceSync` missing — i.e. jsdom) → `renderer.draw` (dagre + createText,
  **needs all §3 stubs**) → serialize → `cleanUpSvgCode` → **DOMPurify sanitize
  unless `securityLevel: 'loose'`** → returns `{diagramType, svg,
  bindFunctions}`. Throws the parse error AND any draw error (error-diagram
  fallback only when `suppressErrorRendering: false`, itself secure/initialize-
  only). `src/diagram.ts` correctly calls `mermaid.initialize({startOnLoad:
  false, securityLevel:'strict'})` → sanitize path active.
- Why lenient inputs pass: `parse` validates grammar only — unknown CSS,
  unresolvable layouts, zero-size measurements, and converter-blind constructs
  (subgraphs, images) all parse fine and explode later in `render`/convert.
  `detectType` mismatches and `secure`-config-in-directive are also silently
  ignored at parse time (directive filtered, global defaults kept).

## 5. Known limitations / bugs relevant to conversion

- **Subgraphs** (`src/diagram.ts:122-129` already guards): the Excalidraw
  `parseMermaidFlowChartDiagram` does `containerEl.querySelector([id='${data.id}'])`
  + `el.getBBox()` and **throws `SubGraph element not found`** when the id lookup
  misses (verified in `dist/parser/flowchart.js` `parseSubGraph`); on any parser
  exception the whole diagram degrades to a single `graphImage` element (see
  `parseMermaid.js` catch → `convertSvgToGraphImage`), which the repo rejects.
  Nested/collapsed subgraphs and cross-boundary edges are the top failure
  source. Keep the "no subgraphs, use `%%` section comments" prompt rule.
- **Edge labels**: pipe form required; `-- text -->` misparses with special
  chars; labels with `(#)`, `:`, `;`, `#` need quoting (`["…"]`) or entity codes
  (`#35;` etc.); `linkStyle` indices silently attach to the wrong edge after any
  edit reorders definitions.
- **Special chars / CJK**: docs list `end` (must be `End`/`"end"`), leading
  `o`/`x` on node ids, `<br>` handling differences between HTML and SVG-text
  paths. CJK: no CJK-aware measurement — the `11px × len` style stub (and even
  real browsers without the font) mis-sizes CJK by ~2×, producing overlaps the
  `declutter()` pass can only push apart, not fix.
- **Large graphs**: `maxEdges` 500 and `maxTextSize` 50000 throw at parse/draw;
  both are `secure` → raisable only via `mermaid.initialize`, never via
  frontmatter/directive. The Excalidraw `parseMermaid` re-`initialize`s on config
  change only (hash-guarded) — pass `{maxEdges}` through the converter config,
  not the diagram text. `mermaidExecutionQueue` serializes renders; parallel
  `convertToScene` calls queue, they don't race.
- **Excalidraw converter specifics**: reads `vertex.domId` (`[id*="…"]`) then
  `node.getBBox()` for dims and `computeElementPosition` for x/y
  (`dist/parser/flowchart.js` `parseVertex/parseEdge`); `graphToExcalidraw`
  supports flowchart/sequence/class/er/state, anything else → `graphImage`.
  v2 emits node text as non-standard `label:{text,fontSize}` — hence the repo's
  `withBoundLabels` rewrite (keep it).

## 6. DOMPurify + DOM globals: import-time vs render-time

- **DOMPurify `addHook` is lazy, not import-time.** `common.ts`
  `setupDompurifyHooksIfNotSetup()` (closure `setup` flag) runs on the first
  `removeScript`/`sanitizeText` call — i.e. first parse/render — registering
  `before/afterSanitizeAttributes` hooks that preserve `target` on `<a>`.
  Importing mermaid only loads the `dompurify` module (which itself needs a
  `window` at first `sanitize`, provided by `dom-shim.ts` via jsdom).
  `dompurifyConfig` passes straight through to `DOMPurify.sanitize`.
- **Import-time globals needed**: `window`, `document`, `DOMParser`,
  `XMLSerializer`, `Element/SVGElement/HTMLElement/Node`, `getComputedStyle`,
  `navigator/location/self`, `CSSStyleSheet` (used with `replaceSync` guard),
  `requestAnimationFrame/cancelAnimationFrame`, `MutationObserver` (d3/fastdom),
  `DOMRect`. All must exist **before** `import mermaid` (hence
  `import "./dom-shim.js"` first line in `diagram.ts`).
- **Render-time globals**: `document.body` (d3 `select(document.body)` root,
  temp div `#d<id>` + svg appended then removed), `window.location` (`getUrl`
  when `arrowMarkerAbsolute`), `window.scrollX/Y` (tooltip setup in
  `flowDb.setupToolTips` — runs on `bindFunctions`, harmless headless),
  `CSS.escape` (absolute URLs), `iframe.contentDocument` (only
  `securityLevel: 'sandbox'` — never use headless), `atob/btoa` (iframe path).
  `render` mutates global config scope (`setDiagramConfigScope`) with
  try/finally reset — concurrent renders serialize via the converter queue.

## Actionable fixes for headless Node usage (10 lines)

1. Import `dom-shim` before `mermaid` (already done) and extend it to stub `getBoundingClientRect` for `foreignObject/div/span` (measure text like `getBBox`), not just `getBBox`/`getComputedTextLength`.
2. Replace the flat `len*11/28px` text stub with a font-aware estimator (`0.55–0.6×fontSize` per char, CJK chars ×2, bold ×1.1, wrap at `wrappingWidth` 200) reading computed `font-size`.
3. Pin converter input to dagre: keep `flowchart:{curve:'linear'}`, never set `layout:elk`; pass `maxEdges` via `mermaid.initialize`/converter config (secure, directive-proof).
4. Keep strict `mermaid.parse` gate, but treat pass as necessary-not-sufficient: always follow with a trial `mermaid.render` (or the converter) before accepting, since measurement/layout failures only surface there.
5. Keep the prompt bans: pipe-only edge labels (`-->|x|`), quoted special chars, no `-- text -->`, no subgraphs (flatten to `%%` sections), fan-in ≤3, one edge per pair.
6. Set `deterministicIds:true` (+seed) in test/CI renders for stable SVG ids; set `htmlLabels:false` server-side if foreignObject measurement proves unstable (SVG-text path uses the cheaper `getComputedTextLength` stub).
7. Call `mermaid.initialize({startOnLoad:false, securityLevel:'strict', fontFamily:'<available-font>'})` once with a font actually installed in the container (DejaVu Sans) so browser/CI measurements agree.
8. Pre-sanitize inputs: reject/rescue `end`-as-node, leading `o/x` ids, `#`/`;` unquoted labels, `linkStyle` out-of-range indices, and `secure`-key directives before parse to get actionable errors.
9. Guard the converter: keep the empty/`image`-only rejection plus catch `SubGraph element not found`/`Edge element not found` explicitly and feed the LLM the flatten-subgraphs repair prompt (already wired in `generate()`).
10. Serialize conversions through one queue (excalidraw helper already does) and never use `sandbox` security or parallel `initialize` calls; reset config scope between renders is handled internally, don't share `document` across workers.
