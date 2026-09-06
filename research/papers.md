# Papers: layout, labels, measurement (all OA links verified live 2026-09-06)

1. **Sugiyama et al. 1981** (layering pipeline) — https://doi.org/10.1109/TSMC.1981.4308636 · OA: https://media.wix.com/ugd/6cbb0c_289d09ca219c4c9a8df5bf05c16214dc.pdf
   4 phases + barycenter heuristic; readability checklist for loss functions.
2. **Gansner et al. 1993 / Graphviz dot** — https://doi.org/10.1109/32.221135 · OA: https://www.graphviz.org/documentation/TSE93.pdf
   Network-simplex ranking + median+transpose crossing reduction; copy the `nodesep/ranksep/minlen` parameterization.
3. **Healy & Nikolov 2013 (Handbook ch.13)** — OA: https://cs.brown.edu/people/rtamassi/gdhandbook/chapters/hierarchical.pdf
   Longest-path + promotion for width-bounded flowcharts; exact methods for small graphs.
4. **Brandes & Köpf 2002 (+ erratum arXiv:2008.01252)** — https://doi.org/10.1007/3-540-45848-4_3 · https://arxiv.org/abs/2008.01252
   O(N) coordinate assignment; apply the erratum before copying alignment code.
5. **ELK paper (arXiv:2311.00533)** — https://arxiv.org/abs/2311.00533
   5 phases + 140 options; model order as tie-break stabilizes re-renders (determinism!).
6. **Ports (Schulze et al. 2014)** — https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/jvlc13.pdf
   Lane attachments as fixed-order ports; edge-edge gap < edge-label gap.
7. **Size-aware placement (Rüegg et al. 2015)** — https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/gd15.pdf
   Measure boxes BEFORE placement; feed width+padding into compaction — validates our measure-first order.
8. **Edge-label placement (Schulze et al. 2018)** — https://rtsys.informatik.uni-kiel.de/~biblio/downloads/papers/diagrams18cds.pdf
   Label-dummy nodes before layering; on-edge labels fastest/most compact — supports our slide-along-arrow (vs perpendicular) choice.
9. **Labeling (Kakoulis-Tollis) + VPSC overlap removal (Dwyer et al. 2005)** — https://cs.brown.edu/people/rtamassi/gdhandbook/chapters/labeling.pdf · https://people.eng.unimelb.edu.au/pstuckey/papers/gd2005b.pdf
   Expand layout rather than shrink fonts; VPSC O(n log n) if our push-apart ever bottlenecks.
10. **Purchase 1997 (aesthetics priority)** — https://doi.org/10.1007/3-540-63938-1_67
    Crossings >> bends > symmetry. Trade symmetry first when de-cluttering.

Applied so far: #5 (deterministic ids/order), #7 (measure-first), #8 (slide direction), #10 (declutter priorities). Open: VPSC only if needed; ELK only if dagre bottlenecks.
