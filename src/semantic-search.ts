import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ClawMemPluginConfig, ParsedMemoryIssue } from "./types.js";
import { sha256 } from "./utils.js";

export interface MemorySemanticProvider {
  score(query: string, memories: ParsedMemoryIssue[]): Promise<Map<number, number>>;
}

type EmbeddingResponse = {
  data?: Array<{ embedding?: unknown }>;
};

const embeddingCache = new Map<string, number[]>();

export function createSemanticProvider(api: OpenClawPluginApi, config: ClawMemPluginConfig): MemorySemanticProvider | undefined {
  if (!config.embeddingsApiKey || !config.embeddingsModel) return undefined;
  return new OpenAICompatibleSemanticProvider(api, config);
}

class OpenAICompatibleSemanticProvider implements MemorySemanticProvider {
  constructor(private readonly api: OpenClawPluginApi, private readonly config: ClawMemPluginConfig) {}

  async score(query: string, memories: ParsedMemoryIssue[]): Promise<Map<number, number>> {
    const candidates = memories
      .slice()
      .sort((a, b) => b.issueNumber - a.issueNumber)
      .slice(0, this.config.semanticSearchMaxCandidates);
    if (candidates.length === 0) return new Map();
    const queryVector = await this.embedQuery(query);
    const texts = candidates.map(buildSemanticText);
    const vectors = await this.embedTexts(texts);
    const scores = new Map<number, number>();
    for (let i = 0; i < candidates.length; i++) {
      const memory = candidates[i];
      const vector = vectors[i];
      if (!memory || !vector) continue;
      scores.set(memory.issueNumber, cosineSimilarity(queryVector, vector));
    }
    return scores;
  }

  private async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.requestEmbeddings([query]);
    if (!vector) throw new Error("embedding provider returned no query embedding");
    return vector;
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const missing = new Map<string, string>();
    const out = new Array<number[]>(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? "";
      const key = this.cacheKey(text);
      const cached = embeddingCache.get(key);
      if (cached) {
        out[i] = cached;
      } else {
        missing.set(key, text);
      }
    }
    if (missing.size > 0) {
      const entries = [...missing.entries()];
      for (let i = 0; i < entries.length; i += this.config.semanticSearchBatchSize) {
        const batch = entries.slice(i, i + this.config.semanticSearchBatchSize);
        const batchKeys = batch.map(([key]) => key);
        const batchTexts = batch.map(([, text]) => text);
        const vectors = await this.resolveBatch(batchKeys, batchTexts);
        for (let j = 0; j < batchKeys.length; j++) {
          const key = batchKeys[j];
          const vector = vectors[j];
          if (!key || !vector) continue;
          embeddingCache.set(key, vector);
        }
      }
    }
    for (let i = 0; i < texts.length; i++) {
      const key = this.cacheKey(texts[i] ?? "");
      const vector = embeddingCache.get(key);
      if (!vector) throw new Error(`missing embedding cache entry for text ${i + 1}`);
      out[i] = vector;
    }
    return out;
  }

  private async resolveBatch(keys: string[], texts: string[]): Promise<number[][]> {
    const out = new Array<number[]>(keys.length);
    const missing: Array<{ key: string; text: string; index: number }> = [];
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const cached = embeddingCache.get(key);
      if (cached) {
        out[index] = cached;
        continue;
      }
      missing.push({ key, text: texts[index] ?? "", index });
    }
    if (missing.length > 0) {
      const vectors = await this.requestEmbeddings(missing.map((entry) => entry.text));
      for (let i = 0; i < missing.length; i++) {
        const entry = missing[i];
        const vector = vectors[i];
        if (!entry || !vector) continue;
        embeddingCache.set(entry.key, vector);
        out[entry.index] = vector;
      }
    }
    return out;
  }

  private async requestEmbeddings(input: string[]): Promise<number[][]> {
    const endpoint = `${this.config.embeddingsBaseUrl ?? "https://api.openai.com/v1"}/embeddings`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `${this.config.embeddingsAuthScheme === "token" ? "Token" : "Bearer"} ${this.config.embeddingsApiKey}`,
    };
    const body: Record<string, unknown> = {
      model: this.config.embeddingsModel,
      input,
    };
    if (this.config.embeddingsDimensions) body.dimensions = this.config.embeddingsDimensions;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`embedding request failed (${response.status}): ${text || response.statusText}`);
    }
    const json = await response.json() as EmbeddingResponse;
    const vectors = (json.data ?? []).map((item) => Array.isArray(item?.embedding) ? item.embedding.filter((value): value is number => typeof value === "number") : []);
    if (vectors.length !== input.length || vectors.some((vector) => vector.length === 0)) {
      throw new Error("embedding provider returned malformed vectors");
    }
    this.api.logger.info?.(`clawmem: embedded ${input.length} text item(s) with ${this.config.embeddingsModel}`);
    return vectors;
  }

  private cacheKey(text: string): string {
    return sha256([
      this.config.embeddingsBaseUrl ?? "https://api.openai.com/v1",
      this.config.embeddingsModel ?? "",
      String(this.config.embeddingsDimensions ?? ""),
      text,
    ].join("\n"));
  }
}

function buildSemanticText(memory: ParsedMemoryIssue): string {
  return [
    memory.title,
    memory.kind ? `kind ${memory.kind}` : "",
    memory.topics && memory.topics.length > 0 ? `topics ${memory.topics.join(" ")}` : "",
    memory.detail,
  ].filter(Boolean).join("\n");
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
