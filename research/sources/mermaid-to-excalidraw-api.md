# Source: Excalidraw docs — mermaid-to-excalidraw API
# URL: https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api
# Fetched: 2026-09-06. Nav/boilerplate trimmed; substance kept verbatim.

At the moment the mermaid-to-excalidraw works in two steps. First, you call
`parseMermaidToExcalidraw(mermaidSyntax)` on the mermaid diagram definition
string, which resolves with elements in a skeleton format. You then pass them
to `convertToExcalidrawElements(elements)` to get the fully qualified
excalidraw elements you can render in the editor.

The need for these two steps is due to the @excalidraw/excalidraw being a UMD
build so we currently cannot import the `convertToExcalidrawElements()` util
alone, until we support a tree-shakeable ESM build.

## parseMermaidToExcalidraw

Receives the mermaid syntax, resolves to skeleton Excalidraw elements.

```
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
try {
  const { elements, files } = await parseMermaidToExcalidraw(mermaidSyntax, {
    fontSize: number,
  });
  const excalidrawElements = convertToExcalidrawElements(elements);
} catch (e) { /* parse error */ }
```

## Supported diagram types (per these docs — NOTE: stale)

"Currently only flowcharts are supported. All other diagram types will be
rendered as an image." Our pinned 2.2.2 demonstrably converts sequence,
ER, class, and state diagrams to native elements (verified numerically:
19/19 sequence messages preserved) — the docs lag the package.

## Shape fallbacks (still accurate, load-bearing for prompts)

- Subroutine / Cylindrical / Asymmetric / Hexagon / Parallelogram / Trapezoid
  silently fall back to Rectangle. Our SYSTEM prompt already restricts shapes
  accordingly (rhombus for decisions, [...] for everything else).
- Markdown strings fall back to regular text; FontAwesome `fa:` references do
  NOT render; cross arrowheads (`x--x`) fall back to bar heads.

## Relevance to diagram-tool (annotated 2026-09-06)

- Official confirmation of the two-step design our research proposed adopting.
  Adoption decision documented in research/skeleton-api.md (deferred: needs
  canvas in Node, i.e. a native dep, which breaks the frictionless-install
  constraint).
- `fontSize` themeVariable directly changes measured text boxes — we pin 20px
  end to end (converter theme, withBoundLabels, viewer).
