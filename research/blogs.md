# Blogs, docs, specs (URLs verified live 2026-09-06 unless noted)

## Excalidraw internals (primary sources)

- **JSON Schema** — https://docs.excalidraw.com/docs/codebase/json-schema
  Envelope verbatim (`type/version/source/elements/appState/files`); `boundElements/containerId/frameId/groupIds` load-bearing.
- **Element Skeleton** — vendored: `sources/excalidraw-element-skeleton.md`. Beta API; label shorthand; `regenerateIds` default true.
- **mermaid-to-excalidraw API** — vendored: `sources/mermaid-to-excalidraw-api.md`. Official two-step; shape-fallback table (our prompt constraints mirror it); `fontSize` pin 20px.
- **Virgil / Excalifont / FONT_FAMILY** — https://github.com/excalidraw/virgil/ · https://plus.excalidraw.com/excalifont
  Measure with the exact woff2 or widths drift; set `currentItemFontFamily` explicitly. (We ship Virgil; verified ±15% vs true advances.)
- **.excalidrawlib v1/v2** — https://deepwiki.com/excalidraw/excalidraw-libraries/2.2-library-files-(.excalidrawlib) (unverified: DeepWiki mirror)
  v1 `library:[[elements]]` vs v2 `libraryItems` + `itemNames`; remap bindings on insert (our `applyDecorations` does this).

## Mermaid rendering

- **Config hierarchy + layouts (dagre vs ELK)** — https://github.com/mermaid-js/mermaid/blob/develop/docs/config/layouts.md (verified live)
  Node positions come from the layout engine, never source order; `nodeSpacing/rankSpacing` are the knobs we expose.
- **Theming / MermaidConfig** — copy config names verbatim into tool schemas to avoid translation bugs.

## Text measurement

- **MDN `measureText`** — https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/measureText (verified live)
  Use `max(width, actualRight-left)`; browser is ground truth — snapshot server metrics against it.
- **Infinite Canvas lesson 15** — https://infinitecanvas.cc/guide/lesson-015 (unverified: long tutorial)
  Ascent/descent probe + `fontSize` fallback for headless; implement `wrap()` yourself (Canvas2D has none).
- **fontkit / opentype.js** — https://github.com/foliojs/fontkit (used it: Virgil ground truth for our estimator).

## MCP server design

- **Official build-server tutorial** — https://modelcontextprotocol.io/docs/develop/build-server (verified live)
  Stdio rule we follow: **never stdout, only stderr**. `instructions` = server-level system prompt (validates our guide-as-instructions design).
- **AWS MCP strategies + tool-design blog** — https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/ (unverified: long)
  Workflow tools over micro-tools; ≤8 params; concise-by-default responses (validates our 4-tool surface + decorations-in-render).
- **GingerLabs / awslabs DESIGN_GUIDELINES** — https://github.com/awslabs/mcp/blob/main/DESIGN%5FGUIDELINES.md (unverified: long)
  `readOnlyHint` annotations, deterministic outputs for testability.

## Docs-as-code

- **diagram-sync + D2/Mermaid/Excalidraw tradeoffs** (DEV/Posit Hutsonville) — store `.mmd` + rendered output; `mermaid-cli --lint` in CI. Mirrors our sidecar design.
