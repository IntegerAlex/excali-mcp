# Error Audit — prompt → mermaid → validate → repair → convert → postprocess → render → sync

Scope: `src/diagram.ts`, `dom-shim.ts`, `server.ts` + `viewer/app.tsx`, `library.ts`, `llm.ts`, `cli.ts`/`mcp.ts`/`context.ts`.
Severity: **breaks** = blank/crashed canvas or lost work · **degrades** = wrong layout/icons but visible · **annoys** = retry/confusion/perf.

---

## 1. diagram.ts — extraction / validation / repair / postprocess

### 1.1 `extractMermaid` regex gaps — breaks
`src/diagram.ts:99` — `/```mermaid\s*([\s\S]*?)```/i`.
- Trigger: model returns `~~~~` fences, 4-backtick fences (nested mermaid), missing close fence (truncated by `max_tokens`), two blocks (picks first — often the *example*, not the answer), ` ```mermaid {theme:…}` headers are fine but ` ``` mermaid` (space) fails.
- Most common real trigger: truncation → no closing fence → hard throw, even though 95% of the diagram is usable.
- Fix: fallback chain — try 4-backtick, `~~~`, then unterminated-tail (`/```mermaid\s*([\s\S]*)$/`); if multiple blocks pick the *last*; strip a stray ` ``` ` tail. Unit-test each.

### 1.2 `sniffDiagramType` edge cases — breaks (false reject)
`src/diagram.ts:90`.
- Filters only lines starting with `%%`. Misses: BOM (`\uFEFFflowchart` → token `"\uFEFFflowchart"` ∉ SUPPORTED), YAML frontmatter (`---\ntitle: x\n---` → sniffs `"---"`), `%%{init}%% flowchart LR` on one line (whole line filtered, type lost), `flowchart-elk`, `journey`/`gantt`/`mindmap`/`timeline`/`pie` (valid mermaid, correctly rejected but message lists only 5 types — fine, but `graph` accepted while prompt never teaches it).
- Trigger: any LLM frontmatter/title or copy-pasted `---` header.
- Fix: strip `\uFEFF`, strip `---…---` frontmatter block, strip `%%{…}%%` *inline* (not whole line), then first token; accept `flowchart-elk` as flowchart.

### 1.3 `validateMermaid` — degrades (hang / misleading error)
`src/diagram.ts:105`.
- Trigger: 500-node prompt → `mermaid.parse` CPU-hang, no timeout; `securityLevel: strict` rejects `click` directives the model occasionally emits; error text is a raw parser dump (line/col, no hint).
- Fix: wrap parse in timeout race (e.g. 10 s → "diagram too large" error); append one-line hint (`flowcharts: quote labels with ()/[]/{} chars`) to thrown error so the repair prompt has signal.

### 1.4 Repair loop prompt quality — degrades (wasted attempts)
`src/diagram.ts:549-570`.
- Sends `raw.slice(0,2000)` / `source.slice(0,2000)` — truncates mid-token, so attempt 2 repairs a *different* (cut) diagram; drops the SYSTEM craft rules on repair turns (only `base` system kept for syntax-repair? actually `[...base, user]` keeps SYSTEM — good — but the user message says "Fix ONLY the syntax", so the model over-conserves and repeats semantic errors); conversion-failure path doesn't include element counts or which construct failed beyond one line; no temperature bump across attempts (same deterministic failure ×3).
- Trigger: any first-attempt failure.
- Fix: send full source (≤8 k) not 2000 chars; include `sniffDiagramType` + converter message verbatim; bump `temperature` 0.2→0.5→0.8 per attempt.

### 1.5 `convertToScene` guard coverage — breaks (slip-throughs)
`src/diagram.ts:125`.
- Catches only `length===0 || every image`. Slips through: single-text scenes, NaN/Infinity geometry (bad getBBox → Excalidraw white-screen), duplicate element ids (SDK reuses `A_B` for parallel edges — later `containerId` wiring collides), zero-area boxes (invisible nodes, declutter divides by ~0 range).
- Trigger: exotic labels (emoji/CJK), huge diagrams, parallel edges.
- Fix: sanitize pass — drop/throw on non-finite x/y/width/height, assign fresh ids on collision, reject scenes where >50% elements have area ≤0. Test with fuzzed labels.

### 1.6 `withBoundLabels` assumptions — degrades
`src/diagram.ts:462`.
- Single-line width `len*fontSize*0.55`: wrong for CJK/emoji (narrow/wide), multi-line `\n`/`<br/>` (one huge wide line, single-line height → overflow); `label.fontSize` may be string (`"20px"`) → `?? 20` keeps string → `*0.55` = NaN → `Math.max(20,NaN)` = NaN → poisoned width (§1.5); diamond/ellipse get rectangle-centered labels (overflow outside rhombus); `groupIds: []` on new labels (UI drag separates label from node); auto-ids `Date.now()+counter` collide across concurrent processes in same ms.
- Trigger: any `<br/>`, decision diamonds, parallel renders.
- Fix: split lines, per-line width, height = lines×fs×1.3; coerce fontSize with `parseFloat`; shrink textW to 70% for diamonds; copy parent `groupIds`; `randomUUID()` for auto ids.

### 1.7 `dedupeArrows` key gaps — degrades (over-merge + under-merge)
`src/diagram.ts:277`.
- Key needs both `start.id` + `end.id`; id-less arrows never merge (duplicates remain). Self-loops (`A→A`) merge even when two distinct self-edges are meaningful. Opposite pairs (`A→B` + `B→A`) have different keys → both kept, drawn on identical geometry → unreadable crossover. `labelFor` relies on shared-id ordering (`A_B` ×2 with labels in element order) — fragile; merged label width uses same 0.55 heuristic; keeper arrow geometry unchanged so a 3× label overflows its midpoint.
- Trigger: retry-loops, bidirectional flows.
- Fix: key on `(start,end)` but exempt self-loops unless labels identical; for opposite pairs offset surviving arrow's midpoint label; after merge re-seat keeper label at midpoint and grow `boundElements`.

### 1.8 `declutter` correctness — degrades (split cards, drift, slowness)
`src/diagram.ts:333`.
- Oscillation: pairwise least-axis push, no damping, 60 fixed iters — A→B→C chains ping-pong and exit still overlapping. 1-point arrows: `end` branch requires `pts.length>1`, so single-point arrow ends never follow their node → detached stubs. Icon/decoration art ignored: second `declutter()` moves rectangles but `moveText` only moves `type:text` with matching `containerId` — `line/ellipse/rect` art grouped via `icon-NODE` stays behind → **icon cards split apart** (visible in current `diagramforge.context.json` risk). Arrow labels dragged by `usedDx/2` then final "re-seat if >120px" pass teleports intentionally-offset labels to midpoints. `O(60·n²)` full `canon`-less loop janks on 200+ nodes; arrows excluded from overlap boxes so edge-node crossings survive.
- Trigger: any icon card + overlap; large scenes.
- Fix: move by `groupId` cohorts (node + caption + art together); handle 1-point arrows; replace teleport with clamp (max 40px pull); cap iters with early-exit + spatial hash; include arrow bounding boxes in overlap test.

### 1.9 `applyIcons` / `reanchor` math — degrades → breaks on NaN
`src/diagram.ts:184-259`.
- `applyIcons.num` guards finite; `reanchor.num` does **not** (`typeof v === "number" ? v : 0` passes Infinity through). Trace: converter emits `width: Infinity` (§1.5) → `box.w=Infinity` → `cx=Infinity` → `dx=-Infinity` → `sx=box.w/2/|dx|=NaN` → `t=NaN` → arrow `pts=[NaN,NaN]` → Excalidraw throws/blank. `anchor` early-return only for exact center; `2/max(|dx|,|dy|,1)` overshoot is arbitrary (+2px). Caption re-pin `c.y=box.y+box.h-fs*1.5-6` assumes single-line caption; multi-line overflows card bottom. `art.length===0` `continue` happens **after** box growth + reanchor → ghost enlarged empty cards.
- Trigger: degenerate converter geometry; all-text icon templates.
- Fix: finite-guard at `reanchor` entry (skip + `console.error`); validate `isFinite` post-anchor, revert point on failure; check `art` non-empty *before* mutating the node.

### 1.10 `parseIconClasses` regex vs real class statements — degrades (silent no-icon)
`src/diagram.ts:149` — `/^\s*class\s+([\w,\s]+?)\s+([\w,\s]+?)\s*$/`.
- `\w` excludes `-`: `class MY-NODE icon_user` never matches; any hyphenated class (`my-style`) kills the whole line. Trailing `;` or `%% comment` kills the line. `class USER actor,icon_user` ok, but shorthand `U:::icon_user` and `classDef` with icons missed. Case-sensitive (`CLASS` ignored).
- Trigger: hyphenated node ids (common in LLM output).
- Fix: `/^\s*class\s+([A-Za-z0-9_,\-\s]+?)\s+([A-Za-z0-9_,\-\s]+?)\s*;?\s*(?:%%.*)?$/` + separate `:::`-shorthand scan + strip comments first. Warn on unknown `icon_*` slugs.

---

## 2. dom-shim.ts

### 2.1 Globals coverage for mermaid 11.17 — breaks on upgrade
`src/dom-shim.ts:23-33`. Covered: window/document/DOMParser/XMLSerializer/Element/SVG*/HTMLElement/Node/Text/CSSStyleSheet/CustomEvent/Event/MutationObserver/navigator/location/self/DOMRect + getComputedStyle/rAF/matchMedia.
- Not covered but touched by mermaid/dagre paths: `SVGTextContentElement` (only patched *if* jsdom exposes it — often undefined → `getComputedTextLength` missing), `SVGGraphicsElement`/`SVGGeometryElement`, `getTotalLength`/`getPointAtLength` (edge routing), `getBoundingClientRect` (foreignObject labels), `ResizeObserver`/`IntersectionObserver`, `requestIdleCallback`, `devicePixelRatio`, `document.fonts`, `HTMLCanvasElement.getContext` (jsdom returns null → dagre text-measure throws unless caught), `Path2D`, `URL.createObjectURL`, `customElements`.
- `setGlobal` silently keeps Node 22's getter-only `navigator` (wrong UA) and never overwrites existing keys — a *second* import with a real DOM (tests) keeps stale globals.
- Trigger: mermaid minor bump using a new API; running under Vitest/happy-dom.
- Fix: add explicit stubs (`getTotalLength`→0 with warn, `getBoundingClientRect`→measuredBox, canvas `getContext`→null-safe measure fallback, `devicePixelRatio=1`, `requestIdleCallback`→setTimeout, `document.fonts.ready`); log once when a stub is hit so upgrades are visible.

### 2.2 `getBBox` stub accuracy vs Virgil — degrades (systematic mis-layout)
`src/dom-shim.ts:65-195`.
- Text: fixed `11px/char`, min 30, h 28 — ignores fontSize/weight/family, collapses all whitespace, single-line. Real Virgil is variable-width → systematic under/over-measure → converter packs wrong → declutter (§1.8) must rescue.
- Paths: bounds *all* numbers in `d` (flags, radii, control points) → over-wide curves. `rect/use/image` ignore `rx`+stroke; `line` gives 0-width/height for straight edges → unions collapse. Only the element's *own* `transform` applied — parent `<g transform>` ignored → nested groups under-measured. `style="display:none"` not treated as hidden (only attributes). `skewX/skewY` transforms unparsed.
- Trigger: every diagram (small but constant); worst on CJK/emoji labels and curved edges.
- Fix: scale text metric by `font-size` attr (`w=len×0.55×fs`, `h=fs×1.3`); accumulate ancestor transforms (walk `parentNode`); handle `style` display/visibility; add skew parsing. Long-term: measure with real canvas (`node-canvas`) or ship Virgil metrics.

### 2.3 jsdom version risks — annoys → breaks
`package.json`: `jsdom: 30.0.1` pinned (good) but `@types/jsdom: ^30` drifts; single module-level `JSDOM` shared across all renders in-process → `<body>` accumulates SVG roots (id collisions, memory growth over long MCP sessions); no per-render cleanup; `pretendToBeVisual` only fakes rAF, not layout.
- Trigger: long-lived MCP server doing 100s of renders.
- Fix: pin `@types/jsdom` exact; per-`convertToScene` fresh `JSDOM` (or at least `document.body.innerHTML=""` before/after); add a render-count memory test.

---

## 3. Sync protocol (server.ts + viewer/app.tsx)

### 3.1 Rev races / lost writes — breaks (data loss)
`src/context.ts:52-76`, `src/server.ts:104-119`.
- `saveContext` = `load` → `writeFile` with no lock/atomic rename. Two writers (agent `render_diagram` + UI autosave, or two `forge` processes) read rev N, both write N+1 — last wins, one party's elements vanish. Direct `writeFile` also exposes torn JSON mid-write (`/api/context` 500s; SSE handler already has a "temporarily unreadable" comment admitting it).
- Trigger: user drags canvas while agent renders (the *advertised* loop).
- Fix: atomic write (tmp + rename); `saveContext` retry-on-stale (reload, re-bump, max 3); UI sends base rev (already does) — server should *merge* or at least return 409 with the winning elements (already does) **and** client must rebase (§3.2).

### 3.2 409 handling discards user work — breaks
`src/viewer/app.tsx:123-131`.
- On 409: `updateScene({elements: fresh})` — local strokes thrown away, no undo, no toast with recovery, no re-queue of local edit. Next keystroke saves on top of remote rev, so the user's work is silently gone.
- Trigger: any concurrent agent render.
- Fix: stash local elements, apply remote, then re-post local as new rev (last-writer-wins with user precedence) or show "your changes vs incoming — keep mine / take theirs" banner. Minimum: `console` + visible "remote change merged — your last drag was dropped, Ctrl+Z" notice.

### 3.3 EventSource reconnect storms — annoys → degrades
`src/server.ts:128-146`, `app.tsx:155-181`.
- One `fs.watch` per SSE client (fd per tab, no debounce — rapid saves burst refetches). `fs.watch` fires twice on some platforms; viewer refetches full `/api/context` per event (payload = whole scene). `EventSource` uses default 3 s retry, no jitter/Last-Event-ID — server restart makes N tabs hammer `/api/context` simultaneously.
- Trigger: 5 tabs open + agent streaming revs.
- Fix: debounce watch (100 ms), send `rev` + `updatedAt` only (client skips fetch if already current — partially done via `revRef` check); add `retry: 5000` with jitter on client; close watcher on abort (done) + cap watchers (share one watcher, broadcast).

### 3.4 `onChange` feedback loops / stale drops — annoys
`app.tsx:105-150,159`.
- `canon()` full-scene stringify on *every* onChange (fires on scroll/selection/load) — O(n log n) jank on large scenes; only mitigation is hash-compare (correct but expensive). `lastEdit=Date.now()` set even for scroll → any agent rev within 3 s is **ignored** (`if (Date.now()-lastEdit<3000) return`) with no backlog — viewer goes stale, `revRef` lags, next local save 409s → clobber (§3.2). Save-failure retry is a single 3 s `setTimeout`, no backoff cap.
- Trigger: user pans canvas right as agent renders (near-certain in demos).
- Fix: distinguish selection/scroll (ignore) from element edits (compare `elements` hash only when `getSceneElements` length/hash differs — already done, but skip when `document.hidden`?); queue missed revs: on expiry of the 3 s window, fetch latest instead of dropping; exponential backoff on save failure.

### 3.5 Remote update clobbers viewport — annoys
`app.tsx:168-172`. Every remote rev calls `scrollToContent()` after 200 ms — destroys the user's zoom/pan (and fights them if they're mid-drag). `fitViewport` runs once at mount with `window.innerWidth/Height`, no resize listener; **empty scene** → `Math.min(...[]) = Infinity` → `zoom = min(2, vw/-Infinity…)` = `-Infinity`/`NaN` → blank canvas until next render.
- Trigger: any agent update while user is zoomed into a corner; fresh `blankContext` load.
- Fix: `updateScene` without re-fit when the user has interacted (track manual viewport change; only `scrollToContent` on first load or when scene was empty); guard `elements.length===0` → default `{scrollX:0,scrollY:0,zoom:{value:1}}`.

### 3.6 Large-scene POST limits — breaks (DoS/OOM)
`server.ts:104`. No `bodyLimit` — `c.req.json()` parses unbounded bodies on the event loop; a decoration-heavy scene (6 icons × 100s of paths) or a pasted library can be 10s of MB → event-loop block, RSS spike, no 413. (Task mentions a "50MB cap" — no such cap exists in code; that *is* the finding.)
- Trigger: big `applyDecorations` output autosaved back by the UI each keystroke-debounce.
- Fix: `hono/limit` bodyLimit (e.g. 10 MB, rationale: largest observed scene ~2 MB; 50 MB would still allow event-loop stalls) + 413 message telling the user to reduce decorations; client-side size check before POST.

---

## 4. library.ts

### 4.1 Caption-drift false negatives/positives — degrades (missing/wrong icons)
`src/library.ts:65-97`.
- `captionOf().includes(expect)`: case-sensitive substring — `"User"` matches `"Users"`/`"SuperUser"` (wrong glyph, false positive); `"email"` lowercase slot vs `"Email"` caption variants (false negative); multi-text join can splice accidental matches. Only v2 `libraryItems` + oldest nested-`library` formats checked — the middle flat-`library` shape (handled in `loadLibraryItems`) is **not** handled here → all 10 slots miss → every `icon_*` silently degrades to plain boxes. Drift only `console.error`s; `applyIcons` swallows it.
- Trigger: upstream `awesome-icons` re-export in flat format.
- Fix: normalize (lowercase, token-boundary match `/\buser\b/`); support all three payload shapes via `normalizePayload`; surface drift in `render_diagram` response (`warnings: [...]`) instead of stderr-only.

### 4.2 `instantiateIcon` degenerate templates — degrades (ghost cards)
`src/library.ts:371-405`.
- All-text template → `art=[]` → caller already grew the box (see §1.9). Zero-bbox (no x/y/width) → `[]` same path. `natW/H` clamped to ≥1, so a 1px speck scales `targetW/1` ≈ 100× into a streak. Strokes/fonts not scaled with `s` (hairlines on blown-up art, tiny text on shrunk art).
- Trigger: caption-only library items; single-dot paths.
- Fix: return `null` on degenerate + caller skips mutation (check *before* grow); scale `strokeWidth` by `s` (clamp 0.5–4); reject `s` outside 0.05–20 as corrupt.

### 4.3 Scale extremes in `applyDecorations` — breaks
`src/library.ts:306-364`. `scale` unvalidated: `0` collapses to a point (zero-size, `fitViewport` Infinity math); negative mirrors + negative width/height (Excalidraw drops or mis-renders); `100` explodes bounds → viewport zoom ≈ 0 (canvas looks empty); `NaN` → `num()` default 0 in clone but `w` computed with raw `*scale` = NaN → `cursorX=NaN` poisons all subsequent tiles. `x/y` explicit placement skips collision entirely.
- Trigger: agent passes `scale: 0` / `scale: 10` experimentally.
- Fix: clamp `scale` to 0.2–3, reject NaN/negative with the valid range in the error; validate `x/y` finite.

### 4.4 Image-type items skipped — degrades (index drift)
`src/library.ts:197-223`. `normalizePayload` drops `type:"image"` (needs files map — reasonable) but `list_library_items` then reports *post-filter* indexes/names while users pick indexes from excalidraw.com order → wrong item placed, silently. Image-only groups vanish, shifting every later index between versions.
- Trigger: any library with embedded PNGs.
- Fix: keep placeholder entries (`{name, kind:"image", unavailable:true}`) so indexes stay stable; `applyDecorations` rejects image indexes with "needs export without images" message.

### 4.5 Stale disk cache — annoys
`src/library.ts:263-291`. `isCacheFresh` (7-day TTL) is **never called**; `payloadCache` is process-lifetime; cache written but never revalidated → upstream fixes never arrive.
- Fix: check `isCacheFresh` on read; refetch async in background when stale; expose `diagram-tool library refresh`.

---

## 5. llm.ts (BYOK path)

### 5.1 Provider response-shape drift — breaks
`src/llm.ts:84-136`. Assumes OpenAI `choices[0].message.content: string` (reasoning models return content *arrays* → `.trim` TypeError), Anthropic text-only blocks (tool_use/thinking-only → `""`), Google `candidates[0]` present (safety blocks → no candidates → `""`). All surface as "empty response" or TypeError, not as the real cause.
- Trigger: switching `--model` to a reasoning model; safety-blocked prompt.
- Fix: content-to-string helper (join arrays/parts, skip thinking/tool blocks, surface `blockReason`/`stop_reason`); wrap accessors so drift yields "provider changed shape: …" not TypeError.

### 5.2 Empty-text never retried — annoys (wastes a generate attempt)
`src/llm.ts:139-155`. `complete()` throws `LlmError("empty response")` with no status; `isTransient(undefined, err)` regex-tests the *message* — "empty response from model" matches nothing → **no retry**, contradicting the "one automatic retry" contract. Costs 1 of 3 `generate()` attempts.
- Trigger: any empty completion (common on rate-limit edge).
- Fix: treat empty as transient (retry once after backoff); count empties separately in `generate()` attempts.

### 5.3 Timeout ignores `timeoutMs` — breaks slow models
`src/llm.ts:55,97-131`. `LlmOpts.timeoutMs` is accepted but `completeOnce` hardcodes `30_000` in all four branches. Local Ollama 70B / queued OpenRouter / Opus routinely exceed 30 s → `AbortError` → one blind retry → fail. No per-provider tuning, no signal that raising `--timeout` would help (there is no such flag either).
- Trigger: big local models, cold OpenRouter workers.
- Fix: plumb `opts.timeoutMs ?? 60_000` (120 s for ollama) through `postJson`; add `--timeout` CLI flag; include elapsed ms in timeout errors.

---

## 6. cli.ts / mcp.ts / context.ts

### 6.1 Arg-parsing gaps — annoys
`src/cli.ts:65-107`. `--port Number()` unvalidated (NaN/−1/99999 → cryptic `serveHono` throw); `--provider` typo caught, but stale env `MODEL` persists across provider switch (`--provider anthropic` keeps `gpt-4.1-mini` → provider 404); unknown `--flags` throw (good) but unknown *positionals* (`diagram-tool foo`) are treated as a BYOK prompt — a typo can bill an API key; `render` ignores extra args; `.env` parser misses `export`, inline comments, multiline quotes and always reads CWD `.env` even for `--context` elsewhere.
- Fix: validate port range + `Number.isInteger`; recompute default model when `--provider` explicitly set; error on ambiguous positionals (`did you mean 'edit'?`); use `dotenv`-compatible parsing or drop it.

### 6.2 Context-file corruption kills everything — breaks
`src/context.ts:38-49`. `JSON.parse` throws raw `SyntaxError` (no path, no backup, no recovery). Callers: `render` dies, `GET /api/context` 500s (viewer shows "Failed to load"), SSE `hello` falls back to `rev:-1` (masks the problem). No schema check — `rev: "3"` (string) resets to 0 → rev goes backwards → viewer `===` checks stall; `scene.elements` non-array → later `.length` throws elsewhere.
- Trigger: killed mid-write (see §3.1), hand-edit typo (the documented workflow!).
- Fix: keep `path.bak` on every save; on parse failure load `.bak`, else `blankContext` + return `{corrupt:true, detail}` with line number; validate shape with a tiny guard (`rev` finite number, `elements` array) and repair/default.

### 6.3 Concurrent forge processes on one context file — breaks (lost revs)
`src/context.ts:52-76`, `src/mcp.ts:123-127`. `saveContext` read-modify-write + non-atomic `writeFile` + sidecar writes (3 files, not transactional). Two `render_diagram` calls (two agents, or CLI+MCP) interleave → same rev N+1 twice, sidecars from different revs (`.mmd` rev N+2 with `.excalidraw.json` rev N+1). MCP has no per-context mutex; stdio `pump()` (§6.4) can even double-dispatch *within* one process.
- Trigger: two OpenCode sessions sharing a repo/context file.
- Fix: in-process async mutex per context path; atomic tmp+rename for all three files; optional `flock` (proper-lockfile) across processes; `saveContext` takes expected-rev and throws 409-style conflict for the MCP layer to surface as "rebase and retry".

### 6.4 MCP stdio double-dispatch — breaks (duplicate rev bumps)
`src/mcp.ts:227-258`. Every `stdin.on("data")` chunk spawns a `pump()` drain loop with no guard — overlapping pumps parse the same buffered line twice → `render_diagram` executes twice → double rev bump + double `ensureUrl`. `Content-Length` framing regex only matches at buffer start. `maybeExit` 20 ms flush can truncate stdout responses under load.
- Trigger: pipelined `tools/call` requests (agent batching get+render).
- Fix: single-flight pump flag (`if (pumping) return`); buffer full Content-Length grammar; flush via `process.stdout.write` callback before `exit`.

---

## Prioritized fix list (user-visible impact first)

1. Atomic context writes + `.bak` + corruption recovery (§3.1/§6.2) — ends blank-canvas + lost-work incidents.
2. 409/rebase that preserves user edits instead of discarding them (§3.2) — stops silent stroke loss.
3. Sanitize converter output: non-finite geometry, dup ids, zero-area (§1.5) + finite-guards in `reanchor` (§1.9) — ends white-screen crashes.
4. Declutter by groupId cohorts; fix icon-card splitting + 1-point arrows (§1.8) — icons stay glued to nodes.
5. Check icon art *before* growing node boxes; handle degenerate templates (§1.9/§4.2) — ends ghost empty cards.
6. `parseIconClasses` hyphen/semicolon/comment + `:::` shorthand support (§1.10) — restores silently-missing icons.
7. `extractMermaid` fallbacks (unterminated fence, `~~~`, last-block) + full-source repair prompts (§1.1/§1.4) — fewer failed generations.
8. Don't clobber viewport on remote revs; guard empty-scene `fitViewport` (§3.5) — zoom/pan survives agent updates.
9. Plumb `timeoutMs`, retry empty responses, harden provider shapes (§5.1–5.3) — BYOK slow-model reliability.
10. Clamp/validate decoration `scale`; stable indexes with image placeholders; honor cache TTL (§4.3–4.5) — predictable library icons.
