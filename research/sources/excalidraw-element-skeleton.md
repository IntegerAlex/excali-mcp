# Source: Excalidraw docs — Creating Elements programmatically (Element Skeleton)
# URL: https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton
# Fetched: 2026-09-06. Nav/boilerplate trimmed; substance kept verbatim.

We support a simplified API to make it easier to generate Excalidraw elements
programmatically. This API is in beta and subject to change before stable.

For this purpose we introduced a new type `ExcalidrawElementSkeleton`
(.../packages/excalidraw/data/transform.ts#L133). This is the simplified
version of `ExcalidrawElement` with the minimum possible attributes so that
creating elements programmatically is much easier (especially for cases like
binding arrows or creating text containers).

The skeleton can be converted to fully qualified Excalidraw elements by using
`convertToExcalidrawElements`.

## convertToExcalidrawElements

Signature:

```
convertToExcalidrawElements(
  elements: ExcalidrawElementSkeleton,
  opts?: { regenerateIds: boolean }
): ExcalidrawElement[]
```

- `opts` defaults to `{ regenerateIds: true }` — ids regenerated for ALL
  elements irrespective of whether you pass the `id`; set `false` to keep ids.

Usage:

```
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
```

This function converts the skeleton to excalidraw elements which could then be
rendered on the canvas. Hence calling this function is necessary before
passing it to APIs like `initialData`, `updateScene` if you are using the
Skeleton API.

## Supported features (essentials)

- Rectangle/Ellipse/Diamond: `type` + `x` + `y` required, rest optional.
- Text: `type` + `x` + `y` + `text` required.
- Lines/Arrows: `type` + `x` + `y` required.
- Text containers: `label: { text }` required; **if you don't provide the
  dimensions of container, we calculate it based of the label dimensions.**
- Labelled arrows: same `label` shorthand.
- Arrow bindings: `start`/`end` take `{ type }` or `{ id }`; positions
  computed from arrow position when omitted. Id form binds multiple arrows
  to one shape / existing diagrams.
- Frames: `type: "frame"` + `children` (element ids) + optional `name`.

## Relevance to diagram-tool (annotated 2026-09-06)

- `label:{text}` + auto-sized containers + `start/end:{id}` is exactly the
  contract our `withBoundLabels` reimplements server-side. The blessed path
  would delete that code — BUT it needs canvas text measurement (see
  research/skeleton-api.md for the Node experiment: step 2 is not runnable
  in our server env).
- `regenerateIds:false` matters if we ever adopt it: our MCP decorations and
  icon replacement rely on stable ids for bindings.
