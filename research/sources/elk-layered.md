# Source notes — ELK layered + elkjs usage

## URLs (verified live 2026-09-05)
- Docs hub: https://eclipse.dev/elk/documentation.html
- Algorithm reference hub: https://eclipse.dev/elk/reference.html
- ELK Layered (5 phases + full option table): https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html
- Spacing model (in-layer vs between-layer pairs): https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure/spacingdocumentation.html
- Edge routing enum (UNDEFINED/POLYLINE/ORTHOGONAL/SPLINES): https://eclipse.dev/elk/reference/options/org-eclipse-elk-edgeRouting.html
- SPOrE overlap removal (Nachmanson tree-growing): https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-sporeOverlap.html
- elkjs (JS binding, worker + API): https://github.com/kieler/elkjs
- Live demo (elklive): https://rtsys.informatik.uni-kiel.de/elklive/
- Layered blog overview (5 phases + intermediate slots): https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html

## ELK layered vs dagre — what you gain
Same Sugiyama skeleton, but: real **ports** (attachment points + side constraints),
first-class **edge labels** (CENTER/SIDE/TailHead strategies + inline option), three edge
routers (**ORTHOGONAL** default / **POLYLINE** / **SPLINES** with sloppy/slotted modes),
16 intermediate processing slots (cycle breaking → … → reversed-edge restore), and ~150
documented layout options. This is the "dagre with the missing pieces" upgrade path.

## Flowchart-relevant options (prefix `elk.` or full `org.eclipse.elk.*`; suffix form works if unique)
- `elk.algorithm: "layered"`, `elk.direction: "DOWN"` (flowcharts) / `"RIGHT"`.
- Spacing: `spacing.nodeNode` (in-layer, default 20), `spacing.edgeEdge` (10),
  `spacing.edgeNode` (10), `spacing.edgeLabel` (2), `spacing.labelNode` (5),
  `layered.spacing.nodeNodeBetweenLayers` (20), `layered.spacing.edgeNodeBetweenLayers` (10),
  `layered.spacing.edgeEdgeBetweenLayers` (10), `spacing.componentComponent` (20),
  `spacing.baseValue` (global multiplier). Note: in-layer vs between-layer are separate knobs.
- Layering: `layered.layering.strategy` = NETWORK_SIMPLEX (default) | LONGEST_PATH |
  COFFMAN_GRAHAM (bounded width) | MIN_WIDTH | INTERACTIVE.
- Crossing min: `layered.crossingMinimization.strategy` = LAYER_SWEEP (default) |
  GREEDY_SWITCH; `layered.crossingMinimization.semiInteractive`, `forceNodeModelOrder`.
- Cycle breaking: `layered.cycleBreaking.strategy` = GREEDY (default) | DEPTH_FIRST |
  MODEL_ORDER (follow input order — useful when caller pre-sorts nodes topologically).
- Node placement: `layered.nodePlacement.strategy` = BRANDES_KOEPF (default) |
  NETWORK_SIMPLEX | LINEAR_SEGMENTS | SIMPLE; `...favorStraightEdges`,
  `...bk.edgeStraightening`, `layered.thoroughness` (default 7).
- Edge routing: `elk.edgeRouting` = ORTHOGONAL | POLYLINE | SPLINES;
  `layered.edgeRouting.splines.mode` = SLOPPY (fast) | SLOPPY_WITH_IMPROVED_ROUTING;
  `layered.mergeEdges` (hyperedge bundling for fan-in — directly relevant to hub nodes).
- Edge labels: `edgeLabels.placement` = CENTER (default) | SIDE | TAIL_HEAD | UNDEFINED;
  `layered.edgeLabels.centerLabelPlacementStrategy` = MEDIAN_LAYER | CENTER | WIDEST_LAYER;
  `layered.edgeLabels.sideSelection` = SMART_DOWN et al.; `edgeLabels.inline` (label sits
  on edge with reserved gap — good for short Excalidraw arrow labels).
- Ports: `portConstraints` (FIXED_ORDER/FIXED_SIDE/FIXED_POS) + per-port `side`/`index` —
  the mechanism to pin True/False branches left/right (see elkjs issue #299 pattern).
- Compound/wrapping: `hierarchyHandling`, `separateConnectedComponents`,
  `layered.wrapping.strategy` (wrap wide layers; OFF default).
- High-degree nodes: `layered.highDegreeNodes.treatment/threshold/treeHeight` — built-in
  hub fan-in mitigation dagre lacks.

## elkjs usage from JS (Node, no worker needed for batch MCP use)
```js
const ELK = require('elkjs');
const elk = new ELK(); // or new ELK({ defaultLayoutOptions: {...} })
const laid = await elk.layout({
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
    'elk.edgeRouting': 'POLYLINE', 'elk.spacing.nodeNode': 40,
    'elk.layered.spacing.nodeNodeBetweenLayers': 60 },
  children: [{ id: 'n1', width: 120, height: 60 }],
  edges: [{ id: 'e1', sources: ['n1'], targets: ['n2'] }],
});
```
- Returns same-shape graph with `x/y` on nodes, `sections`/`bendPoints` on edges, label
  `x/y/width/height`. Promise-based; `workerUrl` opts into Web Worker (browser UI case).
- `npm i elkjs` (~1–2 MB bundled worker). GWT-transpiled Java: stack traces are poor,
  error messages terse; pin version. `elkjs@next` tracks ELK master.
- Caveats: no rendering (positions only — same split as dagre); ELK JSON (`sources`/
  `targets` arrays) differs from graphlib; cycle-heavy flowcharts may need caller-side
  DFS pre-break or MODEL_ORDER + entry-node-first input order (elkjs #257 lesson).
