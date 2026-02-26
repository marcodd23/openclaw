import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as rateLimitTesting } from "./control-plane-rate-limit.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;

/**
 * Mock the hosted-mode-config-guard module so sanitization calls don't
 * hit the real filesystem (readConfigFileSnapshot). The dedicated
 * hosted-mode-config-guard.test.ts covers sanitization logic in depth.
 */
vi.mock("./hosted-mode-config-guard.js", () => ({
  sanitizeConfigSetForHostedMode: vi.fn().mockResolvedValue(true),
  sanitizeConfigPatchForHostedMode: vi.fn().mockReturnValue(true),
}));

describe("gateway hosted-mode RPC blocking", () => {
  const ORIGINAL_ENV = process.env.CLAWDECK_HOSTED;

  beforeEach(() => {
    delete process.env.CLAWDECK_HOSTED;
    rateLimitTesting.resetControlPlaneRateLimitState();
  });

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.CLAWDECK_HOSTED = ORIGINAL_ENV;
    } else {
      delete process.env.CLAWDECK_HOSTED;
    }
  });

  function buildContext() {
    return {
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildBrowserConnect(): NonNullable<
    Parameters<typeof handleGatewayRequest>[0]["client"]
  >["connect"] {
    return {
      role: "operator",
      scopes: ["operator.admin"],
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "darwin",
        mode: "ui",
      },
      minProtocol: 1,
      maxProtocol: 1,
    };
  }

  /** Builds a client simulating a browser Control UI connection. */
  function buildBrowserClient() {
    return {
      connect: buildBrowserConnect(),
      connId: "conn-browser",
      clientIp: "10.0.0.5",
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  /** Builds a client simulating the ClawDeck Go API (platform: "server"). */
  function buildServerClient() {
    const connect = buildBrowserConnect();
    connect.client = {
      ...connect.client,
      id: "gateway-client",
      platform: "server",
    };
    return {
      connect,
      connId: "conn-server",
      clientIp: "127.0.0.1",
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  async function runRequest(params: {
    method: string;
    client: Parameters<typeof handleGatewayRequest>[0]["client"];
    handler: GatewayRequestHandler;
    reqParams?: Record<string, unknown>;
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: crypto.randomUUID(),
        method: params.method,
        params: params.reqParams,
      },
      respond,
      client: params.client,
      isWebchatConnect: noWebchat,
      context: buildContext(),
      extraHandlers: {
        [params.method]: params.handler,
      },
    });
    return respond;
  }

  // --- Methods that are fully blocked (config.apply, update.run) ---
  const BLOCKED_METHODS = ["config.apply", "update.run"];

  for (const method of BLOCKED_METHODS) {
    it(`blocks ${method} for browser client when CLAWDECK_HOSTED=true`, async () => {
      process.env.CLAWDECK_HOSTED = "true";
      const handler: GatewayRequestHandler = (opts) => opts.respond(true, undefined, undefined);

      const respond = await runRequest({
        method,
        client: buildBrowserClient(),
        handler,
      });

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: `${method} is not available in hosted mode`,
        }),
      );
    });

    it(`allows ${method} for server platform client when CLAWDECK_HOSTED=true`, async () => {
      process.env.CLAWDECK_HOSTED = "true";
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls();
        opts.respond(true, undefined, undefined);
      };

      await runRequest({
        method,
        client: buildServerClient(),
        handler,
      });

      expect(handlerCalls).toHaveBeenCalledTimes(1);
    });

    it(`allows ${method} for browser client when CLAWDECK_HOSTED is not set`, async () => {
      // CLAWDECK_HOSTED is not set (deleted in beforeEach)
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls();
        opts.respond(true, undefined, undefined);
      };

      await runRequest({
        method,
        client: buildBrowserClient(),
        handler,
      });

      expect(handlerCalls).toHaveBeenCalledTimes(1);
    });
  }

  // --- Methods that are sanitized (config.set, config.patch) ---
  const SANITIZED_METHODS = ["config.set", "config.patch"];

  for (const method of SANITIZED_METHODS) {
    it(`allows ${method} for browser client when CLAWDECK_HOSTED=true (sanitized, not blocked)`, async () => {
      process.env.CLAWDECK_HOSTED = "true";
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls();
        opts.respond(true, undefined, undefined);
      };

      await runRequest({
        method,
        client: buildBrowserClient(),
        handler,
      });

      // Should reach the handler (not be blocked)
      expect(handlerCalls).toHaveBeenCalledTimes(1);
    });

    it(`allows ${method} for server platform client when CLAWDECK_HOSTED=true`, async () => {
      process.env.CLAWDECK_HOSTED = "true";
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls();
        opts.respond(true, undefined, undefined);
      };

      await runRequest({
        method,
        client: buildServerClient(),
        handler,
      });

      expect(handlerCalls).toHaveBeenCalledTimes(1);
    });

    it(`allows ${method} for browser client when CLAWDECK_HOSTED is not set`, async () => {
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls();
        opts.respond(true, undefined, undefined);
      };

      await runRequest({
        method,
        client: buildBrowserClient(),
        handler,
      });

      expect(handlerCalls).toHaveBeenCalledTimes(1);
    });
  }

  // --- Sanitization integration: verify the mock guards are called ---
  it("calls sanitizeConfigSetForHostedMode for config.set from browser in hosted mode", async () => {
    process.env.CLAWDECK_HOSTED = "true";
    const { sanitizeConfigSetForHostedMode } = await import("./hosted-mode-config-guard.js");
    const handler: GatewayRequestHandler = (opts) => opts.respond(true, undefined, undefined);

    await runRequest({
      method: "config.set",
      client: buildBrowserClient(),
      handler,
      reqParams: { raw: '{"agents":{}}' },
    });

    expect(sanitizeConfigSetForHostedMode).toHaveBeenCalled();
  });

  it("calls sanitizeConfigPatchForHostedMode for config.patch from browser in hosted mode", async () => {
    process.env.CLAWDECK_HOSTED = "true";
    const { sanitizeConfigPatchForHostedMode } = await import("./hosted-mode-config-guard.js");
    const handler: GatewayRequestHandler = (opts) => opts.respond(true, undefined, undefined);

    await runRequest({
      method: "config.patch",
      client: buildBrowserClient(),
      handler,
      reqParams: { raw: '{"agents":{}}' },
    });

    expect(sanitizeConfigPatchForHostedMode).toHaveBeenCalled();
  });

  it("does not call sanitizers for server platform client", async () => {
    process.env.CLAWDECK_HOSTED = "true";
    const { sanitizeConfigSetForHostedMode, sanitizeConfigPatchForHostedMode } =
      await import("./hosted-mode-config-guard.js");
    vi.mocked(sanitizeConfigSetForHostedMode).mockClear();
    vi.mocked(sanitizeConfigPatchForHostedMode).mockClear();
    const handler: GatewayRequestHandler = (opts) => opts.respond(true, undefined, undefined);

    await runRequest({
      method: "config.set",
      client: buildServerClient(),
      handler,
      reqParams: { raw: '{"agents":{}}' },
    });
    await runRequest({
      method: "config.patch",
      client: buildServerClient(),
      handler,
      reqParams: { raw: '{"agents":{}}' },
    });

    expect(sanitizeConfigSetForHostedMode).not.toHaveBeenCalled();
    expect(sanitizeConfigPatchForHostedMode).not.toHaveBeenCalled();
  });

  it("does not block non-restricted methods in hosted mode", async () => {
    process.env.CLAWDECK_HOSTED = "true";
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls();
      opts.respond(true, undefined, undefined);
    };

    await runRequest({
      method: "health",
      client: buildBrowserClient(),
      handler,
    });

    expect(handlerCalls).toHaveBeenCalledTimes(1);
  });
});
