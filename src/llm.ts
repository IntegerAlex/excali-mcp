/** Tiny fetch-based LLM layer. No provider SDKs. */

export type Provider = "openai" | "anthropic" | "google" | "ollama" | "openrouter";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOpts {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
}

export class LlmError extends Error {
  provider: string;
  status?: number;
  constructor(provider: string, message: string, status?: number) {
    super(`[${provider}] ${message}`);
    this.name = "LlmError";
    this.provider = provider;
    this.status = status;
  }
}

const DEFAULT_KEYS: Record<Provider, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ollama: [],
  openrouter: ["OPENROUTER_API_KEY"],
};

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.0-flash",
  ollama: "llama3.1",
  openrouter: "meta-llama/llama-3.3-70b-instruct",
};

export function resolveKey(provider: Provider, apiKey?: string): string | undefined {
  if (apiKey) return apiKey;
  for (const n of DEFAULT_KEYS[provider]) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
    if (!res.ok) {
      const msg = typeof data.error === "string" ? data.error : (data.error?.message ?? `HTTP ${res.status}`);
      const err = new Error(msg) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function isTransient(status?: number, err?: unknown): boolean {
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  const m = err instanceof Error ? err.message : String(err);
  return /timeout|abort|econnreset|fetch failed|socket hang up|overloaded/i.test(m);
}

async function completeOnce(provider: Provider, model: string, messages: ChatMsg[], o: Required<Pick<LlmOpts, "apiKey" | "baseUrl" | "temperature">> & { key?: string }): Promise<string> {
  const temp = o.temperature ?? 0.2;
  switch (provider) {
    case "openai":
    case "openrouter": {
      const base = provider === "openrouter"
        ? (o.baseUrl || "https://openrouter.ai").replace(/\/$/, "")
        : (o.baseUrl || "https://api.openai.com").replace(/\/$/, "");
      const url = `${base}/api/v1/chat/completions`;
      const headers: Record<string, string> =
        provider === "openrouter"
          ? { authorization: `Bearer ${o.key ?? ""}`, "HTTP-Referer": "https://github.com/diagram-tool", "X-Title": "Diagram Tool" }
          : { authorization: `Bearer ${o.key ?? ""}` };
      const d = (await postJson(url, headers, { model, messages, temperature: temp }, 30_000)) as {
        choices?: { message?: { content?: string } }[];
      };
      return d.choices?.[0]?.message?.content?.trim() ?? "";
    }
    case "ollama": {
      const base = (o.baseUrl || process.env.DIAGRAM_TOOL_BASE_URL || process.env.FORGE_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
      const d = (await postJson(`${base}/api/chat`, {}, { model, messages, stream: false, options: { temperature: temp } }, 30_000)) as {
        message?: { content?: string };
      };
      return d.message?.content?.trim() ?? "";
    }
    case "anthropic": {
      const base = (o.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const rest = messages.filter((m) => m.role !== "system");
      const d = (await postJson(
        `${base}/v1/messages`,
        { "x-api-key": o.key ?? "", "anthropic-version": "2023-06-01" },
        { model, max_tokens: 2048, ...(system ? { system } : {}), messages: rest, temperature: temp },
        30_000,
      )) as { content?: { type?: string; text?: string }[] };
      return d.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") ?? "";
    }
    case "google": {
      const base = (o.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const contents = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const d = (await postJson(
        `${base}/v1beta/models/${model}:generateContent?key=${o.key ?? ""}`,
        {},
        { ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { temperature: temp } },
        30_000,
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    }
  }
}

/** One automatic retry on 429/5xx/timeout. Throws LlmError otherwise. */
export async function complete(messages: ChatMsg[], opts: LlmOpts): Promise<string> {
  const key = resolveKey(opts.provider, opts.apiKey);
  const base = { apiKey: opts.apiKey ?? "", baseUrl: opts.baseUrl ?? "", temperature: opts.temperature ?? 0.2, key };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await completeOnce(opts.provider, opts.model, messages, base);
      if (!text) throw new LlmError(opts.provider, "empty response from model");
      return text;
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === 2 || !isTransient(status, e)) throw new LlmError(opts.provider, msg, status);
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
    }
  }
  throw new LlmError(opts.provider, "failed");
}
