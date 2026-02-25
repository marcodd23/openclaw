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

  params.raw = JSON.stringify(incoming, null, 2);
  return true;
}
