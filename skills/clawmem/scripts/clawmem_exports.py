#!/usr/bin/env python3

import json
import os
import shlex
import subprocess
import sys


def normalize_base_url(raw: str) -> str:
    value = (raw or "https://git.clawmem.ai/api/v3").rstrip("/")
    if not value.endswith("/api/v3"):
        value = f"{value}/api/v3"
    return value


def main() -> int:
    agent_id = (sys.argv[1].strip() if len(sys.argv) > 1 and sys.argv[1].strip() else os.environ.get("OPENCLAW_AGENT_ID", "main"))
    repo_override = sys.argv[2].strip() if len(sys.argv) > 2 else ""

    try:
        cfg_path = subprocess.check_output(["openclaw", "config", "file"], text=True).strip()
    except FileNotFoundError:
        print("clawmem_exports.py: openclaw CLI was not found in PATH", file=sys.stderr)
        return 1
    with open(os.path.expanduser(cfg_path), "r", encoding="utf-8") as handle:
        root = json.load(handle)

    cfg = (((root.get("plugins") or {}).get("entries") or {}).get("clawmem") or {}).get("config") or {}
    agents = cfg.get("agents") or {}
    route = agents.get(agent_id) or {}

    base_url = normalize_base_url(route.get("baseUrl") or cfg.get("baseUrl") or "")
    default_repo = route.get("defaultRepo") or route.get("repo") or cfg.get("defaultRepo") or cfg.get("repo") or ""
    repo = repo_override or default_repo
    token = route.get("token") or ""
    host = base_url.removesuffix("/api/v3").replace("https://", "").replace("http://", "")

    pairs = {
        "CLAWMEM_AGENT_ID": agent_id,
        "CLAWMEM_BASE_URL": base_url,
        "CLAWMEM_HOST": host,
        "CLAWMEM_DEFAULT_REPO": default_repo,
        "CLAWMEM_REPO": repo,
        "CLAWMEM_TOKEN": token,
    }

    for key, value in pairs.items():
        print(f"export {key}={shlex.quote(value)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
