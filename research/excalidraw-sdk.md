# Excalidraw SDK — Engineering Reference for Programmatic Diagram Generation

Target stack: TypeScript CLI that generates diagrams server-side + local React viewer (`@excalidraw/excalidraw@0.18.0`, `@excalidraw/mermaid-to-excalidraw@2.2.2` per repo `package.json`).
Sources: `docs.excalidraw.com` (installation, `initialData`, `excalidrawAPI`, element-skeleton, export/restore utils, constants, JSON-schema, mermaid-to-excalidraw API + new-diagram-type),
`packages/element/src/{types,transform,newElement,textMeasurements,textElement,binding}.ts`,
`packages/common/src/{constants,utils}.ts`, `packages/excalidraw/{appState,viewport,fonts/Fonts,index-node,data/library,data/types}.ts`.
Raw snapshots under `research/sources/`.

## 1. Element model

### 1.1 Base fields (`_ExcalidrawElementBase`, `packages/element/src/types.ts`)

Every element carries all of these. When loading via `restoreElements`/`initialData`/`updateScene`, missing fields are **backfilled with defaults** (see §1.5), so rendering rarely hard-breaks — but ids/geometry/bindings silently degrade.

| Field | Type | Required? | Default on restore / `newElement` | Notes |
|---|---|---|---|---|
| `id` | `string` | yes (generate via `randomId()`) | `randomId()` | Must be unique; duplicates log `Duplicate id found` in skeleton path |
| `type` | union (below) | yes | — | `selection` is internal, never emit it |
| `x`, `y` | `number` | yes | `0` via `_newElementBase` | Scene coords, top-left (before rotation). Keep within ±1e6 or console.error |
| `width`, `height` | `number` | yes (except linear, see below) | `0` base; skeleton uses `100` (`DEFAULT_DIMENSION`) | `isInvisiblySmallElement` = ~0-size; text w/h must match measured metrics |
| `angle` | `Radians` | no | `0` | Rotation in radians |
| `strokeColor` | `string` | no | `#1e1e1e`? actually `COLOR_PALETTE.black` via `DEFAULT_ELEMENT_PROPS` | `transparent` allowed |
| `backgroundColor` | `string` | no | `"transparent"` | `transparent` = no fill |
| `fillStyle` | `hachure\|cross-hatch\|solid\|zigzag` | no | `"solid"` (note: docs example shows `hachure`) | |
| `strokeWidth` | `number` | no | `2` (`STROKE_WIDTH.medium`); freedraw thin=0.5 scale | Keys: thin 1 / medium 2 / bold 4 |
| `strokeStyle` | `solid\|dashed\|dotted` | no | `"solid"` | |
| `roughness` | `number` | no | `1` (`ROUGHNESS.artist`); 0=architect, 2=cartoonist | |
| `opacity` | `number` | no | `100` | 0–100 |
| `roundness` | `null \| {type,value?}` | no | `null` → constructor; UI default `round`/`ADAPTIVE_RADIUS` | `ROUNDNESS`: LEGACY 1, PROPORTIONAL 2, ADAPTIVE 3 (rect default, `DEFAULT_ADAPTIVE_RADIUS=32`, `DEFAULT_PROPORTIONAL_RADIUS=0.25`) |
| `seed` | `number` | no | `randomInteger()` | Seeds rough.js; missing = reshuffled look each render |
| `version`, `versionNonce` | `number` | no | `1`, `0`/`random` | Collaboration reconciliation; restore bumps version when `localElements` passed |
| `index` | `FractionalIndex\|null` | no | `null` → `syncInvalidIndices` assigns | z-order = array order; keep in sync |
| `isDeleted` | `boolean` | no | `false` | Soft-delete; `getSceneElements` filters these |
| `groupIds` | `GroupId[]` | no | `[]` | Deepest→shallowest |
| `frameId` | `string\|null` | no | `null` | Set when child of frame; skeleton frame path auto-assigns incl. bound text |
| `boundElements` | `BoundElement[]\|null` | no | `null` | `[{id, type:"arrow"\|"text"}]` back-pointers; repaired by restore |
| `updated` | `number` | no | `getUpdatedTimestamp()` (1 in test) | |
| `link` | `string\|null` | no | `null` | |
| `locked` | `boolean` | no | `false` | |
| `customData` | `Record<string,any>` | no | `undefined` | Preserved round-trip |

### 1.2 Per-type extras

| Type | Extra required | Optional (important) | Skeleton shortcut (`convertToExcalidrawElements`) |
|---|---|---|---|
| `rectangle`, `diamond`, `ellipse` | `x,y` (+ label case needs `label.text`) | `width,height,backgroundColor,…`; container auto-grows from label if w/h omitted (passes 0 then `redrawTextBoundingBox` expands) | `{type,x,y}` enough; defaults w/h=100 |
| `line`, `arrow` | `x,y` | `width,height` (default 100×0 → points `[(0,0),(w,h)]`), `points`, `start/endBinding`, `start/endArrowhead`, `elbowed`, `fixedSegments`, `startIsSpecial/endIsSpecial` (elbow), `polygon` (line) | `{type:"arrow",x,y}` → 100px horizontal arrow, `endArrowhead:"arrow"` |
| `text` | `x,y,text` | `fontSize` (20), `fontFamily` (5=Excalifont), `textAlign` (left), `verticalAlign` (top), `containerId`, `originalText`, `autoResize` (true), `lineHeight` (unitless, per-font via `getLineHeight`), `labelPosition` (arrow labels) | w/h auto-measured; do not hand-compute |
| `image` | `x,y,fileId` | `status` (pending/saved/error), `scale:[1,1]`, `crop:null`, w/h default 100 | Needs matching `files[fileId]` + `addFiles`; `LIBRARY_DISABLED_TYPES` excludes image/iframe/embeddable from library |
| `frame` / `magicframe` | `children: id[]` | `name`, x/y/w/h (auto-computed = common bounds ± `PADDING=10` if omitted) | children ids remapped via `oldToNewElementIdMap` when `regenerateIds` |
| `freedraw` | `points`, `simulatePressure` | `pressures`, `strokeOptions:{variability,streamline(0.5)}` | Passed through as-is (no auto-construction) |
| `iframe`/`embeddable` | — | iframe/magicframe `customData.generationData` | Passed through as-is |

Arrowhead values: `"arrow","bar","circle","circle_outline","triangle","triangle_outline","diamond","diamond_outline"` + cardinality variants; legacy `"dot","crowfoot_*"` still typed as `AnyArrowhead`. `startArrowhead/endArrowhead: Arrowhead|null`.

`ExcalidrawTextContainer = rectangle|diamond|ellipse|arrow`. `ExcalidrawBindableElement` adds text/image/iframe/embeddable/frame/magicframe. Skeleton arrow `start/end` binding only supports `rectangle|ellipse|diamond` (+ `text` with `text` string); image/frame/iframe bind targets assert-fail in skeleton path — bind those manually with full element structs.

### 1.3 `newElement` defaults that matter for CLI generation

From `newElement.ts` / `common/constants.ts`:
- `DEFAULT_ELEMENT_PROPS = { strokeColor: black, backgroundColor: transparent, fillStyle: solid, strokeWidth: 2, strokeStyle: solid, roughness: 1, opacity: 100, locked: false }`
- `DEFAULT_FONT_SIZE=20`, `DEFAULT_FONT_FAMILY=FONT_FAMILY.Excalifont (5)`, `DEFAULT_TEXT_ALIGN="left"`, `DEFAULT_VERTICAL_ALIGN="top"`, `FONT_SIZES={sm:16,md:20,lg:28,xl:36}`
- `MIN_FONT_SIZE=1`, `MIN_WIDTH_OR_HEIGHT=1`, `BOUND_TEXT_PADDING=5`, `ARROW_LABEL_WIDTH_FRACTION=0.7`, `ARROW_LABEL_FONT_SIZE_TO_MIN_WIDTH_RATIO=11`
- `MIN_ZOOM=0.1, MAX_ZOOM=30, ZOOM_STEP=0.1`, `DEFAULT_EXPORT_PADDING=10`, `EXPORT_SCALES=[1,2,3]`
- `FRAME_STYLE = { strokeColor:"#bbb", strokeWidth:2, strokeStyle:"solid", fillStyle:"solid", roughness:0, roundness:null, backgroundColor:"transparent", radius:8, nameFontSize:14, nameLineHeight:1.25 }`
- `VERSIONS = { excalidraw: 2, excalidrawLibrary: 2 }`

### 1.4 What breaks rendering when fields are missing

- `restoreElements` (used by `loadFromBlob`, `loadSceneOrLibraryFromBlob`, `restore`, library restore) fills every missing prop from defaults above → almost never throws. What *does* degrade: missing `id` (regenerated, breaks your `start/end.id` refs and frame `children`), missing/zero `width/height` on shapes (invisible or `isInvisiblySmallElement`), text `width/height` not matching `measureText` (wrong wrapping/selection until `refreshDimensions`), `points<2` on linear (binding skipped + `console.error`), dangling `containerId`/`boundElements` (fixed only if `repairBindings:true` — otherwise orphan labels / missing labels).
- `convertToExcalidrawElements` is the safe path: it calls `newElement/newTextElement/newLinearElement/newArrowElement/newImageElement/newFrameElement`, `measureText`, `bindTextToContainer`, `bindLinearElementToElement` (`mode:"orbit"`), fixes arrow endpoints by ∓0.5px so bindings don't overlap, normalizes fractional indices, and computes frame bounds. Prefer emitting **skeletons** from the CLI and converting once in the viewer.

### 1.5 `restoreElements(elements, localElements, opts)` semantics

`opts = { refreshDimensions?: boolean (default false — set true after server-side generation so text boxes are re-measured with real fonts), repairBindings?: boolean, normalizeIndices?: boolean }`. `localElements` reuses/increments `version` + regenerates `versionNonce` so collab/version checks don't drop freshly imported elements.

## 2. Bound text mechanics

Contract is two-sided and must agree:
- Text side: `text.containerId = <container.id>`, `text.type="text"`.
- Container side: `container.boundElements` contains `{id: <text.id>, type:"text"}`. Containers hold at most one bound text (`getBoundTextElementId` picks first `type:"text"`).
- Valid containers: `rectangle, ellipse, diamond, arrow` (`isValidTextContainer`). Nothing else renders bound text.

Field semantics:
- `originalText` vs `text`: `originalText` is the source of truth the user typed; `text` is the wrapped/rendered form (`wrapText(originalText, font, maxWidth)`). `redrawTextBoundingBox`/`refreshTextDimensions` recompute `text` from `originalText`. When generating: set both to same value, set `autoResize:true`, and let the viewer measure. If you pre-wrap server-side, still set `originalText` unwrapped or re-wraps compound.
- `autoResize`: `true` = width fits content single-line growth; `false` = fixed-width word-wrap (`TEXT_AUTOWRAP_THRESHOLD=36px` drag threshold in editor). Bound text is always treated as wrapped (`container ? wrap : ...`) and container auto-grows via `computeContainerDimensionForBoundText` (rectangle: `dim+10`; ellipse: `((dim+10)/√2)*2`; diamond: `2*(dim+10)`; arrow label: `dim+80`).
- Arrow-bound labels: text with `containerId=<arrow.id>`, `angle` forced `0`, positioned by `LinearElementEditor.getBoundTextElementPosition` along path; `labelPosition` = normalized arc-length 0–1 (default `DEFAULT_BOUND_TEXT_LABEL_POSITION=0.5`). Skeleton: `{type:"arrow",x,y,label:{text,…}}` creates this pair automatically.
- Geometry: `getBoundTextMaxWidth(container,text)`: rect `w-10`; ellipse `(w/2)*√2-10`; diamond `w/2-10`; arrow `max(0.7*arrowW, fontSize*11)`. MaxHeight analogous (`h-10`, inscribed formulas, arrow special-case). Position: `getContainerCoords` = `(x+5,y+5)` + ellipse inset `(w/2)(1-√2/2)` / diamond inset `(w/4,h/4)`; then aligned by `textAlign/verticalAlign` inside max box; rotated with container angle (except arrows).
- `newTextElement` x/y quirk: input x/y is the **anchor** adjusted by alignment (`x - offsets.x`); skeleton already handles it. Don't pre-offset.

## 3. Bindings (arrows ↔ shapes)

Full element form:
- Arrow: `startBinding/endBinding: FixedPointBinding|null = { elementId, fixedPoint:[fx,fy] (0–1 ratios into bound element box), mode }`. `mode`: `"inside"` (endpoint anywhere inside) vs `"orbit"` (endpoint snapped to outline + `bindingGap`) vs `"skip"` (complex-bindings flag path).
- Shape: `boundElements: [{id:<arrow.id>, type:"arrow"}]`.
- `points`: **local** coords relative to arrow `x,y` (first point usually ~`(0,0)`). `width/height` derived via `getSizeFromPoints`.

Behavior on load / generation:
- Free-floating arrows: both bindings `null` → arrow stays exactly at `x,y+points`. Nothing snaps. Safe default.
- Dangling `elementId` (target missing): renders at stored points; interactive re-bind may drop it; `restoreElements(..., {repairBindings:true})` is designed to clean such inconsistencies (docs: "no containers with non-existent bound text id and no bound text with non-existent container id"; same repair pass covers bindings).
- `bindBindingElement` gap: `getBindingGap = (elbowed?5:5) + strokeWidth/2`; hover radius `maxBindingDistance_simple ≈ 15/zoom-clamped`; min arrow length `BASE_ARROW_MIN_LENGTH=10`.
- Moving a bound shape calls `updateBoundElements` → arrow endpoints follow; moving arrow endpoint re-resolves strategy (`inside` vs `orbit`).
- Skeleton binding (recommended): `{type:"arrow",x,y,width,height,start:{type|id[,x,y,w,h]},end:{...}}`. Omit `start/end.x/y` to auto-place (`start=(arrow.x-w, arrow.y-h/2)`, `end=(arrow.x+arrow.w, arrow.y-h/2)`). `start/end:{id}` binds to an existing skeleton element (ids remapped if `regenerateIds`, default true). To keep your ids, pass `{regenerateIds:false}` — then you must guarantee uniqueness yourself.

## 4. Imperative API + viewport model

### 4.1 `updateScene`

```ts
api.updateScene({ elements?, appState?, collaborators?, captureUpdate? }: {
  elements?: ImportedDataState["elements"];
  appState?: ImportedDataState["appState"];
  collaborators?: Map<string, Collaborator>;
  captureUpdate?: CaptureUpdateAction; // IMMEDIATELY | EVENTUALLY | NEVER
}) => void
```
- Partial updates: only supplied keys change. `captureUpdate` controls undo history: `IMMEDIATELY` (normal local edit), `EVENTUALLY` (async multi-step), `NEVER` (remote/init — use this for CLI-loaded scenes). Non-observed appState/collaborators never hit undo stack regardless.
- Related: `resetScene({resetLoadingState?})`, `getSceneElements(): NonDeleted[]`, `getSceneElementsIncludingDeleted()`, `getAppState(): AppState`, `history.clear()`, `addFiles(files)`, `getFiles()`, `updateLibrary({libraryItems, merge?, prompt?, openLibraryMenu?, defaultStatus?})`, `setActiveTool`, `setCursor/resetCursor`, `toggleSidebar`, `setToast`, `refresh` (recompute offsets after parent scroll/resize), `onChange/onPointerDown/onPointerUp` subscriptions, `id`.

### 4.2 `scrollToContent`

```ts
api.scrollToContent(target?: ExcalidrawElement | ExcalidrawElement[], opts?:
  | { fitToContent?: boolean; animate?: boolean; duration?: number }
  | { fitToViewport?: boolean; viewportZoomFactor?: number; animate?: boolean; duration?: number }) => void
```
- Defaults: all scene elements, center nearest content (or closest element if bounds exceed viewport), keep zoom. `fitToContent` zooms only within 10–100%; `fitToViewport` unrestricted, covering `viewportZoomFactor` (default 0.7, range 0.1–1). `animate` default false, `duration` 500ms (janky on large scenes).
- Newer code path also exposes `setViewport`/`zoomToFitBounds` with `fit:"scale-down"|"contain"|"none"` + offsets/locks; `initialData.scrollToContent:true` uses the same centering (`getScrollToContentState`).

### 4.3 Viewport math (exact, `packages/common/src/utils.ts` + `viewport.ts`)

AppState: `scrollX, scrollY` (scene offset), `zoom:{value}`, `offsetLeft/offsetTop` (canvas DOM offset), `width/height` (canvas px).

```
viewportX = (sceneX + scrollX) * zoom + offsetLeft
viewportY = (sceneY + scrollY) * zoom + offsetTop
sceneX = (viewportX(clientX) - offsetLeft) / zoom - scrollX
sceneY = (viewportY(clientY) - offsetTop) / zoom - scrollY
```
Sign convention: increasing `scrollX/scrollY` moves content right/down on screen (scene origin shifts right/down). Centering a scene point: `scrollX = (W - rightOff)/2/zoom - cx + leftOff/2/zoom` (same for Y; `centerScrollOn`). Fit zoom: `min(W/boundsW, H/boundsH)` clamped to `[MIN_ZOOM=0.1, MAX_ZOOM=30]` (`scale-down` additionally caps at 1). Utils `sceneCoordsToViewportCoords({sceneX,sceneY}, appState)` / `viewportCoordsToSceneCoords({clientX,clientY}, appState)` implement the formulas — reuse them instead of re-deriving. `getCommonBounds(elements)->[minX,minY,maxX,maxY]` for framing.

## 5. `initialData` contract

```ts
<Excalidraw initialData={{ elements?, appState?, scrollToContent?, libraryItems?, files? }} />
// also accepts Promise resolving to that object
```
| Key | Type | Notes |
|---|---|---|
| `elements` | `ExcalidrawElement[]` | Full elements (or output of `convertToExcalidrawElements`). Example in docs omits many fields — restore fills them. |
| `appState` | `Partial<AppState>` | e.g. `{zenModeEnabled, viewBackgroundColor, theme, currentItemFontFamily}`. Only `gridSize/gridModeEnabled/viewBackgroundColor/lockedMultiSelections` survive file export (`cleanAppStateForExport`); `scrollX/scrollY/zoom` persist to localStorage but not to `.excalidraw` files. |
| `scrollToContent` | `boolean` (default false) | `true` = center content on mount. If `false`, pass explicit `appState.scrollX/scrollY` to retain position. |
| `libraryItems` | `LibraryItems \| Promise<LibraryItems>` | Shown in library panel. |
| `files` | `BinaryFiles` (`{[fileId]: {mimeType,id,dataURL,created,lastRetrieved}}`) | Required for `image` elements. |

## 6. Fonts + server-side text measurement

- Families (numeric ids): `FONT_FAMILY = { Virgil:1, Helvetica:2, Cascadia:3, Excalifont:5, Nunito:6, "Lilita One":7, "Comic Shanns":8, "Liberation Sans":9, Assistant:10 }` (+ fallbacks Xiaolai 100, sans-serif 998, monospace 999, Segoe UI Emoji 1000). Docs constants page still lists old names (Excalifont/Nunito/Comic Shanns); code is source of truth. `getFontString({fontFamily,fontSize})` → e.g. `"20px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji"`. Line height: `getLineHeight(family)` unitless; px = `fontSize * lineHeight` (`getLineHeightInPx`).
- Measurement: `measureText(text, fontString, lineHeight) -> {width,height}` = `max(lineWidths) × (lines * fontSize * lineHeight)`. Line width = canvas `measureText().width` (advance width) per line; empty lines count as `" "`. `normalizeText` = normalize EOL + tabs→8 spaces. `wrapText(text,font,maxWidth)` for `autoResize:false`/bound text.
- Browser loading: `Fonts.loadSceneFonts()` / `Fonts.loadElementsFonts(elements)` (`document.fonts.load/check` with per-family char subsets, concurrency 10; woff2 from `EXCALIDRAW_ASSET_PATH` or CDN `esm.run/.../dist/prod`). Self-host: copy `node_modules/@excalidraw/excalidraw/dist/prod/fonts` to `public/` + set `window.EXCALIDRAW_ASSET_PATH="/"`. After load, text shape cache is invalidated + scene re-rendered (`Fonts.onLoaded`).
- Server-side (CLI) accuracy, in order of fidelity: (1) call `measureText` in the viewer after `convertToExcalidrawElements` — don't precompute sizes in CLI; emit skeletons with labels and let `redrawTextBoundingBox` size containers; (2) if CLI must size (e.g. layout), run `measureText` under `node-canvas` (`registerFont(Virgil.woff2/Cascadia.woff2)` + `createCanvas`, see `packages/excalidraw/index-node.ts` pattern which uses `exportToCanvas(elements, appState, files, opts, createCanvas)`), or inject `setCustomTextMetricsProvider({getLineWidth})`. jsdom alone under-measures (no font engine) — this repo already depends on `jsdom@30`; add `node-canvas` for accurate widths. Height is deterministic (`lines*fontSize*lineHeight`) and safe to compute anywhere.
- SVG export embeds font-faces via `Fonts.generateFontFaceDeclarations(elements)` (subset by `originalText` codepoints, concurrency 3, dedup) — keep `originalText` intact or subsets break.

## 7. Export APIs (DOM requirements)

```ts
exportToCanvas({ elements, appState, files?, exportPadding?=10, maxWidthOrHeight?, getDimensions? }) => Promise<HTMLCanvasElement>
exportToBlob(opts: ExportOpts & { mimeType?="image/png", quality?=0.92, exportPadding?=10 }) => Promise<Blob> // via canvas.toBlob
exportToSvg({ elements, appState, files?, exportPadding?=10, metadata? }) => Promise<SVGSVGElement>
exportToClipboard(opts: ExportOpts & { mimeType?, quality?, type:"png"|"svg"|"json" })
serializeAsJSON({ elements, appState }) => string  // strips deleted + non-exported appState; override source via window.EXCALIDRAW_EXPORT_SOURCE
```
- All raster/SVG paths need DOM + canvas + loaded fonts: `exportToCanvas` creates `<canvas>` (or accepts `createCanvas` factory in node, per `index-node.ts`), `exportToSvg` builds inline SVG with embedded font CSS. Pure-node CLI without DOM/canvas will fail — use `jsdom` + `node-canvas` or run export in the viewer (or headless Chromium) after `Fonts.loadElementsFonts`.
- AppState export knobs: `exportBackground` (default true), `viewBackgroundColor` (`#fff`), `exportWithDarkMode` (false), `exportEmbedScene` (false; true bloats png/svg with scene JSON), `exportScale` (devicePixelRatio-capped, `EXPORT_SCALES`).
- File schema (`.excalidraw`, `VERSIONS.excalidraw=2`): `{type:"excalidraw", version:2, source, elements:[{id,type,x,y,width,height,…}], appState:{gridSize,viewBackgroundColor}, files:{[fileId]:{mimeType,id,dataURL,created,lastRetrieved}}}`. Clipboard variant: `type:"excalidraw/clipboard"` (no appState).

## 8. Library format (v1 vs v2 vs legacy)

- Current (v2, `VERSIONS.excalidrawLibrary=2`): `{type:"excalidrawlib", version:2, source, libraryItems:[{id, status:"published"|"unpublished", created, elements:[...], name?}]}`. This is what `serializeLibraryAsJSON`/`loadLibraryFromBlob`/`restoreLibraryItems(items, defaultStatus)` expect (`ExportedLibraryData` / `ImportedDataState.libraryItems: LibraryItems_anyVersion`).
- Legacy v1 / fully-qualified MIME `application/vnd.excalidrawlib+json`: same `libraryItems[]` envelope with `version:1` — accepted and migrated by restore.
- Older-than-v1 shapes: `{library:[...]}` (bare array under `library` key instead of `libraryItems`) — see `ImportedLibraryData {library?: LibraryItems}` deprecated field; also flat element lists. `loadLibraryFromBlob`/`restoreLibraryItems` normalize these; `updateLibrary` accepts `LibraryItemsSource = LibraryItems | Promise | Blob | function`.
- Practical: always emit v2 envelope; dedupe via `mergeLibraryItems(local, other)` (unique by element id+versionNonce chain, others-first); `image/iframe/embeddable` are blocked from library (`LIBRARY_DISABLED_TYPES`).

## 9. Limitations relevant to programmatic generation

1. Only `flowchart` Mermaid diagrams convert to editable elements; all other diagram types render as a **static image** (`@excalidraw/mermaid-to-excalidraw` API: `parseMermaidToExcalidraw(mermaid, {fontSize?}) -> {elements(skeleton), files}` then `convertToExcalidrawElements`). Unsupported flowchart shapes (subroutine/cylinder/asymmetric/hexagon/parallelogram/trapezoid) fall back to `rectangle`; markdown strings → plain text; FontAwesome → plain text; cross arrowheads → bar. Two-step API exists because the package is UMD (no tree-shakeable ESM import of the converter alone).
2. Skeleton converter only auto-binds `rectangle/ellipse/diamond/text` endpoints; `image/frame/iframe` endpoints, elbow `fixedSegments`, and multi-segment routing must be built manually.
3. Text is canvas-measured: server-computed boxes drift unless you use real fonts (`node-canvas` or viewer-side convert). `restoreElements` without `refreshDimensions:true` keeps stale text boxes.
4. `scrollToContent` zoom caps (`fitToContent` ≤100%) and animation jank on big scenes; prefer explicit `scrollX/scrollY/zoom` for deterministic framing.
5. Exports require DOM/canvas/fonts; `exportToBlob` quality only applies to jpeg/webp; `exportEmbedScene` inflates size.
6. Coordinates beyond ±1e6 log errors; fractional indices must stay in sync with array order (`normalizeIndices`); `seed` should be random per element or rough.js output correlates.
7. `updateScene` without `captureUpdate: NEVER` pollutes undo; `onChange` fires per update — batch CLI loads into one call.
8. Version drift: `0.18.x` removed `types/`-prefixed deep imports → use `@excalidraw/excalidraw/element/types`, `/data/types`, `/common/utility-types`, `/types`; runtime imports from package root + `index.css`. Container must have non-zero size; React 18 peer; SSR must be client-only (`dynamic(ssr:false)`).

## Appendix: minimal generation recipe (CLI → viewer)

```ts
// CLI (node): emit skeletons, no measuring needed
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/element/transform";
const skeleton: ExcalidrawElementSkeleton[] = [
  { type: "rectangle", id: "app", x: 0, y: 0, width: 220, label: { text: "App" } },
  { type: "ellipse", id: "db", x: 340, y: 20, width: 160, label: { text: "DB" } },
  { type: "arrow", x: 220, y: 60, width: 120, height: 0, start: { id: "app" }, end: { id: "db" }, label: { text: "reads" } },
];
// sidecar: { mermaidSource, skeleton } → viewer
```
```tsx
// Viewer (React, client-only, non-zero container, index.css imported)
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false });
// mount:
<Excalidraw initialData={{ elements, appState: { viewBackgroundColor: "#fff" }, scrollToContent: true }} excalidrawAPI={setApi} />
// later: api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }); api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.8 });
```
