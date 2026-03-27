/**
 * Sandbox code execution tool for Chelar hosted mode.
 *
 * Runs Python/Node.js/bash code in an isolated sidecar container managed by the
 * Chelar platform. The sandbox has no internet access, can only read/write the
 * workspace directory, and is separate from the main agent container.
 *
 * Calls the Go API directly via the internal sandbox port (8081).
 * Only registered when CHELAR_HOSTED=true and CHELAR_SANDBOX_API_URL is set.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const CodeExecSchema = Type.Object({
  language: Type.Union([Type.Literal("python"), Type.Literal("node"), Type.Literal("bash")], {
    description: "Programming language: 'python', 'node', or 'bash'",
  }),
  code: Type.String({ description: "The code to execute" }),
  timeout_secs: Type.Optional(
    Type.Number({ description: "Execution timeout in seconds (default: 30, max: 60)" }),
  ),
});

/** Create the sandbox code_exec tool (Chelar hosted mode only). */
export function createSandboxExecTool(): AnyAgentTool | null {
  const apiUrl = process.env.CHELAR_SANDBOX_API_URL;
  const tenantId = process.env.CHELAR_TENANT_ID;

  if (!apiUrl || !tenantId) {
    return null;
  }

  return {
    label: "Code Exec",
    name: "code_exec",
    description:
      "Execute Python, Node.js, or bash code in an isolated sandbox container. " +
      "The sandbox has no internet access and can only read/write workspace files. " +
      "Use for data processing, calculations, file transformations, and scripting tasks.",
    parameters: CodeExecSchema,
    execute: async (_toolCallId, params) => {
      const language = (params as Record<string, unknown>)?.language ?? "python";
      const code = (params as Record<string, unknown>)?.code;
      const timeoutSecs = Math.min(
        Number((params as Record<string, unknown>)?.timeout_secs ?? 30),
        60,
      );

      if (!code || typeof code !== "string") {
        return jsonResult({ error: "code is required" });
      }

      try {
        const url = `${apiUrl}/api/tenants/${tenantId}/sandbox/exec`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language, code, timeout_secs: timeoutSecs }),
          signal: AbortSignal.timeout((timeoutSecs + 10) * 1000),
        });

        if (!resp.ok) {
          const errorBody = await resp.text().catch(() => "");
          return jsonResult({
            error: `Sandbox exec failed: HTTP ${resp.status} — ${errorBody}`,
          });
        }

        const result = (await resp.json()) as {
          stdout?: string;
          stderr?: string;
          exit_code?: number;
          duration_ms?: number;
        };

        let output = "";
        if (result.stdout) {
          output += result.stdout;
        }
        if (result.stderr) {
          if (output) {
            output += "\n--- stderr ---\n";
          }
          output += result.stderr;
        }
        if (!output) {
          output = `(no output, exit code: ${result.exit_code ?? -1})`;
        } else {
          output += `\n[exit code: ${result.exit_code ?? -1}, ${result.duration_ms ?? 0}ms]`;
        }

        return jsonResult({
          output,
          exit_code: result.exit_code ?? -1,
          duration_ms: result.duration_ms ?? 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Sandbox exec request failed: ${message}` });
      }
    },
  };
}
