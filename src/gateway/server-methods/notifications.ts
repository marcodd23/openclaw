/**
 * RPC handler for the `notifications.list` method — returns the gateway-wide
 * in-memory notification buffer (billing errors, rate limits, auth failures).
 * Used by the Chelar control plane to surface runtime issues in the dashboard.
 */

import { listGatewayNotifications } from "../../infra/gateway-notifications.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway notification RPC handlers. */
export const notificationsHandlers: GatewayRequestHandlers = {
  "notifications.list": ({ respond }) => {
    const notifications = listGatewayNotifications();
    respond(true, { notifications });
  },
};
