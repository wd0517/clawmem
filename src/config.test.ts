import { hasDefaultRepo, isAgentConfigured, resolveAgentRoute } from "./config.js";
import type { ClawMemPluginConfig } from "./types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function baseConfig(): ClawMemPluginConfig {
  return {
    baseUrl: "https://git.clawmem.ai/api/v3",
    authScheme: "token",
    token: "top-token",
    defaultRepo: "global/default-memory",
    repo: "global/legacy-memory",
    agents: {
      main: {
        token: "agent-token",
        defaultRepo: "main/private-memory",
      },
      legacy: {
        token: "legacy-token",
        repo: "legacy/old-memory",
      },
      identityOnly: {
        token: "identity-token",
      },
    },
    memoryRecallLimit: 5,
    turnCommentDelayMs: 1000,
    summaryWaitTimeoutMs: 120000,
  };
}

function testDefaultRepoResolution(): void {
  const route = resolveAgentRoute(baseConfig(), "main");
  assert(route.defaultRepo === "main/private-memory", "expected per-agent defaultRepo to be preferred");
  assert(route.repo === "main/private-memory", "expected selected repo to default to defaultRepo");
  assert(route.token === "agent-token", "expected per-agent token to be preferred");
}

function testRepoOverride(): void {
  const route = resolveAgentRoute(baseConfig(), "main", "org/shared-memory");
  assert(route.defaultRepo === "main/private-memory", "expected defaultRepo to remain unchanged");
  assert(route.repo === "org/shared-memory", "expected explicit repo override to win");
}

function testLegacyRepoFallback(): void {
  const route = resolveAgentRoute(baseConfig(), "legacy");
  assert(route.defaultRepo === "legacy/old-memory", "expected legacy repo to act as defaultRepo fallback");
  assert(route.repo === "legacy/old-memory", "expected selected repo to use the legacy repo fallback");
}

function testIdentityOnlyStillConfigured(): void {
  const config = baseConfig();
  delete config.defaultRepo;
  delete config.repo;
  const route = resolveAgentRoute(config, "identityOnly");
  assert(isAgentConfigured(route) === true, "expected an identity with baseUrl and token to count as configured");
  assert(hasDefaultRepo(route) === false, "expected no default repo when only credentials are present");
}

testDefaultRepoResolution();
testRepoOverride();
testLegacyRepoFallback();
testIdentityOnlyStillConfigured();

console.log("config tests passed");
