# Source notes — overlap removal (VPSC / scanline / SPOrE / Graphviz)

## Core algorithm: VPSC (Dwyer–Marriott–Stuckey)
- Paper (abstract + takeaways; PDF not downloaded):
  Dwyer, Marriott & Stuckey, "Fast Node Overlap Removal" (GD 2005).
  https://doi.org/10.1007/11618058_15 — also: doi.org/10.1007/s00453-008-9168-3
  (journal version "Fast Node Overlap Removal by Growing a … / constrained stress").
- Idea: minimize Σ (xᵢ − xᵢ⁰)² subject to separation constraints xⱼ − xᵢ ≥ wᵢⱼ/2 + wⱼ/2 + gap
  for each overlapping pair — a convex quadratic program over a constraint graph.
  Solved **per axis** with an active-set / block-merge solver: each 1-D pass is ~O((n+m) log n).
- Two-pass scheme: (1) generate horizontal constraints by vertical scanline sweep over
  overlapping pairs; solve x; (2) regenerate vertical constraints on updated positions; solve y.
  Optionally iterate or run a final scanline pass (ELK exposes exactly this as
  `overlapRemoval.runScanline`).
- Properties: preserves relative order along each axis (no flips), minimal displacement in
  least-squares sense, deterministic. Weakness: axis-separated passes can leave diagonal
  crowding and elongate one axis (needs compaction after, or joint stress formulation).
- Where to get it: `webcola` npm package (`vpsc.ts` — Cola's `removeOverlaps` uses VPSC +
  scanline constraint generation); Graphviz `overlap=vpsc` / `overlap=prism` modes;
  adaptagrams/libcola C++ reference.

## Alternatives
- **Force-scan / push-apart (current repo `declutter`)**: O(iter·n²) pairwise repulsion along
  least-overlap axis. Simple, order-breaking, non-minimal displacement, can oscillate
  (60-iteration cap here is the symptom). Fine for ≤50 nodes; VPSC strictly dominates it.
- **SPOrE overlap removal (ELK `org.eclipse.elk.sporeOverlap`)**: Nachmanson et al.,
  "Node overlap removal by growing a tree" — Delaunay triangulation → MST → grow/expand
  overlaps along tree edges; `maxIterations` 64, `runScanline` true by default.
  Better at preserving global shape/compactness than naive push; available as ELK algorithm
  but heavier dependency than webcola if only overlap removal is needed.
- **PRISM** (Gansner & Hu): stress-majorization with proximity constraints; best quality
  for preserving layout shape, slowest. Graphviz `overlap=prism`.
- **Voronoi / scaling**: Graphviz `overlap=true|false|scale|vpsc|ortho*`; `voro_margin`,
  `overlap_scaling/shrink`, `sep`/`esep`. Scaling is cheapest, distorts aspect badly.
- **Compaction after removal**: ELK layered `compaction.postCompaction.strategy`,
  rectpacking/sporeCompaction — always pair with removal to reclaim the axis elongation
  that separation constraints introduce.

## Complexity cheat-sheet
| Method | Time | Displacement | Order-preserving |
|---|---|---|---|
| naive pairwise push (current) | O(iter·n²) | large, non-minimal | no |
| VPSC + scanline | O((n+c) log n) per axis | least-squares minimal | yes (per axis) |
| SPOrE (Delaunay+tree grow) | O(n log n + iter·n) | small | approx |
| PRISM (stress) | O(iter·(n² or Delaunay)) | minimal + shape-preserving | approx |
| uniform scale | O(n) | distorts everything | yes |

## Recommendation for this repo
Replace the `declutter()` pairwise loop with **VPSC via `webcola`** (or port of its
~200-line solver if the dep is unwanted): generate separation constraints with the same
PAD gap already used, solve x then y, keep the existing arrow-endpoint/label dragging
as the post-solve fix-up. Keeps everything else identical; removes oscillation risk and
minimizes node drift — the property that matters when arrows are free-floating.
