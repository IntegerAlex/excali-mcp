# Layout algorithms research — improving the Excalidraw post-layout pass

Context: auto-generated flowcharts via `@excalidraw/mermaid-to-excalidraw` → Excalidraw
scene. Current pipeline (`src/diagram.ts`): converter layout → `declutter()` (pairwise
axis-separated push-apart, PAD=36, ≤60 iters, least-overlap-axis) → arrow-endpoint dragging
(free-floating arrows: plain `start/end` id refs + `points[]`, no live bindings) → arrow
label re-seating (midpoint snap if drift > 120px) → `withBoundLabels()` (SDK `label:{text}`
rewritten to bound text; unsized boxes filled by `text.length × fontSize × 0.55 + 20`).
Detail notes + verified URLs per topic live in `research/sources/`.

## 1. Dagre / d3-dagre: Sugiyama phases, config, weaknesses
Five phases (dagre wiki + Gansner et al. TSE93): (i) cycle removal — greedy feedback-arc
heuristic (`acyclicer:"greedy"`), reversed at end; (ii) layering — `ranker` ∈
{`network-simplex` (default), `tight-tree`, `longest-path`}, long edges get dummy nodes;
(iii) crossing minimization — 2-layer barycenter sweep (Jünger–Mutzel family), bilayer
counting O(|E| log |V_small|) (Barth et al.); (iv) coordinate assignment — Brandes–Köpf
with dagre size-variance tweaks; (v) output — node centers, edge `points[]` polylines,
edge-label centers, graph w/h. Config: `rankdir` (TB default), `nodesep` 50, `edgesep` 10,
`ranksep` 50, `marginx/y` 0, edge `minlen` 1 / `weight` 1 / `width,height` 0 (label box —
must be set!) / `labelpos r` / `labeloffset` 10. Weaknesses: edge labels second-class
(no inline reservation, no side strategy — long labels blow out ranks); hub fan-in shares
one rank slot (diagonal crossings; mitigate with `weight`/`minlen`/collector nodes —
already repo practice); no ports (center-attach only — matches our free-floating arrows);
speed-biased heuristics degrade with high size variance — which is exactly what wrong
text metrics produce.

## 2. ELK layered + elkjs: the flowchart-relevant option set
Same Sugiyama skeleton with the missing pieces: **ports** (`portConstraints` +
per-port `side`/`index` — pins True/False branches, cf. elkjs #299), first-class edge
labels (`edgeLabels.placement` CENTER|SIDE|TAIL_HEAD, `centerLabelPlacementStrategy`
MEDIAN_LAYER|CENTER|WIDEST_LAYER, `sideSelection` SMART_DOWN, `edgeLabels.inline`),
three routers (`elk.edgeRouting`: ORTHOGONAL default | POLYLINE | SPLINES-SLOPPY), and
~150 options. Flowchart starter set: `elk.direction: DOWN`, `spacing.nodeNode` 20→40,
`layered.spacing.nodeNodeBetweenLayers` 20→60, `spacing.edgeNode` 10, `spacing.edgeLabel`
2, `spacing.componentComponent` 20, `layering.strategy` NETWORK_SIMPLEX,
`crossingMinimization.strategy` LAYER_SWEEP, `cycleBreaking.strategy` GREEDY (or
MODEL_ORDER with topologically pre-sorted input; elkjs #257 lesson: pre-break cycles by
DFS from entry node for cyclic flowcharts), `nodePlacement.strategy` BRANDES_KOEPF,
`layered.mergeEdges` for fan-in bundling, `highDegreeNodes.treatment` for hubs.
elkjs: `npm i elkjs`, `new ELK()` + `await elk.layout({id, layoutOptions, children
[{id,width,height}], edges [{id,sources[],targets[]}]})` — promise-based, no worker
needed server-side; ELK JSON differs from graphlib; GWT-transpiled core (pin version,
expect terse errors). Excalidraw mapping: ELK node x/y → element x/y (top-left adjust),
POLYLINE sections → arrow `points[]`, labels → bound text.

## 3. Overlap removal: VPSC and friends
VPSC (Dwyer–Marriott–Stuckey, GD'05, doi:10.1007/11618058_15): minimize Σ(xᵢ−xᵢ⁰)² s.t.
xⱼ−xᵢ ≥ gap — convex QP solved **per axis** (~O((n+c) log n)); constraints from a
scanline sweep; iterate x→y (+ optional scanline verify, exactly ELK's
`overlapRemoval.runScanline`). Order-preserving, least-squares-minimal displacement,
deterministic. Current `declutter()` is force-scan push-apart: O(iter·n²), order-breaking,
non-minimal, oscillation-prone (the 60-iteration cap is the tell). Alternatives: SPOrE
(ELK `sporeOverlap`, Nachmanson tree-growing over Delaunay triangulation — shape-preserving,
heavier), PRISM (best quality, slowest), uniform scale (cheapest, distorts aspect).
Verdict: **VPSC via `webcola` (or a ~200-line solver port) strictly dominates the current
loop** — same PAD gap, solve x then y, keep arrow/label dragging as post-solve fix-up.
Pair with a compaction step to reclaim axis elongation.

## 4. Edge-label placement heuristics
ELP is NP-hard (Kakoulis–Tollis); engineering answer is candidate-slots + greedy +
local repair (yFiles generic vs integrated labeling; ELK label-dummy reservation;
Graphviz `labelangle/labeldistance/labelfloat/decorate/forcelabels`). Rules: short edges
(<3× label width) → centered **on-edge** with opaque background; long edges → **source-side**
for guard semantics (`yes/no` next to the diamond — SCCharts source-layer strategy),
target-side for results; never mid-diagonal (crossing peak); keep labels horizontal with
perpendicular offset (edgeLabelSpacing + h/2); ≤120px association radius (current threshold
is right); static scenes must **never hide** — move along edge → nudge ≤2× font size →
push nodes (reserve space up front = "integrated labeling"). Two fixes to current re-seat:
(a) anchor to **longest straight segment's midpoint**, not polyline average; (b) reserve
label space pre-layout (dagre edge `minlen`/label-box; ELK CENTER/WIDEST_LAYER + `inline`).
Short branch labels forced source-side is the single biggest flowchart legibility win.

## 5. Text measurement math
Excalidraw ground truth (`research/sources/excalidraw-textMeasurements.ts`): per-line
`canvas.measureText().width` (advance width), width = max over lines,
height = `fontSize × lineHeight(1.25) × lines` + `BOUND_TEXT_PADDING`; `charWidth` cache
for wrapping; `setCustomTextMetricsProvider()` hook for server override. Font-file math:
`width_px = Σ xAdvance (from `font.layout(text)`, incl. kerning) × fontSize / unitsPerEm`.
Fallback ratios (fallback only): system sans mixed-case ≈0.50 em, caps ≈0.65–0.70,
digits ≈0.55–0.60; handwriting (Virgil) mixed-case ≈0.55–0.60 with ±20% per-string error —
so the current 0.55 factor is a sane mean that fails worst on **short** labels where one
glyph dominates. Server options: **fontkit/opentype on bundled Virgil woff2** (exact to
~1–2%, small dep — recommended) > node-canvas/node-pretext (pixel-exact, native build) >
cached 224-char lookup table (perf layer after correctness) > char-count ratio (status quo,
keep as last resort). Virgil ships in `@excalidraw/excalidraw` npm; load once at startup,
cache per (family,size).

## 6. What diagram tools actually do
Browser-layout (ELK-via-worker where canvas exists) — wrong architecture for an MCP server
emitting static scenes. Server-side real fonts (fontkit advance widths — the standard fix;
`modern-text`'s DOM-free `FontMeasurer` is the same idea) — right fix here. dagre +
post-pass (status quo) is viable **only if node sizes fed to dagre are already correct**;
garbage-in (0.55 heuristic) forces the post-pass into damage control. Upstream
mermaid-to-excalidraw has the same jsdom-has-no-font-engine trap — hence local declutter.

## 7. Recommendation
Highest value: **real font metrics via fontkit on the bundled Virgil woff2** — it attacks
the root cause (wrong node sizes poison layering, crossing-min, *and* the post-pass),
costs one small pure-JS dep, and composes with everything downstream. Second: swap the
push-apart loop for **VPSC** (minimal drift protects free-floating arrows). Third, only
then: **ELK layered replacing dagre** (ports, inline labels, hub treatment) — biggest
payoff but requires remapping the whole emit path (ELK JSON, sections→points, label
reservation) and validating against the converter's expectations.

## Prioritized action list
1. Load Virgil woff2 via fontkit at startup; replace 0.55 heuristic with Σ-advance widths.
2. Implement `TextMetricsProvider.getLineWidth` parity (max-line + 1.25 lineHeight + padding).
3. Feed corrected sizes into layout AND `withBoundLabels` fallback sizing.
4. Swap `declutter()` inner loop for VPSC (webcola or ported solver), keep PAD=36 as gaps.
5. Anchor arrow labels to longest-segment midpoint + perpendicular offset; source-side yes/no.
6. Add regression tests: short labels, CJK, wide-glyph strings, hub fan-in, cyclic graphs.
7. Reserve edge-label space pre-layout (dagre label-box/minlen) before any router change.
8. Spike ELK layered (DOWN + POLYLINE) behind a flag on 5 representative flowcharts.
9. Adopt ELK ports + `mergeEdges` + inline labels if the spike beats dagre on crossings.
10. Add post-pass compaction + idempotence check (run twice → stable) to CI.
