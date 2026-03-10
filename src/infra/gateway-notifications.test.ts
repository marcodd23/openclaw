import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyNotificationCategory,
  clearGatewayNotificationsForTest,
  listGatewayNotifications,
  pushGatewayNotification,
} from "./gateway-notifications.js";

afterEach(() => {
  clearGatewayNotificationsForTest();
  vi.restoreAllMocks();
});

describe("pushGatewayNotification + listGatewayNotifications", () => {
  it("inserts and returns notifications newest-first", () => {
    pushGatewayNotification("error", "billing", "Your credit balance is too low");
    pushGatewayNotification("warning", "rate_limit", "Rate limit exceeded");

    const list = listGatewayNotifications();
    expect(list).toHaveLength(2);
    expect(list[0].category).toBe("rate_limit");
    expect(list[1].category).toBe("billing");
    expect(list[0].count).toBe(1);
  });

  it("deduplicates repeated errors within the dedup window", () => {
    pushGatewayNotification("error", "billing", "Your credit balance is too low");
    pushGatewayNotification("error", "billing", "Your credit balance is too low");
    pushGatewayNotification("error", "billing", "Your credit balance is too low");

    const list = listGatewayNotifications();
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(3);
  });

  it("does not dedup different messages in the same category", () => {
    pushGatewayNotification("error", "billing", "Error A");
    pushGatewayNotification("error", "billing", "Error B");

    const list = listGatewayNotifications();
    expect(list).toHaveLength(2);
  });

  it("does not dedup same message outside the dedup window", () => {
    const msg = "Your credit balance is too low";

    // First push at t=0
    pushGatewayNotification("error", "billing", msg);

    // Advance time past the 60s dedup window
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);

    pushGatewayNotification("error", "billing", msg);

    const list = listGatewayNotifications();
    expect(list).toHaveLength(2);
    expect(list[0].count).toBe(1);
    expect(list[1].count).toBe(1);
  });

  it("evicts oldest entries when exceeding max capacity", () => {
    for (let i = 0; i < 55; i++) {
      pushGatewayNotification("info", "general", `Message ${i}`);
    }

    const list = listGatewayNotifications();
    expect(list).toHaveLength(50);
    // Newest is first — should be "Message 54"
    expect(list[0].message).toBe("Message 54");
    // Oldest retained should be "Message 5" (0-4 evicted)
    expect(list[49].message).toBe("Message 5");
  });

  it("prunes expired entries on read", () => {
    const now = Date.now();
    pushGatewayNotification("error", "billing", "Old error");

    // Advance time past 1h TTL
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);

    const list = listGatewayNotifications();
    expect(list).toHaveLength(0);
  });

  it("returns empty array when buffer is empty", () => {
    expect(listGatewayNotifications()).toEqual([]);
  });
});

describe("classifyNotificationCategory", () => {
  it("classifies billing errors", () => {
    const result = classifyNotificationCategory("Your credit balance is too low to continue");
    expect(result).toEqual({ category: "billing", level: "error" });
  });

  it("classifies rate limit errors", () => {
    const result = classifyNotificationCategory("Rate limit exceeded: 429 Too Many Requests");
    expect(result).toEqual({ category: "rate_limit", level: "warning" });
  });

  it("classifies auth errors", () => {
    const result = classifyNotificationCategory("Invalid API key provided");
    expect(result).toEqual({ category: "auth", level: "error" });
  });

  it("classifies context overflow errors", () => {
    const result = classifyNotificationCategory("This model's maximum context length is exceeded");
    expect(result).toEqual({ category: "context_overflow", level: "warning" });
  });

  it("falls back to general for unrecognized errors", () => {
    const result = classifyNotificationCategory("Something unexpected happened");
    expect(result).toEqual({ category: "general", level: "error" });
  });
});
