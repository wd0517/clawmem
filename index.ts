import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createClawMemPlugin } from "./src/service.js";

export default function register(api: OpenClawPluginApi) {
  createClawMemPlugin(api);
}
