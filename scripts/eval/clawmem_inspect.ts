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
  repo: string;
  configFile: string;
  limit: number;
  query: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const harness = createHarness(args.configFile);
  createClawMemPlugin(harness.api as never);
  const memoryList = harness.tool("memory_list");
  const memoryRecall = harness.tool("memory_recall");

  const list = await memoryList("inspect", {
    agentId: args.agentId,
    repo: args.repo,
    status: "active",
    limit: args.limit,
  });
  console.log(resultText(list));

  if (args.query) {
    console.log("\n--- recall ---");
    const recall = await memoryRecall("inspect", {
      agentId: args.agentId,
      repo: args.repo,
      query: args.query,
      limit: args.limit,
    });
    console.log(resultText(recall));
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agentId: env("CLAWMEM_EVAL_AGENT_ID", "eval-clawmem"),
    repo: "",
    configFile: env("CLAWMEM_EVAL_CONFIG_FILE", "eval/runs/clawmem-eval-agent-config.json"),
    limit: 20,
    query: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--agent-id" && next) { args.agentId = next; index += 1; continue; }
    if (flag === "--repo" && next) { args.repo = next; index += 1; continue; }
    if (flag === "--config-file" && next) { args.configFile = next; index += 1; continue; }
    if (flag === "--limit" && next) { args.limit = Number(next); index += 1; continue; }
    if (flag === "--query" && next) { args.query = next; index += 1; continue; }
    if (flag === "--help") usage(0);
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!args.repo) usage(1);
  return args;
}

function usage(exitCode: number): never {
  const message = [
    "Usage:",
    "  npx --yes tsx scripts/eval/clawmem_inspect.ts --agent-id AGENT --repo owner/repo --config-file eval/runs/clawmem-eval-agent-config.json",
    "",
    "Lists active memories, and optionally runs memory_recall with --query.",
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function createHarness(configFile: string) {
  const tools = new Map<string, Tool>();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-inspect-"));
  const configRoot = loadConfigRoot(configFile);
  const api = {
    id: "clawmem",
    pluginConfig: configRoot.plugins.entries.clawmem.config,
    logger: {
      info: (message: string) => process.stderr.write(`[clawmem-inspect] ${message}\n`),
      warn: (message: string) => process.stderr.write(`[clawmem-inspect] WARN ${message}\n`),
    },
    runtime: {
      version: "2026.4.9",
      config: {
        loadConfig: () => configRoot,
        writeConfigFile: async () => {},
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
    tool(name: string): ToolExecute {
      const execute = tools.get(name)?.execute;
      if (typeof execute !== "function") throw new Error(`ClawMem did not register ${name}`);
      return execute;
    },
  };
}

function loadConfigRoot(configFile: string): Record<string, any> {
  const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const config = parsed?.plugins?.entries?.clawmem?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${configFile} does not contain plugins.entries.clawmem.config`);
  }
  return parsed;
}

function resultText(result: ToolResult | undefined): string {
  return result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

main().catch((error) => {
  process.stderr.write(`[clawmem-inspect] ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
