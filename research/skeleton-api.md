# Skeleton API: adopt or defer? (decision: DEFER)

Question: should diagram-tool replace `withBoundLabels` + stub math with the
official two-step (`parseMermaidToExcalidraw` → skeletons →
`convertToExcalidrawElements`)?

## What the official docs say (vendored 2026-09-06)

- `research/sources/excalidraw-element-skeleton.md`: skeleton API is **beta**;
  `convertToExcalidrawElements` is "necessary before initialData/updateScene"
  when using skeletons; containers without dimensions are sized from labels;
  `regenerateIds` defaults true.
- `research/sources/mermaid-to-excalidraw-api.md`: two steps exist because the
  main package was UMD (packaging reason, not architectural purity). Docs also
  claim only flowcharts convert — **stale**: our pinned 2.2.2 converts
  sequence/ER/class/state to native elements (verified).

## Node experiment (2026-09-06, this repo)

Calling `convertToExcalidrawElements` server-side fails before any geometry:

- Importing `@excalidraw/excalidraw` in Node throws (roughjs `bin/rough`
  resolution under pnpm; generally: the bundle assumes a browser env).
- Even past import, container auto-sizing needs canvas `measureText`. No
  canvas in Node without a native dep (`node-canvas` → node-gyp + Cairo).

## Decision: DEFER, with conditions

Adopting step 2 costs either (a) a native dependency — kills the
`npm i -g` frictionless install, our #1 constraint — or (b) running
conversion in the viewer, which changes the context format and breaks
`.excalidraw.json` sidecars importing into excalidraw.com. Current pipeline
(fontkit-verified ±15% metrics + shipped Virgil + repair passes) is
numerically verified and has no native deps.

Revisit when ANY of these hold:
1. Skeleton API leaves beta with a Node-safe entry point.
2. A pure-JS canvas measureText (skia-wasm, CanvasKit-wasm) becomes cheap to
   bundle — note: wasm is shippable friction-free, unlike node-gyp.
3. Measured drift between our estimates and canvas truth exceeds padding on
   real diagrams (track via the frozen fixture + probe comparisons).

Meanwhile `withBoundLabels` stays, understood as our server-side equivalent
of the container/label half of step 2 — not a hack, a deliberate port.
