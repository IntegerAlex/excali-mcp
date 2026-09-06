# Media: videos, talks, podcasts (all URLs verified live 2026-09-06)

## Excalidraw: how it works + AI whiteboarding

1. **Excalidraw: Cool JS Tricks Behind the Scenes — Christopher Chedeau (vjeux), React Europe 2020** — https://www.youtube.com/watch?v=fix2-SynPGE
   Roughness = jittered points + bezier; circles overshoot to the *second* point; deliberately few options (Architect/Artist/Cartoonist). Lesson for us: expose style presets, not sliders; always emit real text, never text-as-paths.
2. **AI and Human Whiteboarding Partnership — Chedeau, AI Engineer** — https://ai.engineer/talks/ai-and-human-whiteboarding-partnership
   Excalidraw's own winning pattern is exactly ours: LLM → Mermaid DSL → deterministic converter → editable elements. Direct LLM→drawing failed ("didn't even resemble a house"). Editable draft beats pixel-perfect image.
3. **Excalidraw and Fugu — Google I/O 2021 (Lipis)** — https://www.youtube.com/watch?v=EK1AkxgQwro
   Color/library choices > rendering tricks for readability; users will want MCP output saved to cloud docs — plan for it.
4. **Auto-generate architecture diagrams with the Excalidraw MCP server** — https://www.youtube.com/watch?v=QqPzLYieUFc
   Closest reference implementation to diagram-tool. Study its tool schema; note its overlap/label failure points against our backlog.
5. **Excalidraw-Obsidian Showcase (Viczián)** — https://www.youtube.com/watch?v=P_Q6avJGoWI
   Mermaid→scene + OpenAI text-to-diagram pipeline; LLM bad-syntax breakage fixed by retry/repair prompts — mirrors our self-repair loop.
6. **Wireframes with Libraries (official Excalidraw channel)** — https://www.youtube.com/watch?v=O1Kqxw07VWM
   Canonical library workflow; labels-in-fixed-boxes overflow is the canonical pain — our measure-first pipeline answers it.

## Mermaid as intermediate language

7. **Diagrams as Code with Mermaid, GitHub, VS Code (Farcic)** — https://www.youtube.com/watch?v=oiVy7NDm-WM
   Emit the `flowchart TD/LR` + subgraph subset; node-ID vs label confusion is where LLM syntax errors cluster — normalize server-side.
8. **New to Mermaid? (official channel)** — https://www.youtube.com/watch?v=p4gTbKcOXqk
   Mermaid AI chat is the UX bar (prompt→generate→edit loop); keep `.mmd` alongside elements for round-tripping.
9. **I'm in love with Mermaid (C. Cole, RubyConf 2022)** — https://www.rubyevents.org/talks/i-m-in-love-with-mermaid
   Diagrams diffed/reviewed like code; always emit titles for a11y; test `alt`/lanes (common breakage).

## Layout, visually explained

10. **Sugiyama Framework lecture (Univ. Trier)** — https://www.youtube.com/watch?v=3_FbSCWLC3A
    The 5-phase pipeline (cycle break → layer → crossing minimize → place → route); required viewing before tuning layered params.
11. **ELK — Miro Spönemann, EclipseCon** — https://www.youtube.com/watch?v=4rdrKxPQvbc
    140+ options reference; label placement as first-class phase; layout engine decoupled from editor — matches our pipeline split.
