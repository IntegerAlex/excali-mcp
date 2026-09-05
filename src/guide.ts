/** Single source of truth for agent-facing docs (plan §5).
 * Reused by: MCP `initialize` instructions (summary), tool descriptions,
 * `diagram-tool://guide` resource (full), and GUIDE.md generation. */

export const SERVER_INSTRUCTIONS = `Diagram Tool turns Mermaid into an Excalidraw scene with a live localhost UI.
Use it when the user asks to draw, visualize, diagram, or whiteboard anything.
Workflow: 1) get_diagram for current state (edits need it), 2) author the FULL mermaid source yourself, 3) render_diagram to validate+render — share the returned url. Open the url once; it live-updates on every render.
Structural changes = new mermaid + render. Never hand-edit scene.elements.
Supported types: flowchart, sequenceDiagram, erDiagram, classDiagram, stateDiagram-v2.`;

export const RENDER_DESCRIPTION = `Validate + render Mermaid into the shared Excalidraw scene (bumps rev, writes .excalidraw.json + .mmd sidecars, live UI updates). You author the mermaid — the server never calls an LLM.

TYPE CHOICE: processes/decisions/architecture -> flowchart (LR wide, TD tall); interactions over time -> sequenceDiagram; data models -> erDiagram; OOP -> classDiagram; states -> stateDiagram-v2.

FLOWCHART RULES: init line first: %%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 90, "curve": "linear"}}}%%. SELF-EXPLANATORY node ids (CLI, CTXFILE — never A/B/C). Declare ALL nodes first, then edges grouped with %% comments + blank lines (NO subgraphs — the renderer cannot draw them). Edge labels pipe-only: -->|reads|. Shape by role: rhombus {..} for decisions, [...] for everything else. End with palette + class on EVERY node: classDef actor fill:#e3f2fd,stroke:#1e88e5,stroke-width:2px / store fill:#fff3e0,stroke:#fb8c00 / flow fill:#e8f5e9,stroke:#43a047 / ext fill:#f3e5f5,stroke:#8e24aa. Max ~12 nodes. Hub with many edges -> TD. Max 3 edges per node; one edge per node pair (merge labels with " · ").

Example:
\`\`\`mermaid
%%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 90, "curve": "linear"}}}%%
flowchart LR
    USER["User"]
    CLI["diagram-tool CLI"]
    CTXFILE["diagram-tool.context.json"]
    USER-->|invokes|CLI
    CLI-->|writes rev|CTXFILE
    classDef actor fill:#e3f2fd,stroke:#1e88e5,stroke-width:2px
    classDef store fill:#fff3e0,stroke:#fb8c00,stroke-width:2px
    classDef flow fill:#e8f5e9,stroke:#43a047,stroke-width:2px
    classDef ext fill:#f3e5f5,stroke:#8e24aa,stroke-width:2px
    class USER actor
    class CLI flow
    class CTXFILE store
\`\`\`

LIBRARIES: cloud/architecture/system-design -> consider list_libraries (AWS/GCP/Azure/K8s icons via decorations, max ~6, decorate not replace). Logic flowcharts, sequence/ER/class diagrams -> NO libs, pure mermaid.
On parse error the server returns the error verbatim: fix ONLY the syntax and retry with the full source.`;

export const GET_DESCRIPTION = `Read the current diagram state {rev, prompt, mermaidSource}. Call first for edits/follow-ups so you preserve node IDs. Returns empty mermaidSource when nothing exists yet — then just render fresh.`;

export const LIST_LIBRARIES_DESCRIPTION = `Search the Excalidraw library catalog (all ~100 MIT libraries from libraries.excalidraw.com). Use for cloud/architecture/network diagrams where vendor icons help. Returns {slug, name, description, itemCount, sampleItems}. Empty query returns the curated top picks. Logic-only flowcharts, sequence/ER/class diagrams -> skip libs entirely (pure mermaid reads better).`;

export const LIST_ITEMS_DESCRIPTION = `List items inside one library {index, name, kind} so you can pick exact itemIndex values for render_diagram decorations. Call after list_libraries. Unbundled libraries are fetched on demand and cached — first call may take a few seconds.`;

export const GUIDE = `# Diagram Tool agent guide

## Concepts
- One context file (default \`diagram-tool.context.json\`) is the source of truth: \`{rev, prompt, mermaidSource, scene}\`.
- Every render bumps \`rev\`, rewrites sidecars (\`.excalidraw.json\` for excalidraw.com import, \`.mmd\` source), and the localhost UI (SSE \`GET /api/live\` push, refetches on rev change) applies the new rev without reload.
- UI canvas edits autosave back (\`POST /api/scene\`, stale rev -> 409). Prefer mermaid edits for structure; canvas for nudges.

## Recipes
- Create: author full mermaid -> \`render_diagram\` -> share \`url\`.
- Edit: \`get_diagram\` -> modify source preserving node IDs -> \`render_diagram\`.
- Restyle: same as edit (change classDefs/labels only).
- Import: paste an existing \`.mmd\` as \`mermaidSource\` and render.

## Few-shot: flowchart LR
\`\`\`mermaid
%%{init: {"flowchart": {"nodeSpacing": 60, "rankSpacing": 90, "curve": "linear"}}}%%
flowchart LR
    USER["User"]
    CLI["diagram-tool CLI"]
    CTXFILE["diagram-tool.context.json"]
    WEBUI["React Excalidraw UI"]
    USER-->|invokes|CLI
    CLI-->|writes rev|CTXFILE
    CTXFILE-->|polls|WEBUI
    classDef actor fill:#e3f2fd,stroke:#1e88e5,stroke-width:2px
    classDef store fill:#fff3e0,stroke:#fb8c00,stroke-width:2px
    classDef flow fill:#e8f5e9,stroke:#43a047,stroke-width:2px
    classDef ext fill:#f3e5f5,stroke:#8e24aa,stroke-width:2px
    class USER actor
    class CLI,WEBUI flow
    class CTXFILE store
\`\`\`

## Few-shot: sequenceDiagram
\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: GET /api/context
    activate S
    S-->>C: 200 context
    deactivate S
\`\`\`

## Libraries: when icons vs no icons
- Cloud/architecture/system-design -> \`list_libraries\` (aws/gcp/azure/kubernetes), pick <=6 icons, pass as \`decorations\`. Icons decorate labeled boxes; never drop labels.
- Network topologies -> \`network-topology-icons\`.
- Flowcharts of logic, sequence/ER/class/state diagrams -> NO libraries.
- Node icon classes (\`class USER actor,icon_user\`) also work with the 10 bundled slugs: icon_user, icon_users, icon_home, icon_lock, icon_search, icon_chart, icon_email, icon_calendar, icon_location, icon_payment.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Mermaid parse error (returned verbatim) | Fix syntax only, resend full source |
| Converter: no drawable elements / subgraph | Flatten subgraphs into plain nodes + edges |
| 409 rev conflict (UI edited meanwhile) | \`get_diagram\`, rebase, render again |
| Port 3000 taken | Server falls back to a free port; use returned \`url\` |
| Viewer bundle missing | Run the package build once (\`node src/viewer/build.mjs\`) |
| Library item index out of range | Error lists valid range; \`list_library_items\` to repick |
| Offline + uncached library | Connect once (fetch+cache) or stick to the 6 bundled libs |
`;
