# mermaid-to-excalidraw v2 (2.2.2) internals

Installed at `node_modules/@excalidraw/mermaid-to-excalidraw` (`dist/`, ESM, `main: dist/index.js`).
Upstream: `github.com/excalidraw/mermaid-to-excalidraw` (standalone repo; docs under
`docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw`). Deps in v2.2.2:
`mermaid ^11.12.1`, `@mermaid-js/parser ^0.6.3`, `@excalidraw/markdown-to-text 0.1.2`, `nanoid 4.0.2`.
Our tree pins `mermaid 11.17.2`, `@excalidraw/excalidraw 0.18.0`.
Source files below are quoted as `dist/*.js` (built output = readable source; maps included).

## 1. Public API

Entry: `dist/index.js` → `parseMermaidToExcalidraw(definition, config?)`.

```ts
// dist/index.d.ts
interface MermaidConfig {
  startOnLoad?: boolean;                          // default false
  flowchart?: { curve?: "linear" | "basis" };     // default "linear"
  themeVariables?: { fontSize?: string };         // default "20px" (v1: "25px", see §8)
  maxEdges?: number;                              // default 500 (v1 README said 1000 in .d.ts, 500 in constants)
  maxTextSize?: number;                           // default 50000
}
interface ExcalidrawConfig { fontSize?: number }
parseMermaidToExcalidraw(definition: string, config?: MermaidConfig)
  : Promise<MermaidToExcalidrawResult>
// dist/interfaces.d.ts
interface MermaidToExcalidrawResult { elements: ExcalidrawElementSkeleton[]; files?: BinaryFiles }
```

Behavior (`dist/index.js:4-18`): `fontSize = parseInt(themeVariables.fontSize) || DEFAULT_FONT_SIZE(20)`;
calls `parseMermaid(definition, {...config, themeVariables})`, then
`graphToExcalidraw(parsed, { fontSize })`. **Only `fontSize` crosses the second stage**
("Only font size supported for excalidraw elements" comment) — colors come from parsed
container/label styles, nothing else from `MermaidConfig` survives.

Error behavior is three-tier, all inside `dist/parseMermaid.js:48-128`:
- `mermaid.mermaidAPI.getDiagramFromText()` or `mermaid.render()` throws (syntax error,
  `maxEdges`/`maxTextSize` guard) → **rejects**; `runMermaidTaskSequentially` propagates the
  caller's error (queue tail is normalized so the queue itself is not poisoned,
  `dist/mermaidExecutionQueue.js:17-21`). Caller sees a throw.
- `diagram.type` is not one of the 5 supported (see §7) → `convertSvgToGraphImage()`
  (base64 SVG dataURL) → resolves `{type:"graphImage"}` → `graphToExcalidraw` →
  `GraphImageConverter` emits **one `type:"image"` element + `files[fileId]`**
  (`dist/converter/types/graphImage.js:3-25`). No throw.
- Supported type but per-element parse throws (notably `parseSubGraph` "SubGraph element
  not found") → caught at `parseMermaid.js:118-121`, `console.error("Error processing
  Mermaid diagram:", error)`, then **whole diagram degrades to the same single-image
  fallback**. This is the "subgraph poison": one bad subgraph discards all vector elements.
  Our `src/diagram.ts:125` therefore rejects empty/all-`image` results instead of saving.

Requires DOM: `document` for off-screen render container, `getBBox`, `getComputedStyle`,
`CSS.supports`, `btoa`. In Node we shim via `src/dom-shim.ts` (jsdom + fake `getBBox`).

Concurrency: all mermaid work serialized through `runMermaidTaskSequentially`
(`dist/mermaidExecutionQueue.js`), because `mermaid.initialize` mutates singleton config and
`render` inserts transient DOM. `mermaid.initialize` is also skipped when the merged-config
hash is unchanged (`parseMermaid.js:52-66`) — streaming optimization. `renderId` counter
(`mermaid-to-excalidraw-${renderCounter++}`) avoids ID collisions.

## 2. Internal pipeline step by step

`parseMermaid(definition, config)` (`dist/parseMermaid.js:48-128`):
1. Merge config over `MERMAID_CONFIG` (`dist/constants.js:7-15`: `startOnLoad:false`,
   `flowchart:{curve:"linear"}`, `themeVariables.fontSize:"20px"`, `maxEdges:500`,
   `maxTextSize:50000`), `mermaid.initialize(merged)` if hash changed.
2. `encodeEntities(definition)` (`dist/utils.js:27-44`): works around mermaid `#` handling —
   `style`/`classDef` hex colors get trailing `;` stripped, `#word;` sequences escaped to
   `ﬂ°…¶ß` sentinels; reversed by `decodeEntities` at every text extraction point.
3. `diagram = await mermaid.mermaidAPI.getDiagramFromText(encoded)` — deprecated API, kept
   deliberately (comment at `parseMermaid.js:68-70`) because only it exposes `diagram.db`
   (`getVertices/getEdges/getSubGraphs/getClasses` for flowcharts).
4. Create hidden div, `await mermaid.render(renderId, definition, svgContainer)` (note: raw
   `definition`, not the encoded one), inject `svg` back into the container so `getBBox` /
   `querySelector` work. Container removed in `finally`.
5. `switch (diagram.type)` dispatches to per-type parser (§7); anything else (gantt, pie,
   journey, git, mindmap, timeline…) → `convertSvgToGraphImage`. Per-parser exceptions →
   `console.error` + image fallback (same as unsupported).
6. `graphToExcalidraw(graph, {fontSize})` (`dist/graphToExcalidraw.js:30-57`) dispatches on
   `graph.type` (`graphImage|flowchart|sequence|class|erd|state`) to the matching
   `GraphConverter`, then `normalizeLinearElementPoints` dedupes consecutive arrow points
   within 0.5px (`dist/utils.js:49-64`).

Flowchart parse (`dist/parser/flowchart.js:247-293` `parseMermaidFlowChartDiagram(db, containerEl)`):
- `db.getVertices()` (v11: a `Map`; object fallback kept), `db.getEdges()` (array),
  `db.getSubGraphs()` (array), `db.getClasses()` (a `Map`, or `{}` fallback).
- Vertices → `parseVertex(vertex, containerEl, classes)` (`:145-194`): finds SVG node by
  substring match `[id*="${vertex.domId}"]` (missing → silently `undefined`, skipped later);
  link detection via parent `<a>` + `xlink:href`; position via `computeElementPosition`
  (accumulates `translate()` transforms up to container root, `:213-246`); **size via
  `node.getBBox()`** (`width/height` are measured SVG bounds, not authored values);
  text via `entityCodesToText(vertex.text)`; styles from `vertex.classes` → `applyClassStyles`,
  `vertex.styles[]` → `applyStyleTextToStyles`, shape `.label-container` element attrs, and
  `.label/.nodeLabel` text elements for label color.
- Edges → `parseEdge(edge, edgeIndex, containerEl)` (`:195-211`): finds SVG by
  `[id*="${edge.id}"]`; missing → `throw "Edge element not found"` (→ whole-diagram image
  fallback); geometry from the SVG `<path d="M…L…">` via `computeEdgePositions`
  (`dist/utils.js:108-194`): splits `d` on `L/M` (default `commandsPattern="LM"`;
  `C` segments keep only their endpoint), drops duplicate consecutive points, drops a
  collinear second-last point within 20px of the end; adds container offset. Edges absent
  from the DOM are pre-filtered (`:274`), and edges with ≤1 reflection point are dropped
  (`:283`). `edge.length = undefined` cleanup. Multi-edges between the same pair get an
  index via `edgeCountMap` keyed `${start}-${end}` — but the converter later reuses one id
  `${start}_${end}` for all of them (collision our `dedupeArrows` relies on).
- Subgraphs → `parseSubGraph` each (`:284-286`) — see §4.

Conversion (`dist/converter/types/flowchart.js`, `FlowchartToExcalidrawSkeletonConverter`):
- Subgraphs first (reversed so nested draw order works), as `rectangle` + `label{verticalAlign:"top"}`,
  width widened to fit title (`estimateLabelWidth = ceil(len*fontSize*0.62)`, +64px padding).
- Vertices as `rectangle` default, `strokeWidth:2`, `groupIds` from `computeGroupIds` tree
  (`subgraph_group_<id>` chains; vertices not in any subgraph get `[]`). Shape switch (§5).
  Cylinder-only special case: label font shrinks to fit (`computeVertexLabelFontSize`, min 12).
- Edges as `arrow`: `x/y = startX/startY`, `points` relativized to first reflection point,
  `strokeWidth = stroke==="thick"?4:2`, `strokeStyle = stroke==="dotted"?"dashed":undefined`,
  `roundness{type:2}`, `start/end:{id}` refs, arrowheads from `MERMAID_EDGE_TYPE_MAPPER`
  (only `arrow_circle→circle`, `arrow_cross→bar`, `arrow_open→none`,
  `double_arrow_{circle,cross,point}`; **plain `arrow_point` (the normal `-->`) maps to
  `undefined`, i.e. Excalidraw default arrowhead**). Edge label → `label:{text,fontSize}` only
  if `edge.text` non-empty. Arrows whose start/end vertex element is missing are skipped
  (`:196-200`) — silently drops cross-subgraph-boundary edges in some layouts.

Node sizes therefore come from **rendered SVG `getBBox`** (font + padding + shape), positions
from accumulated SVG transforms. In Node/jsdom (no layout engine) our `src/dom-shim.ts`
fakes `getBBox` from text length, which is why converter boxes can be undersized/overlapping
and why `declutter` exists downstream.

## 3. The `label` prop (skeleton format — read this before "fixing" anything)

`label: {text, fontSize, …}` on container/arrow skeletons is **standard
`ExcalidrawElementSkeleton`** (`@excalidraw/excalidraw/dist/types/.../data/transform.d.ts`:
`ValidContainer` and `ValidLinearElement` both declare optional `label`). Its consumer is
`convertToExcalidrawElements()` (`data/transform.ts`), which expands each `label` into a real
bound `text` element wired via `containerId`/`boundElements`/`originalText`.

CORRECTION (verified 2026-09-05 against 2.2.2 dist): `convertToExcalidrawElements`
is **not** "the converter's step 2". Our converter (`@excalidraw/mermaid-to-excalidraw`
2.2.2, latest published) runs `parseMermaid → graphToExcalidraw` and is done —
`convertToExcalidrawElements` never appears in its dist. The function lives in the
**main `@excalidraw/excalidraw` package** and takes skeleton arrays. So using
skeletons directly as scene elements is *using 2.2.2 as documented*, not misusing
the API. Switching finalization to `convertToExcalidrawElements` is a **library
switch** (new dependency surface, viewer-side canvas requirement, sidecar/MCP
interop design), not a missing call. Do not "fix" `withBoundLabels` away without
that migration design.

Producers: `converter/types/flowchart.js:96-102` (subgraph), `:127-132` (vertex),
`:159-164` (doublecircle inner), `:213-215` (edge); `elementSkeleton.js:124-131`
(`createContainerSkeletonFromSVG`), `:98-103` (`transformToExcalidrawArrowSkeleton`);
`helpers.getText()` (`converter/helpers.js:34-40`) supplies the text (markdown stripped via
`@excalidraw/markdown-to-text`, font-awesome `fa:/fab:` tokens removed).

Why our pipeline tripped on it: `src/diagram.ts:convertToScene` uses the returned
`skeletons` **directly as scene elements** and never calls `convertToExcalidrawElements`,
so `label` is inert on canvas — hence `withBoundLabels` (`diagram.ts:462-526`) which
synthesizes `text` elements (`<containerId>-label`, centered, `containerId`+`boundElements`
wiring) and deletes `label`. Any future `label`-carrying skeleton (new shape, edge label,
sequence/class/er/state label) needs that pass; bypassing it yields "shape collapses"
(text invisible, box unsized).

## 4. Subgraph handling

Code path: `parseMermaidFlowChartDiagram` `:284-286` maps `db.getSubGraphs()` through
`parseSubGraph(data, containerEl, classes)` (`:97-144`):
1. `nodeIds = data.nodes.map(n => n.startsWith("flowchart-") ? n.split("-")[1] : n)` —
   strips the `flowchart-<id>-<n>` DOM prefix to bare vertex ids used for grouping.
2. `el = containerEl.querySelector(`[id='${data.id}']`)`; **`if (!el) throw new Error("SubGraph
   element not found")`** (`:107-110`). Caught one frame up (`parseMermaid.js:118`) →
   `console.error` + **entire diagram becomes one `image` element**. Single poisoned subgraph
   kills all vector output — this is the failure our `convertToScene` guard
   (`diagram.ts:122-129`) turns into a "flatten subgraphs" repair prompt.
3. Position from `computeElementPosition`, size from `el.getBBox()`; emitted as Excalidraw
   `rectangle` with `label{verticalAlign:"top"}` and `subgraph_group_*` groupIds; member
   vertices/edges inherit group membership via `computeGroupIds`, same-subgraph edges keep
   the group.

What works vs degrades (observed + code-derived):
- Works: simple named `subgraph ID[Title] … end` where mermaid renders a `.cluster` group
  with that id and `getBBox()` succeeds (browser). Title from `data.title`.
- Degrades to full-image fallback: **any** subgraph whose id selector misses — nested
  subgraphs (mermaid v11 nests ids / renders only outer cluster), `subgraph` without
  explicit id+title in some directions, subgraphs in `graph TB` with long titles under
  jsdom's fake `getBBox`, and direction statements *inside* subgraphs (`direction LR`)
  which change cluster DOM structure. Because the throw aborts the whole parse (not just
  that subgraph), there is no partial-subgraph mode.
- Workaround (ours): forbid subgraphs in generated mermaid entirely (`SYSTEM` prompt,
  `guide.ts` FLOWCHART RULES, `%% section comments` instead); on image-fallback detection,
  LLM-repair asks to flatten to plain nodes+edges.

The `image` fallback element: `{type:"image", x:0, y:0, width, height, status:"saved",
fileId}` + `files[fileId] = {id, mimeType:"image/svg+xml", dataURL}` where dataURL is the
base64 of the rendered SVG (`graphImage.js:4-24`, `parseMermaid.js:18-47`). Width/height come
from `getBoundingClientRect` (0 under jsdom unless shimmed — another reason to reject it).

## 5. Shape support matrix (flowchart vertices)

`VERTEX_TYPE` enum (`dist/interfaces.d.ts:3-10`): `round|stadium|doublecircle|circle|
diamond|cylinder` — these are mermaid `flowDb` vertex `type` strings. Converter switch
(`converter/types/flowchart.js:136-178`); **default (no case) = plain `rectangle`**:

| mermaid syntax | `vertex.type` | Excalidraw output |
|---|---|---|
| `A[text]` (also `A[text]`, subroutine `A[[text]]`, hex `A{{text}}`, cyl `A[(text)]`, trap `A[/text/]`, `A[\text\]`, lean, etc. — anything unlisted) | other | `rectangle` (shape silently collapses; only text+style survive) |
| `A(text)` | `round` | `rectangle` + `roundness{type:3}` (pill-ish, not a true ellipse) |
| `A([text])` | `stadium` | same as round: `rectangle` + `roundness{type:3}` |
| `A((text))` | `circle` | `ellipse` |
| `A(((text)))` | `doublecircle` | outer `ellipse` + inner inset `ellipse` (margin 5), shared crafted groupId (note: template literal has a stray `}`: `` `doublecircle_${vertex.id}}` `` `:148`) |
| `A{txt}` | `diamond` | `diamond` |
| `A[(txt)]` DB shape | `cylinder` | `rectangle` (no cylinder primitive; only compensation is label-font shrink-to-fit `:13-24`) |

So: decisions read correctly, circles/double-circles map, stadium/round degrade to rounded
rects, and **subroutine, hexagon, cylinder, parallelogram/trapezoid/lean all collapse to
rectangles** — our prompt's "renderer-safe: rhombus + plain box only" rule (§`diagram.ts:38`,
`guide.ts:15`) exists for exactly this reason. Mermaid itself renders all of them in SVG
(they *look* right in the intermediate SVG), the information is just discarded at the
skeleton switch. Edge arrowheads: only circle/bar/none/bidirectional variants mapped (§2);
all other edge types (`-.->`, `==>`, `~~~`, `o--o`, `x--x`) keep geometry but lose head style.

## 6. classDef / style / linkStyle

- `classDef NAME fill:#…,stroke:#…,stroke-width:2px[,stroke-dasharray,…]` + `class A,B NAME`:
  **applied** (since #71, v1.1.0+/v2). Path: `db.getClasses(): Map` → `applyClassStyles`
  (`parser/flowchart.js:77-96`): `classDef.styles[]` feeds both container props (`fill→
  backgroundColor+fillStyle:solid`, `stroke→strokeColor`, `stroke-width→strokeWidth`,
  `stroke-dasharray→strokeStyle:dashed` via `computeExcalidrawVertexStyle`,
  `converter/helpers.js:51-75`) and label color; `classDef.textStyles[]` feeds label color
  only. Gate: colors pass `isValidCSSColor` (`CSS.supports` or jsdom style probe,
  `parser/cssUtils.js:108-123`); invalid values silently dropped. Only these 5 properties
  are read — `color:`, `font-size:`, `rx:` etc. in classDef are ignored.
- Inline `style A fill:#fff,stroke:#333,stroke-width:2px`: **applied** via
  `vertex.styles[]` → same `applyStyleTextToStyles` (`:172-174`) + SVG `.label-container`
  attrs. `linkStyle` (edge color/width directives): **ignored** — edge conversion reads only
  `edge.stroke` (`thick|dotted`, `:210-211`) and `edge.type` for heads; no `linkStyle` lookup
  anywhere in `dist/`. Per-edge `stroke-width` styling beyond thick/thin is lost.
- `encodeEntities` pre-strip (`utils.js:28-34`) removes the trailing `;` from `style…#…;` /
  `classDef…#…;` lines so mermaid's `#` entity parsing doesn't eat hex colors.
- `cssUtils.parseCSSDeclarations` (`:34-107`) tolerates `;`/`,`/space separators and
  `!important` (stripped by `cleanCSSValue`).

## 7. Supported diagram types + adding new ones

`parseMermaid` switch (`dist/parseMermaid.js:89-116`):

| `diagram.type` (mermaid) | trigger source | parser | skeleton converter |
|---|---|---|---|
| `flowchart-v2`, `graph` | `flowchart LR/TD…`, `graph …` | `parser/flowchart.js parseMermaidFlowChartDiagram(db,…)` | `FlowchartToExcalidrawSkeletonConverter` |
| `sequence` | `sequenceDiagram` | `parser/sequence.js parseMermaidSequenceDiagram(diagram,…)` | `SequenceToExcalidrawSkeletonConvertor` |
| `class`, `classDiagram` | `classDiagram` | `parser/class.js parseMermaidClassDiagram(diagram,…)` | `classToExcalidrawSkeletonConvertor` |
| `er` | `erDiagram` | `parser/er.js parseMermaidERDiagram(db,…)` | `erToExcalidrawSkeletonConvertor` |
| `state`, `stateDiagram` | `stateDiagram-v2` | `parser/state.js parseMermaidStateDiagram(db,…)` | `stateToExcalidrawSkeletonConvertor` |
| *anything else* (gantt, pie, journey, gitGraph, mindmap, timeline, C4, sankey, …) | — | none | `GraphImageConverter` (static SVG image) |

Non-flowchart types go through `elementSkeleton.js`/`transformToExcalidrawSkeleton.js`
(`createContainerSkeletonFromSVG`, `createArrowSkeletonFromSVG`, `createTextSkeleton…`)
measuring SVG `getBBox` directly — more faithful to odd shapes but fully dependent on real
layout; under jsdom they produce the unsized boxes `withBoundLabels` repairs.

Adding a type (upstream doc `docs/.../codebase/new-diagram-type`):
1. Add the `diagram.type` string to `SUPPORTED_DIAGRAM_TYPES` (`src/constants.ts:2`, not
   present in dist) so it stops falling into image fallback (it will then throw until step 2).
2. Write `src/parser/<type>.ts` exporting `parseMermaid<型>Diagram` returning positions,
   dimensions (from SVG), connections/bindings (from `diagram.db` / parser `yy` tables).
3. Wire it into the `switch` in `src/parseMermaid.ts:97`.
4. Write `<Type>ToExcalidrawSkeletonConverter` (a `new GraphConverter({converter})`) mapping
   to `ExcalidrawElementSkeleton` (with `label:{text,fontSize}` for text — see §3).
5. Add playground cases in `playground/testcases/<type>.ts`, remove from `unsupported.ts`,
   verify visually (`yarn test:visual`, `test:visual:update`).

## 8. v1 vs v2 relevant to us

(v1 = 1.1.2 in pnpm store; v2 = installed 2.2.2. Upstream CHANGELOG only narrates to v2.1.0.)

- **New diagram types**: v1 switch handled only `flowchart-v2` (+`sequence`, `classDiagram`);
  everything else (ER, state) → image. v2 adds `er`/`state`/`stateDiagram` parsers+converters
  and accepts `graph` alias for flowchart and `class` alias for classDiagram.
- **Error containment**: v1 lets any parser throw propagate out of `parseMermaid` (caller sees
  the raw error, container left in DOM on throw — no `finally` remove). v2 wraps parsing in
  try/catch → `console.error` + image fallback, and always removes the SVG container
  (`finally`). Net effect: v2 throws *less* (syntax errors still throw; semantic/lookup
  failures degrade to image), which is why we must detect the image fallback ourselves.
- **Serialization**: v2 runs everything through `runMermaidTaskSequentially`
  (`mermaidExecutionQueue.js`, new) and caches `mermaid.initialize` by config hash with unique
  render ids — safe for concurrent/rapid renders; v1 used a fixed `"mermaid-to-excalidraw"`
  render id and re-initialized every call.
- **Font size**: v1 multiplied by 1.25 (`fontSize*1.25` into mermaid theme, default `"25px"`);
  v2 passes the size through unchanged (default `20px`, `constants.js:1`). Same nominal
  config now renders smaller boxes/text than v1.
- **FlowDB API**: v2 reads `db.getVertices()` as `Map` (with object fallback) and normalizes
  `getClasses()` (`Map` vs `{}`); v1 assumed the older object shapes. Requires mermaid ≥11
  (`^11.12.1`; we have 11.17.2).
- **Geometry post-pass**: v2 adds `normalizeLinearElementPoints` (0.5px arrow-point dedupe)
  in `graphToExcalidraw`; v1 returned converter output raw.
- **Unchanged (still biting)**: skeleton output is used directly as scene elements,
  so `label`-as-prop needs our `withBoundLabels` pass (see §3 CORRECTION — this is
  by design with 2.2.2, not a missing call); 6-entry `VERTEX_TYPE` shape switch (all exotic
  shapes still collapse); `parseSubGraph` throw-on-miss (still poisons whole diagram);
  classDef 5-property whitelist; `linkStyle` ignored; `MERMAID_EDGE_TYPE_MAPPER` head subset.

## 9. Failure modes → workarounds (10)

1. `subgraph … end` (esp. nested / `direction` inside / id-less) → `parseSubGraph`
   (`parser/flowchart.js:107-110`) throws "SubGraph element not found" → whole diagram
   degrades to one `image` element (`parseMermaid.js:118-121`). Workaround: never emit
   subgraphs; use `%%` section comments + blank lines (prompt + repair loop already do this).
2. Any unsupported type (gantt/pie/journey/mindmap/…) → silent single-`image` result, no
   throw. Workaround: `sniffDiagramType` gate in `validateMermaid` + reject all-`image`
   scenes (`diagram.ts:105-129`).
3. `label:{text,fontSize}` ignored by canvas when skeletons are used raw (converter output
   is `ExcalidrawElementSkeleton`, meant for `convertToExcalidrawElements`). Workaround:
   `withBoundLabels` pass (synthesize bound `text` + `containerId`/`boundElements`); keep it
   ahead of every geometry pass.
4. Exotic node shapes (`[[ ]]`, `{{ }}`, `[( )]`, `[/ /]`, `[\ \]`) collapse to `rectangle`
   (only round/stadium→rounded rect, circle/doublecircle→ellipse, diamond→diamond survive;
   `converter/types/flowchart.js:136-178`). Workaround: restrict generation to `[]` + `{}`.
5. `linkStyle` / per-edge colors ignored (edges read only `stroke: thick|dotted` + head type).
   Workaround: don't rely on edge styling for meaning; encode in labels.
6. Parallel same-pair edges share id `` `${start}_${end}` `` and stack visually; second+
   reflection data may be dropped as ≤1-point edges. Workaround: one edge per pair, merged
   `"a · b"` labels (`dedupeArrows`, flowchart-only).
7. `classDef` properties outside `fill/stroke/stroke-width/stroke-dasharray/color` dropped;
   invalid colors dropped by `isValidCSSColor`. Workaround: stick to the 4-fill palette in
   `SYSTEM`; always put a `class` on every node.
8. `maxEdges:500` / `maxTextSize:50000` exceeded, or strict `mermaid.parse` syntax error →
   hard throw (not image fallback). Workaround: cap at ~12 nodes, validate-then-repair loop
   (3 attempts in `generate`).
9. jsdom has no layout: `getBBox`/`getBoundingClientRect` are shimmed estimates, so boxes
   overlap and arrow endpoints float. Workaround: `declutter` + `reanchor` passes; prefer TD
   for hubs, ≤3 edges/node.
10. Concurrent renders race mermaid singleton state (v1) / queue stalls on slow render (v2).
    Workaround: on v2 rely on `runMermaidTaskSequentially`; never share one
    `parseMermaidToExcalidraw` call across diagrams — await each `convertToScene` serially.
