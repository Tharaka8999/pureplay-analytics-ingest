import { describe, it, expect } from "vitest";
import { redactPii } from "../../src/shared/pii-redact";

describe("redactPii [SEC]", () => {
  it("removes player.email from nested object", () => {
    const payload = {
      player: {
        id: "P001",
        email: "golfer@example.com",
        name: "Tiger",
      },
      shots: [],
    };
    const result = redactPii(payload);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const player = parsed["player"] as Record<string, unknown>;
    expect(player["email"]).toBeUndefined();
    expect(player["id"]).toBe("P001");
    expect(player["name"]).toBe("Tiger");
  });

  it("removes user_token from top-level", () => {
    const payload = { user_token: "secret-token-abc", foo: "bar" };
    const result = redactPii(payload);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["user_token"]).toBeUndefined();
    expect(parsed["foo"]).toBe("bar");
  });

  it("removes data.user_token from nested object", () => {
    const payload = { data: { user_token: "tok-xyz", shot_id: "123" } };
    const result = redactPii(payload);
    const parsed = JSON.parse(result) as { data: Record<string, unknown> };
    expect(parsed.data["user_token"]).toBeUndefined();
    expect(parsed.data["shot_id"]).toBe("123");
  });

  it("strips all RFC5322 email addresses via regex", () => {
    const payload = {
      description: "Contact admin@club.org for support",
      contact: "user123+tag@sub.domain.co.uk",
    };
    const result = redactPii(payload);
    expect(result).not.toContain("admin@club.org");
    expect(result).not.toContain("user123+tag@sub.domain.co.uk");
  });

  it("preserves non-PII fields intact", () => {
    const payload = {
      shot_id: "tp-2024-01-01-abcd1234",
      ball_speed_mph: 152.3,
      club: "7I",
    };
    const result = redactPii(payload);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed["shot_id"]).toBe("tp-2024-01-01-abcd1234");
    expect(parsed["ball_speed_mph"]).toBe(152.3);
    expect(parsed["club"]).toBe("7I");
  });

  it("handles deeply nested PII", () => {
    const payload = {
      session: {
        player: {
          email: "deep@nested.com",
          token: "should-stay",
        },
      },
    };
    const result = redactPii(payload);
    expect(result).not.toContain("deep@nested.com");
  });

  it("returns valid JSON string", () => {
    const payload = { player: { email: "test@example.com" } };
    expect(() => JSON.parse(redactPii(payload))).not.toThrow();
  });

  it("handles null/undefined values without crashing", () => {
    const payload = { player: null, user_token: undefined };
    expect(() => redactPii(payload)).not.toThrow();
  });
});
