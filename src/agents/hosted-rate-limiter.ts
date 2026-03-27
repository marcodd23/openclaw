/**
 * Sliding-window rate limiter for Chelar hosted mode.
 *
 * Counts tool invocations per hour across all tools. When the limit is
 * exceeded, tool execution is blocked with an error message. This mirrors
 * ZeroClaw's `max_actions_per_hour` in `SecurityPolicy::record_action()`.
 *
 * Only active when CHELAR_HOSTED=true and CHELAR_MAX_ACTIONS_PER_HOUR is set.
 * Singleton instance — shared across all tool calls in the process.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Sliding-window action timestamps. */
const actions: number[] = [];

/** Max actions per hour. 0 = unlimited. */
let maxActions = 0;

/** Initialize from environment. Called once at import time. */
function init(): void {
  if (process.env.CHELAR_HOSTED !== "true") {
    return;
  }
  const envLimit = process.env.CHELAR_MAX_ACTIONS_PER_HOUR;
  if (envLimit) {
    const parsed = Number.parseInt(envLimit, 10);
    if (parsed > 0) {
      maxActions = parsed;
    }
  }
}

init();

/**
 * Record a tool invocation and check if the rate limit is exceeded.
 * @returns `true` if the action is allowed, `false` if rate-limited.
 */
export function recordAction(): boolean {
  if (maxActions <= 0) {
    return true; // no limit configured
  }
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Prune expired entries.
  while (actions.length > 0 && actions[0] < cutoff) {
    actions.shift();
  }

  if (actions.length >= maxActions) {
    return false; // rate limit exceeded
  }

  actions.push(now);
  return true;
}

/**
 * Check if rate limiting is active (hosted mode with limit configured).
 */
export function isRateLimitActive(): boolean {
  return maxActions > 0;
}
