import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1).split("#")[0] };
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// No shell or arbitrary code is exposed by this profile. Calculations and imports
// remain operator-run deterministic commands outside the research process.
async function restrictedOpenCodePolicy(raw: unknown, cwd: unknown): Promise<Record<string, unknown>> {
  if (raw !== undefined && !isPlainObject(raw)) throw new Error("toolPolicy must be an object");
  const policy = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(policy).some((key) => !["readRoots", "writeRoot", "webOrigins"].includes(key))) {
    throw new Error("Unknown toolPolicy field");
  }
  const directories = async (value: unknown): Promise<string[]> => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((p) => typeof p !== "string" || !path.isAbsolute(p) || /[*?]/.test(p))) {
      throw new Error("toolPolicy directories must be existing absolute paths without wildcards");
    }
    return Promise.all(value.map(async (p: string) => {
      const real = await fs.realpath(p);
      if (real === path.parse(real).root || !(await fs.stat(real)).isDirectory()) throw new Error("Unsafe toolPolicy directory");
      const inspect = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error("toolPolicy roots must not contain symbolic links");
          if (entry.isDirectory()) await inspect(path.join(dir, entry.name));
        }
      };
      await inspect(real);
      return real;
    }));
  };
  const reads = await directories(policy.readRoots);
  const writes = await directories(policy.writeRoot === undefined ? undefined : [policy.writeRoot]);
  const origins = policy.webOrigins ?? [];
  if (!Array.isArray(origins) || origins.some((s) => {
    if (typeof s !== "string") return true;
    try {
      const u = new URL(s);
      return u.protocol !== "https:" || u.origin !== s || /[*?]/.test(s) || Boolean(u.username || u.password);
    } catch { return true; }
  })) throw new Error("toolPolicy webOrigins must be exact HTTPS origins");
  const rules: Array<{ action: string; resource: string; effect: string }> = [{ action: "*", resource: "*", effect: "deny" }];
  const resourceBases: string[] = [];
  if (typeof cwd === "string" && path.isAbsolute(cwd)) {
    resourceBases.push(await fs.realpath(cwd).catch(() => path.resolve(cwd)));
    let ancestor = resourceBases[0];
    while (ancestor !== path.dirname(ancestor)) {
      if (await fs.stat(path.join(ancestor, ".git")).then(() => true, () => false)) {
        resourceBases.push(ancestor);
        break;
      }
      ancestor = path.dirname(ancestor);
    }
  }
  const relative = (dir: string): string[] => {
    // Never add '../*': that would cover unrelated siblings in a git worktree.
    return [...new Set(resourceBases.flatMap((base) => {
      const rel = path.relative(base, dir);
      return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) ? [rel, `${rel}/*`] : [];
    }))];
  };
  for (const dir of [...new Set([...reads, ...writes])]) {
    rules.push({ action: "external_directory", resource: `${dir}/*`, effect: "allow" });
    rules.push({ action: "read", resource: dir, effect: "allow" });
    rules.push({ action: "read", resource: `${dir}/*`, effect: "allow" });
    for (const resource of relative(dir)) rules.push({ action: "read", resource, effect: "allow" });
  }
  for (const dir of writes) {
    rules.push({ action: "edit", resource: dir, effect: "allow" });
    rules.push({ action: "edit", resource: `${dir}/*`, effect: "allow" });
    for (const resource of relative(dir)) rules.push({ action: "edit", resource, effect: "allow" });
  }
  for (const origin of origins as string[]) rules.push({ action: "webfetch", resource: `${origin}/*`, effect: "allow" });
  const hardRules = rules.map((r) => ({ action: "tool.use", resource: `${r.action}:${r.resource}`, effect: r.effect }));
  // Explicit deny-all must be '*', not '*:*', for future permission action shapes.
  hardRules[0].resource = "*";
  return {
    permissions: rules,
    policies: hardRules,
    // Also disable inherited MCP/plugin/agent configuration: never copy the host
    // config directory into a restricted run.
    agents: { research: { description: "Assignment-scoped research", mode: "primary", permissions: rules } },
    default_agent: "research",
    mcp: {},
  };
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, false);
  if (skipPermissions && input.config.toolPolicy !== undefined) {
    throw new Error("toolPolicy cannot be combined with dangerouslySkipPermissions");
  }
  const restricted = !skipPermissions;
  const policy = restricted ? await restrictedOpenCodePolicy(input.config.toolPolicy, input.config.cwd) : null;

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    if (restricted) throw new Error("Restricted OpenCode toolPolicy requires a local execution target");
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    if (!restricted) {
      await fs.cp(sourceConfigDir, runtimeConfigDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        dereference: false,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const notes = [restricted
    ? "Injected isolated OpenCode config with explicit default-deny tool policy."
    : "Injected runtime OpenCode config with permission=allow for all tools and connections."];

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    ...(policy ?? { permission: "allow" }),
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}

/** Managed credentials must never leave host-only homes in a remote process. */
export function prepareManagedOpenCodeRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
}): void {
  if (!input.config.managedAiConnection) return;
  if (!input.runtimeRootDir) throw new Error("Managed OpenCode authentication requires an isolated remote runtime directory.");
  const home = path.posix.join(input.runtimeRootDir, "managed-auth", input.runId);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
}
