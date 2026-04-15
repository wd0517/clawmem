import { hasDefaultRepo, isAgentConfigured, isManagedLabel, resolveAgentRoute, resolveLabelColor } from "./config.js";
import type { ClawMemPluginConfig } from "./types.js";
import { buildAgentBootstrapRegistration, DEFAULT_BOOTSTRAP_REPO_NAME } from "./utils.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function baseConfig(): ClawMemPluginConfig {
  return {
    baseUrl: "https://git.clawmem.ai/api/v3",
    login: "global-login",
    authScheme: "token",
    token: "top-token",
    defaultRepo: "global/default-memory",
    repo: "global/legacy-memory",
    agents: {
      main: {
        login: "main-login",
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
    memoryAutoRecallLimit: 3,
    summaryWaitTimeoutMs: 120000,
    memoryExtractWaitTimeoutMs: 45000,
  };
}

function testDefaultRepoResolution(): void {
  const route = resolveAgentRoute(baseConfig(), "main");
  assert(route.defaultRepo === "main/private-memory", "expected per-agent defaultRepo to be preferred");
  assert(route.repo === "main/private-memory", "expected selected repo to default to defaultRepo");
  assert(route.token === "agent-token", "expected per-agent token to be preferred");
  assert(route.login === "main-login", "expected per-agent login to be preferred");
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
  assert(route.login === "global-login", "expected global login to flow into resolved routes");
}

function testBootstrapRegistrationUsesStableDefaults(): void {
  const registration = buildAgentBootstrapRegistration("Main_Coder");
  assert(registration.prefixLogin === "main-coder", "expected agent bootstrap login prefix to match backend format");
  assert(registration.defaultRepoName === DEFAULT_BOOTSTRAP_REPO_NAME, "expected bootstrap repo name to use the stable default");
}

function testBootstrapRegistrationTrimsLongPrefixes(): void {
  const registration = buildAgentBootstrapRegistration("___THIS_IS_A_SUPER_LONG_AGENT_ID_THAT_SHOULD_BE_TRIMMED___");
  assert(/^[a-z0-9][a-z0-9-]*$/.test(registration.prefixLogin), "expected bootstrap login prefix to satisfy backend validation");
  assert(registration.prefixLogin.length <= 32, "expected bootstrap login prefix to fit backend max length");
}

function testTaskQueueLabelsAreManaged(): void {
  assert(isManagedLabel("type:memory"), "expected type label to be managed");
  assert(isManagedLabel("kind:decision"), "expected kind label to be managed");
  assert(isManagedLabel("topic:redis"), "expected topic label to be managed");
  assert(resolveLabelColor("type:memory") === "5319e7", "expected memory type labels to use a stable color");
  assert(resolveLabelColor("topic:redis") === "fbca04", "expected topic labels to use the topic color");
}

testDefaultRepoResolution();
testRepoOverride();
testLegacyRepoFallback();
testIdentityOnlyStillConfigured();
testBootstrapRegistrationUsesStableDefaults();
testBootstrapRegistrationTrimsLongPrefixes();
testTaskQueueLabelsAreManaged();

console.log("config tests passed");
