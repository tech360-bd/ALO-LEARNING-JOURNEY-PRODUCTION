/**
 * Runtime configuration — "change env / add an API key from the dashboard, no
 * shell, no rebuild, no git".
 *
 * The owner's requirement: once this app is live, adding a setting must not mean
 * SSH-ing into the server and editing code. This module is the storage and the
 * lookup order for that.
 *
 * ── Lookup order (later wins only for unset values, see `runtimeEnv`) ────────
 *   1. `process.env`            — the real environment (PM2/`.env`). Always
 *                                 authoritative: the box's operator set it.
 *   2. the config file          — values saved from the dashboard.
 *
 * A dashboard value can never shadow a real environment variable. That is
 * deliberate: if someone sets `DATABASE_URL` in `.env`, a stale dashboard row
 * must not silently point the app at another database.
 *
 * ── Secrets are encrypted, never stored in the clear ───────────────────────
 * `secret: true` fields are written as AES-256-GCM envelopes from
 * `src/lib/vault.ts` (master key `VAULT_MASTER_KEY`), and only a masked form
 * (`****x7Kq`) is ever persisted in plaintext or returned by an API.
 *
 * ── Why a file and not the database ────────────────────────────────────────
 * The values themselves configure how the app reaches the database, the AI
 * providers and the SMS/email transports. A value that is needed *before* the
 * database is reachable cannot live only in the database — a broken DB would
 * make it impossible to fix the DB. The file is `chmod 0600`, outside `public/`,
 * and excluded from git.
 *
 * ── What takes effect immediately ──────────────────────────────────────────
 * Reads through `runtimeEnv()` (every provider key, base URL, model id, feature
 * switch added below) apply on the next request. Variables that Next.js reads
 * once at boot (`DATABASE_URL` for an already-open pool, `NEXTAUTH_SECRET`) are
 * reported as `restartRequired` so the dashboard can say so instead of lying.
 */

import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/vault";

export type ConfigKind = "string" | "secret" | "url" | "boolean" | "number";

export interface ConfigField {
  /** Environment-variable name, e.g. `GROQ_API_KEY`. */
  name: string;
  label: string;
  kind: ConfigKind;
  group: "AI providers" | "Messaging" | "Storage" | "Security" | "Runtime";
  /** Why it matters and where to get it — shown to the operator. */
  help: string;
  /** Value used when the file has no entry. Never a secret. */
  default?: string;
  /** Changing this needs a process restart to take effect. */
  restartRequired?: boolean;
  /** Provider slug this key belongs to (used to test the key). */
  providerSlug?: string;
}

/**
 * The allowlist. A dashboard request can only touch these names — arbitrary
 * environment injection (e.g. `NODE_OPTIONS=--require …`) is not offered.
 */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  // ── AI providers (free-tier / owner gateways) ────────────────────────────
  { name: "GROQ_API_KEY", label: "Groq API key", kind: "secret", group: "AI providers", providerSlug: "groq",
    help: "Free key from console.groq.com. Used only when both owner switches are on." },
  { name: "GROQ_MODEL", label: "Groq model", kind: "string", group: "AI providers", providerSlug: "groq", default: "llama-3.3-70b-versatile", help: "Model id served by Groq." },
  { name: "LLM7_API_KEY", label: "LLM7 API key", kind: "secret", group: "AI providers", providerSlug: "llm7", help: "Free token from token.llm7.io. \"pro\" models are blocked as paid." },
  { name: "LLM7_MODEL", label: "LLM7 model", kind: "string", group: "AI providers", providerSlug: "llm7", default: "default", help: "Default/fast/free ids only." },
  { name: "OPENCODE_API_KEY", label: "OpenCode Zen key", kind: "secret", group: "AI providers", providerSlug: "opencode", help: "Free models: big-pickle or *-free only." },
  { name: "OPENCODE_MODEL", label: "OpenCode model", kind: "string", group: "AI providers", providerSlug: "opencode", default: "big-pickle", help: "Free model id." },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter key", kind: "secret", group: "AI providers", providerSlug: "openrouter", help: "Free keys work; only :free models are allowed." },
  { name: "OPENROUTER_MODEL", label: "OpenRouter model", kind: "string", group: "AI providers", providerSlug: "openrouter", default: "openrouter/free", help: "Must be openrouter/free or *:free." },
  { name: "OMNIROUTE_BASE_URL", label: "OmniRoute base URL", kind: "url", group: "AI providers", providerSlug: "omniroute", default: "http://127.0.0.1:20128/v1", help: "Your own gateway. Plain http only for loopback/private hosts." },
  { name: "OMNIROUTE_API_KEY", label: "OmniRoute key", kind: "secret", group: "AI providers", providerSlug: "omniroute", help: "Created inside your OmniRoute dashboard." },
  { name: "OMNIROUTE_MODEL", label: "OmniRoute model", kind: "string", group: "AI providers", providerSlug: "omniroute", default: "auto", help: "\"auto\" lets the gateway choose." },
  { name: "LITELLM_BASE_URL", label: "LiteLLM base URL", kind: "url", group: "AI providers", providerSlug: "litellm", default: "http://127.0.0.1:4000/v1", help: "Self-hosted LiteLLM proxy." },
  { name: "LITELLM_API_KEY", label: "LiteLLM key", kind: "secret", group: "AI providers", providerSlug: "litellm", help: "The proxy's own key, if it requires one." },
  { name: "LITELLM_MODEL", label: "LiteLLM model", kind: "string", group: "AI providers", providerSlug: "litellm", help: "Required: the model id to request, e.g. ollama/llama3.2." },
  { name: "LIBRECHAT_BASE_URL", label: "LibreChat base URL", kind: "url", group: "AI providers", providerSlug: "librechat", help: "Required: LibreChat has no default API port." },
  { name: "LIBRECHAT_API_KEY", label: "LibreChat key", kind: "secret", group: "AI providers", providerSlug: "librechat", help: "If your LibreChat exposes an API key." },
  { name: "LIBRECHAT_MODEL", label: "LibreChat model", kind: "string", group: "AI providers", providerSlug: "librechat", help: "Required: the model id to request." },
  // ── Monid (tool marketplace; discover/inspect free, run billed per call) ──
  { name: "ALO_MONID_ENABLED", label: "Monid integration", kind: "boolean", group: "AI providers", default: "false", help: "Off by default. discover/inspect are free; run spends your Monid balance and is always approval-gated." },
  { name: "MONID_API_KEY", label: "Monid API key", kind: "secret", group: "AI providers", providerSlug: "monid", help: "From app.monid.ai/access/api-keys. Stored encrypted; never shown again after saving." },
  { name: "MONID_BASE_URL", label: "Monid base URL", kind: "url", group: "AI providers", providerSlug: "monid", default: "https://api.monid.ai", help: "https only (plain http accepted for loopback only)." },
  { name: "ALO_PAID_AI_API_ALLOWED", label: "Owner switch 1: paid AI allowed", kind: "boolean", group: "AI providers", default: "false", restartRequired: false, help: "Both switches must be true before any external provider is contacted." },
  { name: "ALO_OWNER_APPROVED_PAID_AI_API", label: "Owner switch 2: approval recorded", kind: "boolean", group: "AI providers", default: "false", help: "Deliberately separate from switch 1." },
  { name: "OLLAMA_BASE_URL", label: "Ollama base URL", kind: "url", group: "AI providers", default: "http://127.0.0.1:11434", help: "Local model server. Public/remote hosts are rejected." },
  { name: "OLLAMA_MODEL", label: "Ollama model", kind: "string", group: "AI providers", default: "qwen2.5:7b", help: "A Bengali-capable instruction model." },

  // ── Messaging ───────────────────────────────────────────────────────────
  { name: "SMTP_HOST", label: "SMTP host", kind: "string", group: "Messaging", help: "Outbound email host." },
  { name: "SMTP_PORT", label: "SMTP port", kind: "number", group: "Messaging", default: "465", help: "Usually 465 (TLS) or 587." },
  { name: "SMTP_USER", label: "SMTP user", kind: "string", group: "Messaging", help: "Usually the mailbox address." },
  { name: "SMTP_PASS", label: "SMTP password", kind: "secret", group: "Messaging", help: "App password, not the mailbox password." },
  { name: "SMTP_FROM", label: "From address", kind: "string", group: "Messaging", help: "e.g. ALO <info@learn.alolabs.net>" },
  { name: "HTTPSMS_API_KEY", label: "HTTPSMS key", kind: "secret", group: "Messaging", help: "Only needed if SMS/OTP is enabled. OTP is off when ADMIN_OTP_REQUIRED=false." },

  // ── Storage ─────────────────────────────────────────────────────────────
  { name: "ALO_MEDIA_DIR", label: "Media directory", kind: "string", group: "Storage", restartRequired: true, help: "Where generated audio/video is written. Defaults to ./storage." },

  // ── Security / runtime ──────────────────────────────────────────────────
  { name: "ADMIN_EMAIL", label: "Administrator email", kind: "string", group: "Security", restartRequired: true, help: "The single owner account." },
  { name: "ADMIN_OTP_REQUIRED", label: "Require SMS OTP at login", kind: "boolean", group: "Security", default: "false", restartRequired: true, help: "false = password-only sign-in (owner decision)." },
  { name: "ADMIN_PASSWORD_HASH", label: "Administrator password hash", kind: "secret", group: "Security", restartRequired: true, help: "Generate with scripts/hash-admin-password.mjs. Stored encrypted." },
  { name: "DATABASE_URL", label: "MySQL connection URL", kind: "secret", group: "Runtime", restartRequired: true, help: "mysql://user:pass@host:3306/db — changing it needs a restart." },
  { name: "NEXTAUTH_SECRET", label: "Session signing secret", kind: "secret", group: "Runtime", restartRequired: true, help: "Changing it signs every admin out." },
  { name: "VAULT_MASTER_KEY", label: "Vault master key", kind: "secret", group: "Runtime", restartRequired: true, help: "32-byte base64. Rotating it requires re-encrypting stored secrets." },
];

const FIELD_BY_NAME = new Map(CONFIG_FIELDS.map((f) => [f.name, f]));

export function getField(name: string): ConfigField | undefined {
  return FIELD_BY_NAME.get(name);
}

/** Every allowlisted name, for validation and for the dashboard. */
export function configFieldNames(): string[] {
  return CONFIG_FIELDS.map((f) => f.name);
}

// ─── Storage ────────────────────────────────────────────────────────────────

/** Path of the config file. Overridable so tests never touch a real one. */
export function runtimeConfigPath(): string {
  const explicit = process.env.ALO_RUNTIME_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), ".alo-runtime-config.json");
}

interface StoredValue {
  /** Plain value for non-secrets; absent for secrets. */
  value?: string;
  /** Vault envelope (AES-256-GCM) for secrets. */
  cipher?: string;
  /** `****x7Kq` — what the dashboard may display. */
  masked?: string;
  updatedAt: string;
  updatedBy?: string;
}

interface ConfigFile {
  version: 1;
  values: Record<string, StoredValue>;
}

async function readFile(): Promise<ConfigFile> {
  try {
    const raw = await fs.readFile(runtimeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as ConfigFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.values !== "object") {
      return { version: 1, values: {} };
    }
    return { version: 1, values: parsed.values ?? {} };
  } catch {
    // Missing or unreadable file = nothing configured here. Never throw: this is
    // read on the request path.
    return { version: 1, values: {} };
  }
}

async function writeFile(config: ConfigFile): Promise<void> {
  const target = runtimeConfigPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a truncated config that
  // makes every later read fail.
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

/**
 * Resolves a configured value, decrypting a secret. Returns `undefined` when the
 * file has no usable entry (including a secret that cannot be decrypted with the
 * current master key — dropped rather than crashing the app).
 */
export function resolveValue(name: string, stored: StoredValue | undefined): string | undefined {
  if (!stored) return undefined;
  if (typeof stored.cipher === "string" && stored.cipher.length > 0) {
    try {
      return decryptSecret(stored.cipher);
    } catch {
      return undefined;
    }
  }
  if (typeof stored.value === "string") return stored.value;
  return undefined;
}

// ─── Lookup ─────────────────────────────────────────────────────────────────

/**
 * Reads an environment variable with the dashboard value as a fallback.
 *
 * Prefer this over `process.env.X` in code that should honour dashboard config.
 * A real environment value always wins (see the file header).
 */
export async function runtimeEnv(name: string): Promise<string | undefined> {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  const file = await readFile();
  return resolveValue(name, file.values[name]);
}

/** Synchronous variant for call sites that cannot await; file-cache only. */
let cache: { file: ConfigFile; loadedAt: number } | null = null;
let cacheTtlMs = 2000;

/** Test hook: forget the cached file so a write is visible immediately. */
export function _resetConfigCache(): void {
  cache = null;
}

export function _setConfigCacheTtl(ms: number): void {
  cacheTtlMs = ms;
  cache = null;
}

async function readCached(): Promise<ConfigFile> {
  if (cache && Date.now() - cache.loadedAt < cacheTtlMs) return cache.file;
  const file = await readFile();
  cache = { file, loadedAt: Date.now() };
  return file;
}

/**
 * Synchronous best-effort read for modules deep in the call stack.
 *
 * Uses the cached file (max 2 s stale) and returns `undefined` when nothing is
 * cached yet — callers must handle `undefined` exactly as they handle "not set".
 * Async callers should use `runtimeEnv`.
 */
export function runtimeEnvSync(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  if (!cache) {
    // A route that never saw the async path would otherwise silently ignore
    // every dashboard value — which is how the first live check of the owner
    // switches failed. The file is small, so a cold read is the cheap choice.
    const loaded = readFileSyncCached();
    if (!loaded) return undefined;
  }
  return resolveValue(name, cache!.file.values[name]);
}

/**
 * Synchronous file read for the cold-cache case, memoised like the async path.
 * Any unreadable/again-invalid file is treated as "nothing configured".
 */
function readFileSyncCached(): boolean {
  try {
    const raw = readFileSync(runtimeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as ConfigFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.values !== "object") {
      cache = { file: { version: 1, values: {} }, loadedAt: Date.now() };
      return true;
    }
    cache = { file: { version: 1, values: parsed.values ?? {} }, loadedAt: Date.now() };
    return true;
  } catch {
    cache = { file: { version: 1, values: {} }, loadedAt: Date.now() };
    return true;
  }
}

/** Warms the cache; called once from the dashboard routes and health checks. */
export async function primeRuntimeConfig(): Promise<void> {
  await readCached();
}

// ─── Writes (dashboard only) ────────────────────────────────────────────────

export interface SetResult {
  name: string;
  ok: boolean;
  /** True when the change needs `pm2 restart` to take effect. */
  restartRequired: boolean;
  masked?: string;
  error?: string;
}

function validate(field: ConfigField, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null; // clear
  if (value.length > 4000) return "value too long (max 4000 characters)";
  if (field.kind === "boolean" && !["true", "false"].includes(value.toLowerCase())) {
    return "must be true or false";
  }
  if (field.kind === "number" && !/^\d{1,6}$/.test(value)) return "must be a number";
  if (field.kind === "url") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return "must be http or https";
    } catch {
      return "must be a valid URL";
    }
  }
  // A secret that looks like an unexpanded placeholder would silently register as
  // configured and fail at the provider. Reject it with a clear message.
  if (field.kind === "secret" && /^(REPLACE|CHANGEME|placeholder|xxx)/i.test(value)) {
    return "this looks like a placeholder, not a real value";
  }
  return null;
}

/**
 * Sets (or clears, with `null`/`""`) one allowlisted value. The plaintext is
 * encrypted before it is written and never returned.
 */
export async function setRuntimeValue(
  name: string,
  value: string | null,
  options: { updatedBy?: string } = {}
): Promise<SetResult> {
  const field = getField(name);
  if (!field) {
    return { name, ok: false, restartRequired: false, error: "not an allowlisted setting" };
  }
  const raw = value ?? "";
  const problem = validate(field, raw);
  if (problem) return { name, ok: false, restartRequired: Boolean(field.restartRequired), error: problem };

  const config = await readFile();
  if (raw.trim() === "") {
    delete config.values[name];
  } else {
    const trimmed = raw.trim();
    const entry: StoredValue = { updatedAt: new Date().toISOString(), updatedBy: options.updatedBy };
    if (field.kind === "secret") {
      try {
        const envelope = encryptSecret(trimmed);
        entry.cipher = envelope.ciphertext;
        entry.masked = maskSecret(trimmed);
      } catch (error) {
        return {
          name,
          ok: false,
          restartRequired: Boolean(field.restartRequired),
          error: `cannot encrypt: ${(error as Error)?.message ?? error} — set VAULT_MASTER_KEY first`,
        };
      }
    } else {
      entry.value = field.kind === "boolean" ? trimmed.toLowerCase() : trimmed;
    }
    config.values[name] = entry;
  }
  try {
    await writeFile(config);
  } catch (error) {
    return {
      name,
      ok: false,
      restartRequired: Boolean(field.restartRequired),
      error: `could not write ${path.basename(runtimeConfigPath())}: ${(error as Error)?.message ?? error}`,
    };
  }
  cache = null;
  return {
    name,
    ok: true,
    restartRequired: Boolean(field.restartRequired),
    masked: config.values[name]?.masked,
  };
}

export interface ConfigView {
  name: string;
  label: string;
  kind: ConfigKind;
  group: ConfigField["group"];
  help: string;
  restartRequired: boolean;
  providerSlug?: string;
  /** Where the effective value comes from. */
  source: "environment" | "dashboard" | "default" | "unset";
  /** Masked for secrets; the real value for a non-secret. */
  display: string;
  updatedAt?: string;
}

/**
 * The dashboard view. Secrets are shown only as `****abcd`; a secret that came
 * from the environment is shown as `(set in environment)` with no hint of its
 * length or content.
 */
export async function listRuntimeConfig(): Promise<ConfigView[]> {
  const config = await readCached();
  return CONFIG_FIELDS.map((field) => {
    const fromProcess = process.env[field.name];
    const stored = config.values[field.name];
    const isSecret = field.kind === "secret";
    if (typeof fromProcess === "string" && fromProcess.length > 0) {
      return {
        ...baseView(field),
        source: "environment" as const,
        display: isSecret ? "(set in environment)" : fromProcess,
      };
    }
    const resolved = resolveValue(field.name, stored);
    if (resolved !== undefined && resolved !== "") {
      return {
        ...baseView(field),
        source: "dashboard" as const,
        display: isSecret ? stored?.masked ?? maskSecret(resolved) : resolved,
        updatedAt: stored?.updatedAt,
      };
    }
    if (field.default !== undefined) {
      return { ...baseView(field), source: "default" as const, display: field.default };
    }
    return { ...baseView(field), source: "unset" as const, display: "" };
  });
}

function baseView(field: ConfigField) {
  return {
    name: field.name,
    label: field.label,
    kind: field.kind,
    group: field.group,
    help: field.help,
    restartRequired: Boolean(field.restartRequired),
    providerSlug: field.providerSlug,
  };
}
