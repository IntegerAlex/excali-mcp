# Source notes — Dagre / Sugiyama layered layout

## URLs (verified live 2026-09-05)
- Wiki (config table + phases + papers): https://github.com/dagrejs/dagre/wiki
- README / install (`@dagrejs/dagre` is the maintained npm line): https://github.com/dagrejs/dagre
- Renderer (dagre computes layout only; dagre-d3 renders): https://github.com/dagrejs/dagre-d3
- Graphviz `dot` (reference Sugiyama implementation, attribute list): https://graphviz.org/docs/layouts/dot/
- Foundational paper (Gansner et al., Sugiyama skeleton + network simplex ranking):
  https://graphviz.org/documentation/TSE93.pdf (linked from dagre wiki; PDF not downloaded)

## Sugiyama phases as implemented by dagre
1. **Cycle removal** — greedy heuristic for feedback-arc set (optional `acyclicer: "greedy"`).
   Reversed edges restored at the end (feedback edges point upward in final drawing).
2. **Layering / ranking** — `ranker`: `network-simplex` (default) | `tight-tree` | `longest-path`.
   Assigns integer rank per node; long edges get dummy nodes per spanned rank.
3. **Crossing minimization** — 2-layer barycenter/order heuristic per Jünger–Mutzel survey;
   bilayer cross-counting in O(|E| log |V_small|) per Barth et al.
4. **Coordinate assignment** — Brandes–Köpf "Fast and Simple Horizontal Coordinate Assignment"
   with dagre adjustments for varying node/edge sizes; balances straight long edges vs centering.
5. **Position / output** — node centers `x,y`; edge `points[]` polylines incl. node-intersection
   points; edge-label centers `x,y`; graph `width/height`.

## Config (graph-level unless noted)
| Key | Default | Notes |
|---|---|---|
| `rankdir` | `TB` | `TB/BT/LR/RL` |
| `align` | undefined | `UL/UR/DL/DR` rank alignment |
| `nodesep` | 50 | horizontal separation of nodes in same rank |
| `edgesep` | 10 | horizontal separation of edges in same rank |
| `ranksep` | 50 | vertical separation between ranks |
| `marginx/marginy` | 0 | outer margin |
| `ranker` | `network-simplex` | see above |
| `acyclicer` | undefined | set `"greedy"` for cyclic graphs |
| edge `minlen` | 1 | ranks spanned (use for label clearance / important edges) |
| edge `weight` | 1 | higher = shorter/straighter |
| edge `width/height` | 0 | **edge-label box** — must be set or labels are ignored in layout |
| edge `labelpos/labeloffset` | `r`/10 | label side relative to edge |

## Known weaknesses (flowchart-relevant)
- Edge labels are second-class: only a `width/height` box at `labelpos`; no inline/on-edge
  reservation, no side-selection strategy. Long labels blow out a rank or overlap.
- Hub fan-in/fan-out: many edges into one node share one rank slot; Brandes–Köpf centers the hub
  but incoming polyline diagonals cross. Mitigations: `weight`, `minlen`, port ordering,
  or pre-insert collector nodes (already done in this repo's `diagram.ts` guidance).
- No ports: all edges attach at rectangle center-intersection; Excalidraw free-floating arrows
  match this, but orthogonal routing must be done by the caller.
- Coordinate assignment is speed-biased, not optimal; large size variance degrades compactness.
- Crossing minimization is heuristic (NP-hard problem); dense graphs still cross.
