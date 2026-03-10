export function stringifyFlatYaml(
  entries: Array<[key: string, value: string | undefined]>,
): string {
  const out: string[] = [];
  for (const [key, rawValue] of entries) {
    const value = rawValue ?? "";
    if (value.includes("\n")) {
      out.push(`${key}: |-`);
      for (const line of value.split("\n")) {
        out.push(`  ${line}`);
      }
      continue;
    }
    out.push(`${key}: ${formatScalar(value)}`);
  }
  return out.join("\n");
}

export function parseFlatYaml(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = input.replace(/\r/g, "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      continue;
    }
    const match = /^([A-Za-z0-9_]+):(?:\s(.*))?$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2] ?? "";
    if (rawValue === "|-" || rawValue === "|") {
      const block: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const blockLine = lines[cursor] ?? "";
        if (blockLine.startsWith("  ")) {
          block.push(blockLine.slice(2));
          cursor += 1;
          continue;
        }
        if (!blockLine.trim()) {
          block.push("");
          cursor += 1;
          continue;
        }
        break;
      }
      result[key] = block.join("\n");
      index = cursor - 1;
      continue;
    }
    result[key] = parseScalar(rawValue.trim());
  }

  return result;
}

function formatScalar(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@ -]+$/.test(value) && !looksLikeYamlKeyword(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function parseScalar(value: string): string {
  if (!value) {
    return "";
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function looksLikeYamlKeyword(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return lowered === "null" || lowered === "true" || lowered === "false" || lowered === "~";
}
