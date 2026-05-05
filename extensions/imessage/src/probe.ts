import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { detectBinary } from "openclaw/plugin-sdk/setup";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { createIMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

// Re-export for backwards compatibility
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

export type IMessageProbe = BaseProbeResult & {
  fatal?: boolean;
  privateApi?: {
    available: boolean;
    v2Ready: boolean;
    selectors: Record<string, boolean>;
    error?: string;
  };
};

export type IMessageProbeOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
};

type RpcSupportResult = {
  supported: boolean;
  error?: string;
  fatal?: boolean;
};

const rpcSupportCache = new Map<string, RpcSupportResult>();
const bridgeStatusCache = new Map<string, IMessageProbe["privateApi"]>();

async function probeRpcSupport(cliPath: string, timeoutMs: number): Promise<RpcSupportResult> {
  const cached = rpcSupportCache.get(cliPath);
  if (cached) {
    return cached;
  }
  try {
    const result = await runCommandWithTimeout([cliPath, "rpc", "--help"], { timeoutMs });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const normalized = normalizeLowercaseStringOrEmpty(combined);
    if (normalized.includes("unknown command") && normalized.includes("rpc")) {
      const fatal = {
        supported: false,
        fatal: true,
        error: 'imsg CLI does not support the "rpc" subcommand (update imsg)',
      };
      rpcSupportCache.set(cliPath, fatal);
      return fatal;
    }
    if (result.code === 0) {
      const supported = { supported: true };
      rpcSupportCache.set(cliPath, supported);
      return supported;
    }
    return {
      supported: false,
      error: combined || `imsg rpc --help failed (code ${String(result.code ?? "unknown")})`,
    };
  } catch (err) {
    return { supported: false, error: String(err) };
  }
}

function parseStatusPayload(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.toReversed()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Continue scanning earlier JSONL records.
    }
  }
  return null;
}

function selectorsFromPayload(payload: Record<string, unknown>): Record<string, boolean> {
  const raw = payload.selectors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const selectors: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") {
      selectors[key] = value;
    }
  }
  return selectors;
}

export function getCachedIMessagePrivateApiStatus(
  accountIdOrCliPath?: string | null,
): IMessageProbe["privateApi"] | undefined {
  const key = accountIdOrCliPath?.trim() || "imsg";
  return bridgeStatusCache.get(key);
}

export async function probeIMessagePrivateApi(
  cliPath: string,
  timeoutMs: number,
): Promise<NonNullable<IMessageProbe["privateApi"]>> {
  const key = cliPath.trim() || "imsg";
  const cached = bridgeStatusCache.get(key);
  if (cached) {
    return cached;
  }
  try {
    const result = await runCommandWithTimeout([key, "status", "--json"], { timeoutMs });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const payload = parseStatusPayload(result.stdout);
    const selectors = payload ? selectorsFromPayload(payload) : {};
    const advancedFeatures = payload?.advanced_features === true;
    const v2Ready = payload?.v2_ready === true;
    const status = {
      available: result.code === 0 && advancedFeatures && v2Ready,
      v2Ready,
      selectors,
      ...(result.code === 0
        ? {}
        : { error: combined || `imsg status --json failed (code ${String(result.code)})` }),
    };
    bridgeStatusCache.set(key, status);
    return status;
  } catch (err) {
    const status = {
      available: false,
      v2Ready: false,
      selectors: {},
      error: String(err),
    };
    bridgeStatusCache.set(key, status);
    return status;
  }
}

/**
 * Probe iMessage RPC availability.
 * @param timeoutMs - Explicit timeout in ms. If undefined, uses config or default.
 * @param opts - Additional options (cliPath, dbPath, runtime).
 */
export async function probeIMessage(
  timeoutMs?: number,
  opts: IMessageProbeOptions = {},
): Promise<IMessageProbe> {
  const cfg = opts.cliPath || opts.dbPath ? undefined : getRuntimeConfig();
  const cliPath = opts.cliPath?.trim() || cfg?.channels?.imessage?.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || cfg?.channels?.imessage?.dbPath?.trim();
  // Use explicit timeout if provided, otherwise fall back to config, then default
  const effectiveTimeout =
    timeoutMs ?? cfg?.channels?.imessage?.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

  const detected = await detectBinary(cliPath);
  if (!detected) {
    return { ok: false, error: `imsg not found (${cliPath})` };
  }

  const rpcSupport = await probeRpcSupport(cliPath, effectiveTimeout);
  if (!rpcSupport.supported) {
    return {
      ok: false,
      error: rpcSupport.error ?? "imsg rpc unavailable",
      fatal: rpcSupport.fatal,
    };
  }

  const privateApi = await probeIMessagePrivateApi(cliPath, effectiveTimeout);

  const client = await createIMessageRpcClient({
    cliPath,
    dbPath,
    runtime: opts.runtime,
  });
  try {
    await client.request("chats.list", { limit: 1 }, { timeoutMs: effectiveTimeout });
    return { ok: true, privateApi };
  } catch (err) {
    return { ok: false, error: String(err), privateApi };
  } finally {
    await client.stop();
  }
}
