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
  assert(isManagedLabel("queue:task"), "expected queue label to be managed");
  assert(isManagedLabel("task-status:handling"), "expected task status label to be managed");
  assert(isManagedLabel("task-status:done"), "expected done label to be managed");
  assert(isManagedLabel("assignee:agent-a"), "expected assignee label to be managed");
  assert(isManagedLabel("team:reviewing"), "expected team labels to be managed");
  assert(resolveLabelColor("queue:task") === "0e8a16", "expected queue labels to use a stable color");
  assert(resolveLabelColor("task-status:done") === "0e8a16", "expected done labels to use the done color");
  assert(resolveLabelColor("task-status:handling") === "d93f0b", "expected handling labels to use the in-progress color");
  assert(resolveLabelColor("team:reviewing") === "1d76db", "expected team labels to use the collaboration color");
}

function testTeamConfigResolution(): void {
  const config = baseConfig();
  config.teamConfigRepo = "acme/config";
  config.teamConfigIssueNumber = 7;
  config.agents.main.teamConfigIssueNumber = 11;

  const mainRoute = resolveAgentRoute(config, "main");
  assert(mainRoute.teamConfigRepo === "acme/config", "expected team config repo to fall back from the global config");
  assert(mainRoute.teamConfigIssueNumber === 11, "expected the per-agent issue number to override the global value");

  const legacyRoute = resolveAgentRoute(config, "legacy");
  assert(legacyRoute.teamConfigRepo === "acme/config", "expected other agents to inherit the global team config repo");
  assert(legacyRoute.teamConfigIssueNumber === 7, "expected other agents to inherit the global team config issue number");
}

testDefaultRepoResolution();
testRepoOverride();
testLegacyRepoFallback();
testIdentityOnlyStillConfigured();
testBootstrapRegistrationUsesStableDefaults();
testBootstrapRegistrationTrimsLongPrefixes();
testTaskQueueLabelsAreManaged();
testTeamConfigResolution();

console.log("config tests passed");
