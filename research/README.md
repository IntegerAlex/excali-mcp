# Research index

Deep dives backing the DiagramForge pipeline. Each report ends with its own
top-10 action list; this file distills the cross-cutting conclusions.

## Reports

| File | Track | Key result |
|---|---|---|
| `excalidraw-sdk.md` | Element model, bindings, viewport, fonts, export, library formats | Emit **skeletons** + `convertToExcalidrawElements`; viewport formula `view=(scene+scroll)*zoom+offset`; font ids numeric; `refreshDimensions:true` |
| `mermaid-internals.md` | Grammar, dagre derivation, measurement, parse-vs-render, DOM surface | Converter always does full `render` (parse alone proves nothing); `getBoundingClientRect` stub gap; dagre config precedence; pipe-labels canonical |
| `converter-internals.md` | `parseMermaidToExcalidraw` source (2.2.2), file:function:line citations | Output is **skeletons** (`label:{text,fontSize}` is standard, consumed by step 2 which we skip); subgraph throw → whole-diagram `image` fallback; 6-case shape switch; classDef 5-prop whitelist |
| `layout-algorithms.md` | Dagre/ELK/overlap-removal/labels/text-metrics | Virgil ≈0.55–0.60em advance; VPSC over push-apart; ELK option set; fontkit-first recommendation |
| `error-audit.md` | ~25 failure modes in our `src/` with severity + fix sketch | Non-atomic writes, 409 edit loss, NaN arrows, declutter-vs-icons, hyphen ids, viewport clobber |

## Cross-cutting conclusions (highest value first)

1. **Skeleton finalization is a library switch, not a missing call (verified
   2026-09-05: converter 2.2.2 = `parseMermaid → graphToExcalidraw`, done;
   `convertToExcalidrawElements` lives in `@excalidraw/excalidraw`).** Using
   skeletons directly is correct 2.2.2 usage. Migrating means: skeleton-in-
   context + viewer-side conversion + converted sidecars + decoration interop,
   with the current pipeline as fallback until parity. Do not delete
   `withBoundLabels` without that design.
2. **Stub `getBoundingClientRect`** (htmlLabels path measures via fastdom →
   always 0 in jsdom). Font-aware estimator, CJK ×2.
3. **Atomic context writes** (tmp + rename) + corruption recovery, and stop
   discarding user edits on 409 (merge, don't overwrite).
4. **NaN guards** on every geometry formula (reanchor/division paths).
5. **declutter ↔ icons ordering**: declutter moves nodes but not grouped icon
   art — move groups atomically.
6. `parseIconClasses`: allow hyphenated ids.
7. Remote rev must not clobber local viewport (only apply elements).
8. VPSC (via webcola) to replace O(iter·n²) push-apart; ELK only if dagre
   itself becomes the bottleneck.
9. `deterministicIds` + trial-render gate for stable test fixtures.
10. Pre-sanitize `end`/bare-`o/x`-ids/`#`/linkStyle before validate.

## Sources

`sources/` holds vendored doc pages + upstream source files (mermaidAPI.ts,
createText.ts, flowDb.ts, excalidraw element-types/transform/newElement/
textMeasurements, dagre/ELK/overlap/label/metric notes).
