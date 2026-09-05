/** diagram-tool mcp-install — write the MCP snippet into agent configs. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const SNIPPET = { command: "npx", args: ["-y", "diagram-tool", "mcp"] };

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`updated ${path}`);
}

/** Generic mcpServers.json shape (Claude Code / Cursor / Windsurf / VSCode). */
async function installGeneric(path: string): Promise<void> {
  const cfg = await readJson(path);
  const servers = (cfg.mcpServers as Record<string, unknown>) ?? {};
  servers["diagram-tool"] = SNIPPET;
  cfg.mcpServers = servers;
  await writeJson(path, cfg);
}

/** OpenCode shape: { mcp: { diagram-tool: { type: "local", command: [...], enabled: true } } } */
async function installOpenCode(path: string): Promise<void> {
  const cfg = await readJson(path);
  const mcp = (cfg.mcp as Record<string, unknown>) ?? {};
  mcp["diagram-tool"] = { type: "local", command: [...["npx", "-y", "diagram-tool"], "mcp"], enabled: true };
  cfg.mcp = mcp;
  await writeJson(path, cfg);
}

function detect(): string {
  if (existsSync(".cursor") || existsSync(join(homedir(), ".cursor", "mcp.json"))) return "cursor";
  if (existsSync(".vscode") || existsSync(join(homedir(), ".vscode", "mcp.json"))) return "vscode";
  if (existsSync("opencode.json")) return "opencode";
  return "claude";
}

export async function installMcp(agent: string): Promise<void> {
  const a = agent === "auto" ? detect() : agent;
  switch (a) {
    case "opencode": {
      const local = "opencode.json";
      await installOpenCode(existsSync(local) ? local : join(homedir(), ".config", "opencode", "opencode.json"));
      break;
    }
    case "cursor":
      await installGeneric(existsSync(".cursor") ? ".cursor/mcp.json" : join(homedir(), ".cursor", "mcp.json"));
      break;
    case "vscode":
      await installGeneric(existsSync(".vscode") ? ".vscode/mcp.json" : join(homedir(), ".vscode", "mcp.json"));
      break;
    case "claude":
      await installGeneric(join(homedir(), ".config", "Claude", "claude_desktop_config.json"));
      break;
    default:
      throw new Error(`unknown agent "${agent}" (auto|opencode|claude|cursor|vscode)`);
  }
  console.log('verify: restart your agent, then ask it to list tools — "diagram-tool" with render_diagram should appear.');
  console.log('manual snippet: {"mcpServers":{"diagram-tool":{"command":"npx","args":["-y","diagram-tool","mcp"]}}}');
}
