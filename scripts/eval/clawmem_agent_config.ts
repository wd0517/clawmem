#!/usr/bin/env -S npx --yes tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClawMemPlugin } from "../../src/service.js";

type ToolResult = { content?: Array<{ text?: string }> };
type ToolExecute = (id: string, params: unknown) => Promise<ToolResult>;
type Tool = { name?: string; execute?: ToolExecute };

type Args = {
  agentId: string;
  output: string;
  baseUrl: string;
  repoName: string;
};

function main(): void {
  run().catch((error) => {
    process.stderr.write(`[clawmem-agent-config] ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const harness = createPluginHarness(args);
  createClawMemPlugin(harness.api as never);

  const repos = harness.tool("memory_repos");
  const createRepo = harness.tool("memory_repo_create");

  await repos("eval", { agentId: args.agentId });
  if (args.repoName) {
    const result = await createRepo("eval", {
      agentId: args.agentId,
      name: args.repoName,
      private: true,
      setDefault: true,
      description: `ClawMem eval repo for ${args.agentId}`,
    });
    const text = resultText(result);
    if (!/^(Created memory repo|Unable to create)/.test(text)) {
      throw new Error(text || `unexpected memory_repo_create response for ${args.repoName}`);
    }
  }

  saveConfig(args.output, harness.configRoot());
  const agent = harness.configRoot().plugins.entries.clawmem.config.agents[args.agentId] ?? {};
  if (!agent.token) throw new Error(`provisioned config for ${args.agentId} did not contain a token`);
  console.log([
    `Saved ClawMem agent config to ${args.output}`,
    `agentId: ${args.agentId}`,
    `login: ${agent.login ?? "(unknown)"}`,
    `defaultRepo: ${agent.defaultRepo ?? "(none)"}`,
    `token: stored (${String(agent.token).length} chars)`,
  ].join("\n"));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agentId: normalizeAgentPart(env("CLAWMEM_EVAL_AGENT_ID", "eval-clawmem")),
    output: env("CLAWMEM_EVAL_CONFIG_FILE", "eval/runs/clawmem-eval-agent-config.json"),
    baseUrl: env("CLAWMEM_EVAL_BASE_URL", "https://git.clawmem.ai/api/v3"),
    repoName: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--agent-id" && next) { args.agentId = normalizeAgentPart(next); index += 1; continue; }
    if (flag === "--output" && next) { args.output = next; index += 1; continue; }
    if (flag === "--base-url" && next) { args.baseUrl = next; index += 1; continue; }
    if (flag === "--repo-name" && next) { args.repoName = normalizeRepoNamePart(next); index += 1; continue; }
    if (flag === "--help") usage(0);
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!args.agentId) throw new Error("--agent-id is required");
  return args;
}

function usage(exitCode: number): never {
  const message = [
    "Usage:",
    "  npx --yes tsx scripts/eval/clawmem_agent_config.ts --agent-id eval-clawmem-plugin-finalize-mini-20260429 --output eval/runs/clawmem-eval-agent-config.json",
    "",
    "Provisions or refreshes a ClawMem backend identity through the real plugin flow",
    "and writes the resulting token/config to a local ignored JSON file.",
    "",
    "Options:",
    "  --agent-id ID     OpenClaw/ClawMem agent id to provision",
    "  --output PATH     local JSON file to write; default eval/runs/clawmem-eval-agent-config.json",
    "  --base-url URL    backend API base URL; default https://git.clawmem.ai/api/v3",
    "  --repo-name NAME  optionally create a repo and set it as this agent's default",
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function createPluginHarness(args: Args) {
  const tools = new Map<string, Tool>();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-agent-config-"));
  let configRoot: Record<string, any> = loadConfigRoot(args.output, {
    plugins: {
      entries: {
        clawmem: {
          config: {
            baseUrl: args.baseUrl,
            authScheme: "token",
            agents: {},
          },
        },
      },
      slots: {
        memory: "clawmem",
      },
    },
  });

  const api = {
    id: "clawmem",
    pluginConfig: configRoot.plugins.entries.clawmem.config,
    logger: {
      info: (message: string) => process.stderr.write(`[clawmem-agent-config] ${message}\n`),
      warn: (message: string) => process.stderr.write(`[clawmem-agent-config] WARN ${message}\n`),
    },
    runtime: {
      version: "2026.4.9",
      config: {
        loadConfig: () => configRoot,
        writeConfigFile: async (next: Record<string, any>) => { configRoot = next; },
      },
      events: { onSessionTranscriptUpdate: () => () => {} },
      state: {
        get: () => undefined,
        set: () => {},
        resolveStateDir: () => stateDir,
      },
      subagent: {
        run: async () => ({ runId: "unused" }),
        waitForRun: async () => ({ status: "complete" }),
        getSessionMessages: async () => ({ messages: [] }),
        deleteSession: async () => {},
      },
    },
    on: () => {},
    registerTool: (tool: Tool) => {
      if (tool.name) tools.set(tool.name, tool);
    },
    registerService: () => {},
    registerMemoryCapability: () => {},
  };

  return {
    api,
    configRoot: () => configRoot,
    tool(name: string): ToolExecute {
      const execute = tools.get(name)?.execute;
      if (typeof execute !== "function") throw new Error(`ClawMem did not register ${name}`);
      return execute;
    },
  };
}

function saveConfig(output: string, configRoot: Record<string, any>): void {
  const config = configRoot.plugins.entries.clawmem.config;
  const payload = {
    saved_at: new Date().toISOString(),
    plugins: {
      entries: {
        clawmem: {
          config,
        },
      },
      slots: {
        memory: "clawmem",
      },
    },
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(output, 0o600);
}

function loadConfigRoot(filePath: string, fallback: Record<string, any>): Record<string, any> {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const config = parsed?.plugins?.entries?.clawmem?.config;
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return parsed;
    }
  } catch {
    // If the local credential file is corrupt, fall back to provisioning a new one.
  }
  return fallback;
}

function resultText(result: ToolResult | undefined): string {
  return result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

function normalizeAgentPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-") || "eval";
}

function normalizeRepoNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-") || "memory";
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

main();
