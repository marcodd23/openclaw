/**
 * Gateway-wide in-memory ring buffer for runtime notifications (billing errors,
 * rate limits, auth failures, context overflow). Unlike system-events.ts (which
 * is session-scoped and drained), this is a peek-only, gateway-scoped buffer
 * surfaced via the `notifications.list` RPC to the Chelar control plane.
 */

import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isContextOverflowError,
  isRateLimitErrorMessage,
} from "../agents/pi-embedded-helpers/errors.js";

/** Severity level for a gateway notification. */
export type NotificationLevel = "error" | "warning" | "info";

/** Category tag for classification and UI grouping. */
export type NotificationCategory =
  | "billing"
  | "rate_limit"
  | "auth"
  | "context_overflow"
  | "general";

/** A single gateway notification stored in the ring buffer. */
export type GatewayNotification = {
  id: string;
  level: NotificationLevel;
  category: NotificationCategory;
  message: string;
  /** Epoch ms of the first occurrence. */
  ts: number;
  /** Dedup counter — incremented when the same category+message recurs within DEDUP_WINDOW_MS. */
  count: number;
};

/** Maximum number of notifications retained in the buffer. */
const MAX_NOTIFICATIONS = 50;

/** Notifications older than this are pruned on read. */
const TTL_MS = 3_600_000; // 1 hour

/** Window within which identical category+message pairs are deduped (counter bumped). */
const DEDUP_WINDOW_MS = 60_000; // 60 seconds

/** Internal ring buffer — newest entries at the end. */
const buffer: GatewayNotification[] = [];

/**
 * Adds a notification to the buffer, deduplicating repeated errors within
 * DEDUP_WINDOW_MS. Oldest entries are evicted when MAX_NOTIFICATIONS is reached.
 */
export function pushGatewayNotification(
  level: NotificationLevel,
  category: NotificationCategory,
  message: string,
): void {
  const now = Date.now();

  // Dedup: if the most recent entry with the same category+message is within the window, bump its count.
  for (let i = buffer.length - 1; i >= 0; i--) {
    const existing = buffer[i];
    if (now - existing.ts > DEDUP_WINDOW_MS) {
      break;
    } // past the dedup window, stop scanning
    if (existing.category === category && existing.message === message) {
      existing.count++;
      existing.ts = now; // refresh timestamp so the dedup window slides
      return;
    }
  }

  const notification: GatewayNotification = {
    id: crypto.randomUUID(),
    level,
    category,
    message,
    ts: now,
    count: 1,
  };

  buffer.push(notification);

  // Evict oldest if over capacity.
  while (buffer.length > MAX_NOTIFICATIONS) {
    buffer.shift();
  }
}

/**
 * Returns all non-expired notifications, newest first.
 * Prunes expired entries as a side effect.
 */
export function listGatewayNotifications(): GatewayNotification[] {
  const now = Date.now();
  const cutoff = now - TTL_MS;

  // Prune expired entries (oldest are at the front).
  while (buffer.length > 0 && buffer[0].ts < cutoff) {
    buffer.shift();
  }

  // Return newest first (reverse of insertion order).
  return [...buffer].toReversed();
}

/**
 * Classifies an error message into a notification category and level using the
 * existing matchers from errors.ts.
 */
export function classifyNotificationCategory(errorText: string): {
  category: NotificationCategory;
  level: NotificationLevel;
} {
  if (isBillingErrorMessage(errorText)) {
    return { category: "billing", level: "error" };
  }
  if (isRateLimitErrorMessage(errorText)) {
    return { category: "rate_limit", level: "warning" };
  }
  if (isAuthErrorMessage(errorText)) {
    return { category: "auth", level: "error" };
  }
  if (isContextOverflowError(errorText)) {
    return { category: "context_overflow", level: "warning" };
  }
  return { category: "general", level: "error" };
}

/** Test helper — clears the entire notification buffer. */
export function clearGatewayNotificationsForTest(): void {
  buffer.length = 0;
}
