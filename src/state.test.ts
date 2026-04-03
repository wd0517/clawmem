import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState } from "./state.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function withTempStateFile(payload: unknown, fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "clawmem-state-"));
  const filePath = path.join(dir, "state.json");
  try {
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    await fn(filePath);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function testMigratesLegacyV2State(): Promise<void> {
  await withTempStateFile({
    version: 2,
    sessions: {
      "main:s-1": {
        sessionId: "s-1",
        agentId: "main",
        issueNumber: 10,
        lastMirroredCount: 6,
        turnCount: 6,
        lastMemorySyncCount: 4,
        summaryStatus: "pending",
        finalizedAt: "2026-04-03T10:00:00.000Z",
      },
    },
  }, async (filePath) => {
    const state = await loadState(filePath);
    const session = state.sessions["main:s-1"];
    assert(state.version === 3, "expected state version 3 after migration");
    assert(Boolean(session), "expected migrated session to exist");
    assert(session?.derived?.digest.cursor === 0, "expected legacy sessions to rebuild digest from cursor 0");
    assert(session?.derived?.digest.status === "pending", "expected digest to become pending after migration");
    assert(session?.derived?.summary.status === "pending", "expected finalized legacy sessions to keep summary pending");
    assert(session?.derived?.memory.appliedCursor === 4, "expected legacy memory sync cursor to migrate into appliedCursor");
    assert(session?.lastMemorySyncCount === 4, "expected compatibility field to mirror appliedCursor");
  });
}

async function testNormalizesRunningTaskStates(): Promise<void> {
  await withTempStateFile({
    version: 3,
    sessions: {
      "main:s-2": {
        sessionId: "s-2",
        agentId: "main",
        lastMirroredCount: 3,
        turnCount: 3,
        derived: {
          digest: { cursor: 1, status: "running", attempt: 2, text: "digest" },
          summary: { basedOnCursor: 0, status: "running" },
          memory: {
            extractCursor: 1,
            appliedCursor: 0,
            extractStatus: "running",
            reconcileStatus: "running",
            attempt: 1,
            pendingCandidates: [
              { candidateId: "abc", detail: "Remember Redis is atomic with Lua." },
            ],
          },
        },
      },
    },
  }, async (filePath) => {
    const state = await loadState(filePath);
    const session = state.sessions["main:s-2"];
    assert(session?.derived?.digest.status === "pending", "expected running digest tasks to normalize to pending on load");
    assert(session?.derived?.summary.status === "pending", "expected running summary tasks to normalize to pending on load");
    assert(session?.derived?.memory.extractStatus === "pending", "expected running memory extract tasks to normalize to pending");
    assert(session?.derived?.memory.reconcileStatus === "pending", "expected running memory reconcile tasks to normalize to pending");
    assert(session?.derived?.memory.pendingCandidates.length === 1, "expected pending candidates to survive state reload");
  });
}

await testMigratesLegacyV2State();
await testNormalizesRunningTaskStates();

console.log("state tests passed");
