import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_MODE_ALLOWED_CONFIG_KEYS,
  HOSTED_MODE_FORCED_DEEP_PATHS,
  HOSTED_MODE_FORCED_SUBKEYS,
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
      commands: { text: true, native: "auto" },
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
    // Non-commands sections pass through unchanged
    expect(sanitized.agents).toEqual({ list: [] });
    expect(sanitized.messages).toEqual({ welcome: "hi" });
    expect(sanitized.ui).toEqual({ theme: "dark" });
    // commands section has forced sub-keys applied
    expect(sanitized.commands.text).toBe(true);
    expect(sanitized.commands.native).toBe("auto");
    expect(sanitized.commands.bash).toBe(false);
    expect(sanitized.commands.config).toBe(false);
    expect(sanitized.commands.debug).toBe(false);
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

describe("HOSTED_MODE_FORCED_SUBKEYS", () => {
  it("forces commands.bash/config/debug to false", () => {
    expect(HOSTED_MODE_FORCED_SUBKEYS.commands).toEqual({
      bash: false,
      config: false,
      debug: false,
    });
  });
});

describe("forced sub-keys in sanitizeConfigSetForHostedMode", () => {
  it("overrides commands.bash/config/debug even if tenant enables them", async () => {
    await mockCurrentConfig({
      commands: { bash: false, config: false, debug: false, text: true },
    });

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        commands: { bash: true, config: true, debug: true, text: true },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.commands.bash).toBe(false);
    expect(sanitized.commands.config).toBe(false);
    expect(sanitized.commands.debug).toBe(false);
    // Non-forced sub-keys pass through
    expect(sanitized.commands.text).toBe(true);
  });

  it("applies forced sub-keys even to new commands section", async () => {
    await mockCurrentConfig({});

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        commands: { bash: true, native: "auto" },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.commands.bash).toBe(false);
    expect(sanitized.commands.config).toBe(false);
    expect(sanitized.commands.debug).toBe(false);
    expect(sanitized.commands.native).toBe("auto");
  });
});

describe("forced sub-keys in sanitizeConfigPatchForHostedMode", () => {
  it("overrides commands.bash/config/debug in patch", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        commands: { bash: true, config: true, debug: true, restart: true },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.commands.bash).toBe(false);
    expect(sanitized.commands.config).toBe(false);
    expect(sanitized.commands.debug).toBe(false);
    // Non-forced sub-keys pass through
    expect(sanitized.commands.restart).toBe(true);
  });

  it("does not create commands section if not in patch", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: { list: [] },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.commands).toBeUndefined();
    expect(sanitized.agents).toEqual({ list: [] });
  });
});

describe("HOSTED_MODE_FORCED_DEEP_PATHS", () => {
  it("forces sandbox Docker network and readOnlyRoot", () => {
    expect(HOSTED_MODE_FORCED_DEEP_PATHS["agents.defaults.sandbox.docker.network"]).toBe("none");
    expect(HOSTED_MODE_FORCED_DEEP_PATHS["agents.defaults.sandbox.docker.readOnlyRoot"]).toBe(true);
  });
});

describe("forced deep paths in sanitizeConfigSetForHostedMode", () => {
  it("forces sandbox Docker network to 'none' when agents.defaults.sandbox.docker exists", async () => {
    await mockCurrentConfig({});

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: {
          defaults: {
            sandbox: {
              docker: {
                network: "host",
                readOnlyRoot: false,
                image: "node:20",
              },
            },
          },
        },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.agents.defaults.sandbox.docker.network).toBe("none");
    expect(sanitized.agents.defaults.sandbox.docker.readOnlyRoot).toBe(true);
    // Non-forced sandbox settings pass through
    expect(sanitized.agents.defaults.sandbox.docker.image).toBe("node:20");
  });

  it("skips deep path forcing gracefully if intermediate objects don't exist", async () => {
    await mockCurrentConfig({});

    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: { list: [{ id: "main" }] },
      }),
    };

    const result = await sanitizeConfigSetForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    // agents exists but defaults/sandbox/docker path doesn't — no crash, no forced keys injected
    expect(sanitized.agents.list).toEqual([{ id: "main" }]);
    expect(sanitized.agents.defaults).toBeUndefined();
  });
});

describe("forced deep paths in sanitizeConfigPatchForHostedMode", () => {
  it("forces sandbox Docker network to 'none' in patch", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: {
          defaults: {
            sandbox: {
              docker: { network: "bridge", readOnlyRoot: false },
            },
          },
        },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.agents.defaults.sandbox.docker.network).toBe("none");
    expect(sanitized.agents.defaults.sandbox.docker.readOnlyRoot).toBe(true);
  });

  it("does not inject deep paths when sandbox section is absent", () => {
    const params: Record<string, unknown> = {
      raw: JSON.stringify({
        agents: { list: [] },
      }),
    };

    const result = sanitizeConfigPatchForHostedMode(params);

    expect(result).toBe(true);
    const sanitized = JSON.parse(params.raw as string);
    expect(sanitized.agents.list).toEqual([]);
    expect(sanitized.agents.defaults).toBeUndefined();
  });
});
