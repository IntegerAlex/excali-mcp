# Source notes — edge-label placement

## Key references (abstracts + takeaways; PDFs not downloaded except where noted)
1. Schulze, Hirsch & Seidel, "Edge Label Placement in Layered Graph Drawing"
   (Kiel Univ. thesis/paper series; ELK implementation notes).
   https://doi.org/10.21941/bii/1802 — fetched via websearch excerpt.
2. Klau & Mutzel "topology-shape-metrics" line; Castello et al. sub-layer approach;
   Kakoulis & Tollis candidate-position/matching approach (NP-hard core):
   Brown GD handbook chapter "Labeling Algorithms" (Tamassia).
   https://cs.brown.edu/people/rtamassi/gdhandbook/chapters/labeling.pdf
3. yFiles labeling guide (generic vs integrated labeling; discrete/free/slider models;
   PreferredPlacementDescriptor: side-of-edge × place-along-edge × rotation).
   https://docs.yworks.com/yfiles/doc/developers-guide/labeling.html (fetched full page)
4. Graphviz dot edge labels: `label`, `headlabel/taillabel`, `labelangle/labeldistance`,
   `labelfloat`, `decorate`, `forcelabels`, `splines` interplay:
   https://graphviz.org/docs/layouts/dot/ (+ /docs/attrs/*)
5. ELK edge-label options (this is the actionable one):
   https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html

## Geometry that works (consensus heuristics)
- **Candidate model**: each label gets k candidate slots: {along ∈ {source 25%, center 50%,
  target 75%}} × {side ∈ {left, right, on-edge}} × offset gap. Score = overlap penalty +
  distance-to-preferred + leader-length penalty; assign greedily largest-first, then local
  repair (shift along edge ≤ 1 slot, never across edges). ELP is NP-hard (Kakoulis–Tollis),
  so greedy + repair is the expected engineering solution, not exact search.
- **Center-vs-endpoint rule**: short edges (< 3× label width) → center, on-edge with solid
  background (Excalidraw text has opaque bg option — use it). Long edges → source-side
  placement for "condition/guard" semantics (flowchart diamonds: put `yes/no` near the
  decision node, matching SCCharts source-layer strategy); target-side for "result"
  semantics. Never middle-place on long diagonal polyline edges — crossings peak there.
- **Leader lines**: if displaced > threshold, draw association explicitly. Graphviz uses
  `decorate` (dashed line edge→label); yFiles uses Pentagonal/association offsets. For
  Excalidraw: keep label ≤ 120px from edge midpoint (current re-seat threshold is
  empirically right); beyond that, move the label, don't draw a leader (no leader primitive
  in static scene) — i.e. current "re-seat at midpoint" is the correct fallback, but the
  midpoint should be the **longest straight segment's** midpoint, not the polyline average.
- **Hide vs move**: diagramming tools (yFiles generic labeling, GLT) rank: move along edge
  → nudge perpendicular (≤ 2× font size) → shrink/ellipsize → hide (only interactive).
  For static server-generated scenes hiding is data loss: **never hide**; instead allow
  the post-pass to push *nodes* (label has reserved space via edge minlen/label-box).
  That is exactly ELK's "integrated labeling" (label dummy nodes reserve space during
  layering) vs "generic labeling" (post-hoc, may fail) distinction — prefer integrated.
- **Rotation**: keep labels horizontal (Excalidraw text rotation complicates bounds;
  yFiles auto-flip logic exists precisely because rotated labels hurt legibility).
  Offset perpendicular by (edgeLabelSpacing + labelHeight/2), not along the edge angle.

## What this means for the current pipeline
- Current: arrow labels re-seated to polyline midpoint if drifted > 120px. Two upgrades:
  (a) anchor to longest-segment midpoint + perpendicular offset (not raw midpoint);
  (b) reserve label space *before* layout (edge `minlen` / dummy width in dagre; ELK
  CENTER/WIDEST_LAYER + `edgeLabels.inline` does it natively).
- Short branch labels (`yes`/`no`/`true`/`false`) should be force-placed source-side
  (near diamond), never centered — single biggest legibility win for flowcharts.
