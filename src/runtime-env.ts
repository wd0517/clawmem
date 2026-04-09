export function getOpenClawAgentIdFromEnv(): string | undefined {
  const value = process.env.OPENCLAW_AGENT_ID;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getOpenClawHostVersionFromEnv(): string | undefined {
  for (const candidate of [process.env.OPENCLAW_VERSION, process.env.OPENCLAW_SERVICE_VERSION]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
