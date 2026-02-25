import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_MODE_ALLOWED_CONFIG_KEYS,
  sanitizeConfigPatchForHostedMode,
  sanitizeConfigSetForHostedMode,
} from "./hosted-mode-config-guard.js";

/**
 * Mock the config module — readConfigFileSnapshot reads from disk which
 * we don't want in unit tests. parseConfigJson5 is used directly so we
 * let it pass through to the real implementation.
 */
vi.mock("../config/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...real,
    readConfigFileSnapshot: vi.fn(),
  };
});

/** Helper to set the mock return value for readConfigFileSnapshot. */
async function mockCurrentConfig(config: Record<string, unknown>) {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  vi.mocked(readConfigFileSnapshot).mockResolvedValue({
    config,
    valid: true,
    raw: JSON.stringify(config),
    issues: [],
    path: "/mock/openclaw.json5",
    hash: "mock-hash",
    envSnapshot: {},
    includeChain: [],
    exists: true,
    parsed: config,
    resolved: config,
    warnings: [],
    legacyIssues: [],
  } as unknown as Awaited<ReturnType<typeof readConfigFileSnapshot>>);
}

describe("sanitizeConfigSetForHostedMode", () => {
  it("replaces non-allowed keys with current on-disk values", async () => {
    await mockCurrentConfig({
      gateway: { port: 8080 },
      auth: { secret: "platform-secret" },
      agents: { list: [{ id: "main" }] },
    });

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        gateway: { port: 9999 },
        auth: { secret: "hacked" },
        agents: { list: [{ id: "modified" }] },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    // Non-allowed keys restored to current values
    expect(sanitized.gateway).toEqual({ port: 8080 });
    expect(sanitized.auth).toEqual({ secret: "platform-secret" });
    // Allowed keys pass through unchanged
    expect(sanitized.agents).toEqual({ list: [{ id: "modified" }] });
  });

  it("deletes non-allowed keys that are not in current config", async () => {
    await mockCurrentConfig({
      agents: { list: [] },
    });

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        gateway: { port: 9999 },
        agents: { list: [{ id: "new" }] },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.gateway).toBeUndefined();
    expect(sanitized.agents).toEqual({ list: [{ id: "new" }] });
  });

  it("restores non-allowed keys from current config even if not in incoming", async () => {
    await mockCurrentConfig({
      gateway: { port: 8080 },
      env: { NODE_ENV: "production" },
      agents: { list: [] },
    });

    const params: Record<string, unknown> = {
      raw: JSON.stringify({ agents: { list: [{ id: "new" }] } }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    // Non-allowed keys from current config are restored
    expect(sanitized.gateway).toEqual({ port: 8080 });
    expect(sanitized.env).toEqual({ NODE_ENV: "production" });
    expect(sanitized.agents).toEqual({ list: [{ id: "new" }] });
  });

  it("blocks unknown/new keys not in the allowed list", async () => {
    await mockCurrentConfig({});

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: { list: [] },
        someNewInfraKey: { dangerous: true },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.agents).toEqual({ list: [] });
    expect(sanitized.someNewInfraKey).toBeUndefined();
  });

  it("passes through all allowed keys unchanged", async () => {
    await mockCurrentConfig({ gateway: { port: 8080 } });

    const allowedConfig = {
      agents: { list: [] },
      messages: { welcome: "hi" },
      commands: [],
      hooks: {},
      skills: [],
      tools: {},
      session: { timeout: 300 },
      cron: { enabled: true },
      audio: {},
      talk: {},
      broadcast: {},
      ui: { theme: "dark" },
      models: { primary: "gpt-4" },
    };

    const params: Record<string, unknown> = {
      raw: JSON.stringify(allowedConfig),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    for (const [key, value] of Object.entries(allowedConfig)) {
      expect(sanitized[key]).toEqual(value);
    }
  });

  it("returns false for missing raw param", async () => {
    const params: Record<string, unknown> = {};
    const result = await sanitizeConfigSetForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for non-string raw param", async () => {
    const params: Record<string, unknown> = { raw: 42 };
    const result = await sanitizeConfigSetForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for malformed JSON", async () => {
    const params: Record<string, unknown> = { raw: "{invalid json" };
    const result = await sanitizeConfigSetForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for array raw value", async () => {
    const params: Record<string, unknown> = { raw: "[1,2,3]" };
    const result = await sanitizeConfigSetForHostedMode(params);
    expect(result).toBe(false);
  });

  it("handles empty incoming config", async () => {
    await mockCurrentConfig({ gateway: { port: 8080 } });

    const params: Record<string, unknown> = { raw: "{}" };
    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    // Non-allowed key from current config is restored
    expect(sanitized.gateway).toEqual({ port: 8080 });
  });
});

describe("sanitizeConfigPatchForHostedMode", () => {
  it("strips non-allowed keys from patch", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        gateway: { port: 9999 },
        auth: { secret: "hacked" },
        agents: { list: [{ id: "modified" }] },
        messages: { welcome: "hello" },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.gateway).toBeUndefined();
    expect(sanitized.auth).toBeUndefined();
    // Allowed keys remain
    expect(sanitized.agents).toEqual({ list: [{ id: "modified" }] });
    expect(sanitized.messages).toEqual({ welcome: "hello" });
  });

  it("passes through all allowed keys unchanged", () => {
    const allowedPatch = {
      agents: { list: [{ id: "new" }] },
      hooks: { onStart: "echo hi" },
      cron: { enabled: false },
    };

    const params: Record<string, unknown> = {
      raw: JSON.stringify(allowedPatch),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized).toEqual(allowedPatch);
  });

  it("strips all non-allowed keys from a patch that only contains them", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        gateway: { port: 1234 },
        env: { NODE_ENV: "production" },
        channels: { telegram: {} },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(Object.keys(sanitized)).toHaveLength(0);
  });

  it("strips unknown keys not in the allowed list", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: { list: [] },
        diagnostics: { enabled: true },
        nodeHost: { url: "http://evil" },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.agents).toEqual({ list: [] });
    expect(sanitized.diagnostics).toBeUndefined();
    expect(sanitized.nodeHost).toBeUndefined();
  });

  it("returns false for missing raw param", () => {
    const params: Record<string, unknown> = {};
    const result = sanitizeConfigPatchForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for non-string raw param", () => {
    const params: Record<string, unknown> = { raw: 123 };
    const result = sanitizeConfigPatchForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    const params: Record<string, unknown> = { raw: "not json" };
    const result = sanitizeConfigPatchForHostedMode(params);
    expect(result).toBe(false);
  });

  it("returns false for array raw value", () => {
    const params: Record<string, unknown> = { raw: "[]" };
    const result = sanitizeConfigPatchForHostedMode(params);
    expect(result).toBe(false);
  });

  it("handles empty patch", () => {
    const params: Record<string, unknown> = { raw: "{}" };
    const result = sanitizeConfigPatchForHostedMode(params);
    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized).toEqual({});
  });
});

describe("HOSTED_MODE_ALLOWED_CONFIG_KEYS", () => {
  it("contains all expected user-owned keys", () => {
    const expected = [
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
    ];
    for (const key of expected) {
      expect(HOSTED_MODE_ALLOWED_CONFIG_KEYS.has(key)).toBe(true);
    }
  });

  it("does not contain infrastructure-managed keys", () => {
    const infraKeys = [
      "gateway",
      "env",
      "update",
      "auth",
      "channels",
      "discovery",
      "browser",
      "logging",
      "plugins",
      "wizard",
      "meta",
      "bindings",
      "canvasHost",
      "web",
    ];
    for (const key of infraKeys) {
      expect(HOSTED_MODE_ALLOWED_CONFIG_KEYS.has(key)).toBe(false);
    }
  });
});
