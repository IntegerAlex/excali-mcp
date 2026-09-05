# Sources fetched (2026-09-05)

Docs (via webfetch, markdown):
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation — asset path, fonts self-host, container dims
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/excalidraw-api — updateScene/scrollToContent/getSceneElements signatures
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/initialdata — elements/appState/scrollToContent/libraryItems/files
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton — convertToExcalidrawElements + label/binding/frame examples
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils (+ /export, /restore) — exportToCanvas/Blob/Svg, restore/restoreElements/restoreLibraryItems, scene↔viewport coord utils
- https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/constants — FONT_FAMILY/THEME/MIME_TYPES
- https://docs.excalidraw.com/docs/codebase/json-schema — .excalidraw + clipboard schema
- https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api — parseMermaidToExcalidraw two-step, flowchart-only support/fallbacks
- https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/codebase/new-diagram-type — parser + skeleton converter steps

Repo raw files in this folder (.ts snapshots):
- excalidraw-element-types.ts — `packages/element/src/types.ts`
- excalidraw-transform.ts — `packages/element/src/transform.ts` (skeleton converter, bindTextToContainer, bindLinearElementToElement)
- excalidraw-newElement.ts — `packages/element/src/newElement.ts` (defaults, newTextElement anchor offsets)
- excalidraw-textMeasurements.ts — `packages/element/src/textMeasurements.ts` (measureText, custom provider hook)
- excalidraw-constants.ts — `packages/common/src/constants.ts` (fonts, sizes, zoom, versions)

Also inspected (not saved): element/src/{binding,textElement}.ts, excalidraw/{viewport,appState,fonts/Fonts,index-node,data/library,data/types}.ts, common/src/utils.ts (viewport formulas, getFontString).
