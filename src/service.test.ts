import {
  buildLegacyRelevantMemoriesContext,
  buildRelevantMemoriesSystemContext,
  extractPromptTextForRecall,
  resolveOpenClawHostVersion,
  resolvePromptHookMode,
} from "./service.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testExtractPromptFromString(): void {
  assert(extractPromptTextForRecall("  help me fix redis  ") === "help me fix redis", "expected direct string prompts to be trimmed");
}

function testExtractPromptFromPromptField(): void {
  assert(
    extractPromptTextForRecall({ prompt: "Summarize the release notes." }) === "Summarize the release notes.",
    "expected prompt field to be used when present",
  );
}

function testExtractPromptFromLatestUserMessage(): void {
  const prompt = extractPromptTextForRecall({
    messages: [
      { role: "assistant", text: "How can I help?" },
      { role: "user", text: "Please fix the login bug." },
    ],
  });
  assert(prompt === "Please fix the login bug.", "expected the latest user message to drive recall");
}

function testExtractPromptFromStructuredContent(): void {
  const prompt = extractPromptTextForRecall({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Check the deployment logs" },
          { type: "text", text: "and verify nginx." },
        ],
      },
    ],
  });
  assert(prompt === "Check the deployment logs\nand verify nginx.", "expected structured text content to be flattened");
}

function testBuildRelevantMemoriesSystemContext(): void {
  const context = buildRelevantMemoriesSystemContext([
    { detail: "OpenClaw main agent identity uses Gandalf." },
    { detail: "Shared memories can break if the repo path changes." },
  ]);

  assert(context.includes("ClawMem relevant memories:"), "expected a human-readable heading");
  assert(context.includes("- OpenClaw main agent identity uses Gandalf."), "expected memories to be listed as bullets");
  assert(!context.includes("<relevant-memories>"), "expected the legacy XML wrapper to be removed");
}

function testBuildLegacyRelevantMemoriesContext(): void {
  const context = buildLegacyRelevantMemoriesContext([
    { detail: "Use the shared repo for team memory." },
  ]);

  assert(context.includes("Relevant ClawMem memories for this request:"), "expected a legacy-safe heading");
  assert(context.includes("- Use the shared repo for team memory."), "expected memories to stay readable");
  assert(!context.includes("<relevant-memories>"), "expected legacy context to avoid XML wrappers too");
}

function testResolveHostVersionFromRuntime(): void {
  const version = resolveOpenClawHostVersion({ runtime: { version: "2026.3.28" } } as never);
  assert(version === "2026.3.28", "expected runtime.version to take precedence");
}

function testResolveHostVersionFromEnvFallback(): void {
  const previous = {
    OPENCLAW_VERSION: process.env.OPENCLAW_VERSION,
    OPENCLAW_SERVICE_VERSION: process.env.OPENCLAW_SERVICE_VERSION,
    npm_package_version: process.env.npm_package_version,
  };
  try {
    delete process.env.OPENCLAW_VERSION;
    process.env.OPENCLAW_SERVICE_VERSION = "2026.3.6";
    delete process.env.npm_package_version;
    const version = resolveOpenClawHostVersion({ runtime: {} } as never);
    assert(version === "2026.3.6", "expected OPENCLAW_SERVICE_VERSION fallback");
  } finally {
    process.env.OPENCLAW_VERSION = previous.OPENCLAW_VERSION;
    process.env.OPENCLAW_SERVICE_VERSION = previous.OPENCLAW_SERVICE_VERSION;
    process.env.npm_package_version = previous.npm_package_version;
  }
}

function testResolvePromptHookModeModern(): void {
  const mode = resolvePromptHookMode({ runtime: { version: "2026.3.28" } } as never);
  assert(mode === "modern", "expected modern hook mode for OpenClaw 2026.3.28");
}

function testResolvePromptHookModeLegacy(): void {
  const mode = resolvePromptHookMode({ runtime: { version: "2026.3.6" } } as never);
  assert(mode === "legacy", "expected legacy hook mode before 2026.3.7");
}

function testResolvePromptHookModeLegacyForUnknownVersion(): void {
  const mode = resolvePromptHookMode({ runtime: {} } as never);
  assert(mode === "legacy", "expected unknown host versions to fall back to legacy mode");
}

testExtractPromptFromString();
testExtractPromptFromPromptField();
testExtractPromptFromLatestUserMessage();
testExtractPromptFromStructuredContent();
testBuildRelevantMemoriesSystemContext();
testBuildLegacyRelevantMemoriesContext();
testResolveHostVersionFromRuntime();
testResolveHostVersionFromEnvFallback();
testResolvePromptHookModeModern();
testResolvePromptHookModeLegacy();
testResolvePromptHookModeLegacyForUnknownVersion();

console.log("service tests passed");
