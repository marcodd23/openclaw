import { parseConfigJson5, readConfigFileSnapshot } from "../config/config.js";

/**
 * Top-level config keys that tenants are allowed to modify in ClawDeck
 * hosted mode. Whitelist approach: any key NOT in this set is treated as
 * infrastructure-managed — its current on-disk value is preserved on
 * config.set, and it's stripped from config.patch payloads.
 */
export const HOSTED_MODE_ALLOWED_CONFIG_KEYS = new Set([
  "agents",
  "messages",
  "commands",
  "hooks",
  "skills",
  "tools",
  "session",
  "cron",
  "audio",
  "talk",
  "broadcast",
  "ui",
  "models",
]);

/**
 * Sub-key overrides forced in hosted mode. These are within allowed
 * top-level sections but pose security risks (shell access, config/debug
 * bypass). Values here are force-applied after sanitization, overriding
 * whatever the tenant sent.
 */
export const HOSTED_MODE_FORCED_SUBKEYS: Record<string, Record<string, unknown>> = {
  commands: {
    bash: false,
    config: false,
    debug: false,
  },
};

/**
 * Deeply nested config paths forced in hosted mode. These are within allowed
 * sections but control sandbox Docker/Browser settings that could be used
 * to escape container isolation (mount host paths, change network mode).
 * Applied after sub-key forcing to enforce deep path constraints.
 */
export const HOSTED_MODE_FORCED_DEEP_PATHS: Record<string, unknown> = {
  "agents.defaults.sandbox.docker.network": "none",
  "agents.defaults.sandbox.docker.readOnlyRoot": true,
};

/**
 * Apply forced deep path values to a parsed config object.
 * Walks each dot-separated path and sets the leaf value. Skips gracefully
 * if any intermediate object in the path doesn't exist (the user hasn't
 * configured that section at all, so there's nothing to force).
 */
function applyForcedDeepPaths(config: Record<string, unknown>): void {
  for (const [dotPath, value] of Object.entries(HOSTED_MODE_FORCED_DEEP_PATHS)) {
    const parts = dotPath.split(".");
    let obj: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = obj[parts[i]];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        obj = undefined!;
        break;
      }
      obj = next as Record<string, unknown>;
    }
    if (obj) {
      obj[parts[parts.length - 1]] = value;
    }
  }
}

/** Apply forced sub-key values to a parsed config object. */
function applyForcedSubkeys(config: Record<string, unknown>): void {
  for (const [section, overrides] of Object.entries(HOSTED_MODE_FORCED_SUBKEYS)) {
    const sectionVal = config[section];
    if (sectionVal && typeof sectionVal === "object" && !Array.isArray(sectionVal)) {
      Object.assign(sectionVal, overrides);
    } else if (config[section] !== undefined) {
      // Section exists but isn't an object — overwrite with just the forced keys.
      config[section] = { ...overrides };
    }
    // If section doesn't exist at all, nothing to force.
  }
}

/**
 * Sanitize config.set params for hosted mode: for each key NOT in the
 * allowed set, replace the incoming value with the current on-disk value
 * (or delete the key if it doesn't exist in the current config). This
 * ensures the full config write preserves platform-managed settings even
 * if a crafted request tries to override them.
 *
 * @returns true if sanitization was applied, false if params were invalid.
 */
export async function sanitizeConfigSetForHostedMode(
  params: Record<string, unknown>,
): Promise<boolean> {
  const raw = params.raw;
  if (typeof raw !== "string") {
    return false;
  }
  const parsed = parseConfigJson5(raw);
  if (
    !parsed.ok ||
    !parsed.parsed ||
    typeof parsed.parsed !== "object" ||
    Array.isArray(parsed.parsed)
  ) {
    return false;
  }
  const snapshot = await readConfigFileSnapshot();
  const current = (snapshot.config ?? {}) as Record<string, unknown>;
  const incoming = parsed.parsed as Record<string, unknown>;

  // Restore all non-allowed keys from the current config snapshot.
  const allKeys = new Set([...Object.keys(incoming), ...Object.keys(current)]);
  for (const key of allKeys) {
    if (HOSTED_MODE_ALLOWED_CONFIG_KEYS.has(key)) {
      continue;
    }
    if (key in current) {
      incoming[key] = current[key];
    } else {
      delete incoming[key];
    }
  }

  // Force-lock security-sensitive sub-keys within allowed sections.
  applyForcedSubkeys(incoming);
  // Force-lock deeply nested sandbox settings (Docker network, readOnlyRoot).
  applyForcedDeepPaths(incoming);

  params.raw = JSON.stringify(incoming, null, 2);
  return true;
}

/**
 * Sanitize config.patch params for hosted mode: strip any keys that are
 * NOT in the allowed set from the patch object. Since patches are merged
 * into the existing config, simply removing non-allowed keys from the
 * patch preserves the current on-disk values.
 *
 * @returns true if sanitization was applied, false if params were invalid.
 */
export function sanitizeConfigPatchForHostedMode(params: Record<string, unknown>): boolean {
  const raw = params.raw;
  if (typeof raw !== "string") {
    return false;
  }
  const parsed = parseConfigJson5(raw);
  if (
    !parsed.ok ||
    !parsed.parsed ||
    typeof parsed.parsed !== "object" ||
    Array.isArray(parsed.parsed)
  ) {
    return false;
  }
  const incoming = parsed.parsed as Record<string, unknown>;

  for (const key of Object.keys(incoming)) {
    if (!HOSTED_MODE_ALLOWED_CONFIG_KEYS.has(key)) {
      delete incoming[key];
    }
  }

  // Force-lock security-sensitive sub-keys within allowed sections.
  applyForcedSubkeys(incoming);
  // Force-lock deeply nested sandbox settings (Docker network, readOnlyRoot).
  applyForcedDeepPaths(incoming);

  params.raw = JSON.stringify(incoming, null, 2);
  return true;
}
