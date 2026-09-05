#!/usr/bin/env node
/**
 * diagram-tool — CLI + localhost React canvas around one context file.
 *
 *   diagram-tool "draw a login flowchart"   # generate -> context file -> serve UI
 *   diagram-tool edit "add a payment step"  # follow-up via CLI
 *   diagram-tool render [file.mmd]          # re-derive scene from context (or file) mermaid
 *   diagram-tool serve                      # just serve the UI
 *
 * UI edits autosave to the same context file. OpenCode loop: prompt OpenCode
 * to edit diagram-tool.context.json's mermaidSource, then `diagram-tool render`.
 */
import { readFile } from "node:fs/promises";
import { DEFAULT_CONTEXT, loadContext, saveContext } from "./context.js";
import { convertToScene, generate } from "./diagram.js";
import { serve } from "./server.js";
import { runMcp } from "./mcp.js";
import { DEFAULT_MODELS, type Provider } from "./llm.js";

const PROVIDERS = ["openai", "anthropic", "google", "ollama", "openrouter"] as const;

function help(): string {
  return `diagram-tool — Mermaid -> Excalidraw on localhost, synced through a context file.
No API key needed for MCP / render / serve (the agent is the LLM).

Usage:
  diagram-tool mcp [--context <file>] [--port <n>] [--no-serve]
                                   MCP stdio server for any coding agent (recommended)
  diagram-tool mcp-install [--agent auto|opencode|claude|cursor|vscode]
                                   write the MCP snippet into your agent config
  diagram-tool render [file.mmd]          re-derive scene from context (or given) mermaid, no LLM
  diagram-tool serve                      serve the UI for the context file
  diagram-tool library list               list downloaded libraries
  diagram-tool library add <name>         download a library from libraries.excalidraw.com
  diagram-tool "..." [options]            generate via BYOK provider (optional fallback, needs key)
  diagram-tool edit "..." [options]       follow-up edit via BYOK provider

Options:
  --context <file>   context file (default ${DEFAULT_CONTEXT})
  --agent <a>        mcp-install target (default auto)
  --provider <p>     BYOK only: ${PROVIDERS.join("|")} (default $DIAGRAM_TOOL_PROVIDER or openai)
  --model <name>     BYOK only (default per provider)
  --api-key <key>    BYOK (or $OPENAI_API_KEY / $ANTHROPIC_API_KEY / $GOOGLE_API_KEY / $OPENROUTER_API_KEY)
  --base-url <url>   proxy / Ollama host
  --port <n>         (default 3000, $DIAGRAM_TOOL_PORT)
  --no-serve         don't start the UI after generate/edit/render (mcp: file-only mode)

Agent loop (no key): connect diagram-tool mcp, ask the agent to draw, open the
returned url once — it live-updates. Shell fallback: edit "mermaidSource"
in ${DEFAULT_CONTEXT}, then \`diagram-tool render --no-serve\`.`;
}

interface Flags {
  context: string;
  provider: Provider;
  model: string;
  modelSet: boolean;
  apiKey?: string;
  baseUrl?: string;
  port: number;
  serveAfter: boolean;
  agent: string;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {
    context: process.env.DIAGRAM_TOOL_CONTEXT || process.env.FORGE_CONTEXT || DEFAULT_CONTEXT,
    provider: ((process.env.DIAGRAM_TOOL_PROVIDER || process.env.FORGE_PROVIDER) as Provider) || "openai",
    model: process.env.DIAGRAM_TOOL_MODEL || process.env.FORGE_MODEL || "gpt-4.1-mini",
    modelSet: !!(process.env.DIAGRAM_TOOL_MODEL || process.env.FORGE_MODEL),
    port: Number(process.env.DIAGRAM_TOOL_PORT || process.env.FORGE_PORT || 3000),
    serveAfter: true,
    agent: "auto",
  };
  if (process.env.DIAGRAM_TOOL_API_KEY || process.env.FORGE_API_KEY) {
    flags.apiKey = process.env.DIAGRAM_TOOL_API_KEY || process.env.FORGE_API_KEY;
  }
  if (process.env.DIAGRAM_TOOL_BASE_URL || process.env.FORGE_BASE_URL) {
    flags.baseUrl = process.env.DIAGRAM_TOOL_BASE_URL || process.env.FORGE_BASE_URL;
  }
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${t} needs a value`);
      return v;
    };
    if (t === "--help" || t === "-h") {
      console.log(help());
      process.exit(0);
    } else if (t === "--context") flags.context = next();
    else if (t === "--agent") flags.agent = next();
    else if (t === "--provider") flags.provider = next() as Provider;
    else if (t === "--model") {
      flags.model = next();
      flags.modelSet = true;
    } else if (t === "--api-key") flags.apiKey = next();
    else if (t === "--base-url") flags.baseUrl = next();
    else if (t === "--port") flags.port = Number(next());
    else if (t === "--no-serve") flags.serveAfter = false;
    else if (t.startsWith("--")) throw new Error(`unknown flag ${t}`);
    else rest.push(t);
  }
  if (!flags.modelSet) flags.model = DEFAULT_MODELS[flags.provider] ?? flags.model;
  return { flags, rest };
}

async function main(): Promise<void> {
  try {
    const env = await readFile(".env", "utf8");
    for (const line of env.split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m || process.env[m[1]!] !== undefined) continue;
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]!] = v;
    }
  } catch {
    /* no .env — fine */
  }
  const { flags: f, rest } = parseFlags(process.argv.slice(2));
  if (!PROVIDERS.includes(f.provider)) throw new Error(`unknown provider "${f.provider}" (${PROVIDERS.join("|")})`);

  const [cmd, ...cmdRest] = rest;
  if (!cmd) {
    console.log(help());
    process.exit(1);
  }

  if (cmd === "serve") {
    await serve(f.context, f.port);
    return;
  }

  if (cmd === "mcp") {
    await runMcp({ context: f.context, port: f.port, noServe: !f.serveAfter });
    return;
  }

  if (cmd === "mcp-install") {
    const { installMcp } = await import("./mcp-install.js");
    await installMcp(f.agent);
    return;
  }

  if (cmd === "library") {
    const { readdir } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const sub = cmdRest[0];
    if (sub === "list" || !sub) {
      const { loadLibraryItems, libraryDir } = await import("./library.js");
      const dir = libraryDir();
      if (!existsSync(dir)) {
        console.log("no libraries/ directory");
        return;
      }
      const files = (await readdir(dir)).filter((x) => x.endsWith(".excalidrawlib"));
      const items = await loadLibraryItems(dir);
      console.log(`${files.length} files, ${items.length} items:`);
      for (const x of files) console.log(`  ${x}`);
      return;
    }
    if (sub === "add") {
      const query = (cmdRest[1] ?? "").toLowerCase();
      if (!query) throw new Error("usage: diagram-tool library add <name>  (e.g. diagram-tool library add aws)");
      console.error("fetching library index…");
      const res = await fetch("https://raw.githubusercontent.com/excalidraw/excalidraw-libs/main/libraries.json");
      if (!res.ok) throw new Error(`index fetch failed: HTTP ${res.status}`);
      const index = (await res.json()) as { name: string; source: string }[];
      const hit = index.find((l) => l.name.toLowerCase().includes(query));
      if (!hit) throw new Error(`no library matching "${query}" (try a shorter term)`);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir("libraries", { recursive: true });
      const url = `https://raw.githubusercontent.com/excalidraw/excalidraw-libs/main/libraries/${hit.source}`;
      console.error(`downloading ${hit.name}…`);
      const dl = await fetch(url);
      if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
      const dest = `libraries/${hit.source.split("/").pop()}`;
      await writeFile(dest, Buffer.from(await dl.arrayBuffer()));
      console.log(`added ${hit.name} -> ${dest} (restart diagram-tool serve to load)`);
      return;
    }
    throw new Error(`unknown library command "${sub}" (list|add)`);
  }

  if (cmd === "render") {
    const mmdFile = cmdRest[0];
    let mermaidSource: string;
    if (mmdFile) {
      mermaidSource = (await readFile(mmdFile, "utf8")).trim();
    } else {
      mermaidSource = (await loadContext(f.context)).mermaidSource;
      if (!mermaidSource.trim()) throw new Error(`no mermaidSource in ${f.context} (and no file given)`);
    }
    const scene = await convertToScene(mermaidSource);
    const next = await saveContext(f.context, { mermaidSource, elements: scene.elements as unknown[] });
    console.log(`rendered rev ${next.rev} into ${f.context} (${scene.elements.length} elements)`);
    if (f.serveAfter) await serve(f.context, f.port);
    return;
  }

  const isEdit = cmd === "edit";
  const prompt = (isEdit ? cmdRest : rest).join(" ");
  if (!prompt) {
    console.log(help());
    process.exit(1);
  }
  let existingMermaid: string | undefined;
  if (isEdit) {
    existingMermaid = (await loadContext(f.context)).mermaidSource;
    if (!existingMermaid.trim()) throw new Error(`${f.context} has no mermaidSource to edit yet — generate first.`);
  }
  console.error(`asking ${f.provider}/${f.model} ...`);
  const t0 = Date.now();
  const r = await generate(prompt, {
    provider: f.provider,
    model: f.model,
    ...(f.apiKey ? { apiKey: f.apiKey } : {}),
    ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
    ...(existingMermaid ? { existingMermaid } : {}),
  });
  const next = await saveContext(f.context, {
    prompt,
    mermaidSource: r.mermaidSource,
    elements: r.scene.elements as unknown[],
  });
  console.error(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s — rev ${next.rev} in ${f.context} (${r.scene.elements.length} elements${r.repaired ? `, repaired after ${r.attempts} attempts` : ""})`,
  );
  if (f.serveAfter) await serve(f.context, f.port);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
