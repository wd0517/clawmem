export type OpenClawPluginApi = {
  id?: string;
  pluginConfig?: unknown;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  runtime: {
    version?: string;
    config?: {
      path?: string;
      account?: { id?: string };
      loadConfig?: () => any;
      writeConfigFile?: (config: any) => Promise<void>;
    };
    events: {
      onSessionTranscriptUpdate: (handler: (update: { sessionFile: string }) => void) => () => void;
    };
    state?: {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
      resolveStateDir?: () => string;
    };
    subagent: {
      run: (input: Record<string, unknown>) => Promise<{ runId: string }>;
      waitForRun: (input: Record<string, unknown>) => Promise<{ status: string; error?: string }>;
      getSessionMessages: (input: Record<string, unknown>) => Promise<{ messages: unknown[] }>;
      deleteSession: (input: Record<string, unknown>) => Promise<void>;
    };
  };
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  registerTool: (tool: Record<string, unknown>) => void;
  registerService: (service: Record<string, unknown>) => void;
};
