import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseTrackpro,
  TrackproPayloadSchema,
} from "../../src/webhooks/trackpro/trackpro.parser";
import {
  parseSwingmetric,
  SwingmetricPayloadSchema,
} from "../../src/webhooks/swingmetric/swingmetric.parser";
import {
  parseProswing,
  ProswingPayloadSchema,
} from "../../src/webhooks/proswing/proswing.parser";
import { parseProswingRaw } from "../../src/webhooks/proswing/proswing.schema";

const FIXTURE_DIR = join(__dirname, "../fixtures");

function loadFixture<T>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, path), "utf-8")) as T;
}

const RECEIVED_AT = "2026-05-18T10:15:00.000Z";

// ─── TrackPro ─────────────────────────────────────────────────────────────────

describe("TrackPro parser — V1 (flat SI units)", () => {
  it("schema parses valid payload to canonical form", () => {
    const raw = loadFixture<unknown>("trackpro.retransmit.json");
    const canonical = TrackproPayloadSchema.parse(raw);
    expect(canonical.shot_uid).toBe("tp-2026-05-18-9b3c1a4d");
    expect(canonical.user_external_id).toBe("user_001");
    expect(canonical.ball_speed_mps).toBe(58.2);
  });

  it("parses valid payload to NormalisedShot", () => {
    const raw = loadFixture<unknown>("trackpro.retransmit.json");
    const canonical = TrackproPayloadSchema.parse(raw);
    const shots = parseTrackpro(canonical, RECEIVED_AT);
    expect(shots).toHaveLength(1);
    const shot = shots[0]!;
    expect(shot.vendor).toBe("trackpro");
    expect(shot.idempotency_key).toBe("tp|tp-2026-05-18-9b3c1a4d");
    expect(shot.vendor_user_id).toBe("user_001");
    expect(shot.club_code).toBe("7I");
    expect(shot.ball_speed_mps).toBe(58.2);
    expect(shot.club_head_speed_mps).toBe(38.4);
    expect(shot.carry_m).toBe(142.3);
    expect(shot.lateral_m).toBe(-3.2);
    expect(shot.spin_rpm).toBe(6420);
    expect(shot.schema_version).toBe(1);
    expect(shot.parser_version).toBe("1.0.0");
  });

  it("generates idempotency_key as tp|<shot_uid>", () => {
    const raw = loadFixture<unknown>("trackpro.retransmit.json");
    const canonical = TrackproPayloadSchema.parse(raw);
    const [shot] = parseTrackpro(canonical, RECEIVED_AT);
    expect(shot!.idempotency_key).toBe("tp|tp-2026-05-18-9b3c1a4d");
  });

  it("preserves full raw_payload for provenance", () => {
    const raw = loadFixture<Record<string, unknown>>(
      "trackpro.retransmit.json",
    );
    const canonical = TrackproPayloadSchema.parse(raw);
    const [shot] = parseTrackpro(canonical, RECEIVED_AT);
    expect(shot!.raw_payload).toMatchObject({
      shot_uid: "tp-2026-05-18-9b3c1a4d",
    });
  });

  it("side_deviation_m right=+ stored as positive lateral_m", () => {
    const raw = {
      ...loadFixture<Record<string, unknown>>("trackpro.retransmit.json"),
      side_deviation_m: 5.5,
    };
    const canonical = TrackproPayloadSchema.parse(raw);
    const [shot] = parseTrackpro(canonical, RECEIVED_AT);
    expect(shot!.lateral_m).toBe(5.5);
  });

  it("rejects shot_uid not matching tp-YYYY-MM-DD-[a-f0-9]{8} regex", () => {
    const raw = {
      ...loadFixture<Record<string, unknown>>("trackpro.retransmit.json"),
      shot_uid: "invalid-uid",
    };
    expect(() => TrackproPayloadSchema.parse(raw)).toThrow();
  });

  it("rejects ball_speed_mps > 120 (schema guard)", () => {
    const raw = {
      ...loadFixture<Record<string, unknown>>("trackpro.retransmit.json"),
      ball_speed_mps: 125,
    };
    expect(() => TrackproPayloadSchema.parse(raw)).toThrow();
  });

  it("rejects extra unknown fields (.strict())", () => {
    const raw = {
      ...loadFixture<Record<string, unknown>>("trackpro.retransmit.json"),
      hacked_field: "evil",
    };
    expect(() => TrackproPayloadSchema.parse(raw)).toThrow();
  });
});

// ─── SwingMetric — unified schema (V1 + V2 field names) ──────────────────────
//
// Both V1 (club_used / carry_yds / offline_yds) and V2 (club / launch_angle /
// carry_yd / offline_yd) are normalised to canonical names by z.preprocess()
// inside SwingmetricPayloadSchema. No separate schemas or adapters are needed.

describe("SwingMetric parser — V1 (club_used / launch_deg / carry_yds / offline_yds)", () => {
  it("parses valid batch to multiple NormalisedShots", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const shots = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shots).toHaveLength(2);
    expect(shots[0]!.vendor).toBe("swingmetric");
  });

  it("generates correct idempotency_key", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    const expectedBucket = String(Math.floor(1779099398451 / 1000));
    expect(shot!.idempotency_key).toBe(
      `sm|swing-user-A|SWING_PRO_002|${expectedBucket}`,
    );
  });

  it("includes full envelope in raw_payload", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    const rp = shot!.raw_payload as { envelope: { session_id: string } };
    expect(rp.envelope.session_id).toBe("sm-sess-2026051810");
  });

  it("converts ball_speed_mph to mps", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shot!.ball_speed_mps).toBeCloseTo(68.13, 1);
  });

  it('normalises club "Driver" to club_code "DR"', () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shot!.club_code).toBe("DR");
    expect(shot!.club_raw).toBe("Driver");
  });

  it("converts swing_speed_mph to club_head_speed_mps", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shot!.club_head_speed_mps).toBeCloseTo(46.58, 1);
  });

  it("converts offline_yds to lateral_m", () => {
    const raw = loadFixture<unknown>("swingmetric.batch-with-duplicate.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const [shot] = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shot!.lateral_m).toBeCloseTo(-3.6576, 3);
  });

  it("rejects empty shots array", () => {
    const raw = loadFixture<unknown>("adversarial/empty-batch.json");
    expect(() => SwingmetricPayloadSchema.parse(raw)).toThrow();
  });

  it("unified schema accepts V2-format payload (launch_angle / carry_yd / offline_yd)", () => {
    // Previously only the old V2 adapter accepted this; now the single unified schema does.
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    expect(() => SwingmetricPayloadSchema.parse(raw)).not.toThrow();
  });
});

describe("SwingMetric parser — V2 (club / launch_angle / carry_yd / offline_yd)", () => {
  it("unified schema parses v2 fixture to canonical payload", () => {
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    expect(canonical.session_id).toBe("sm-v2-sess-2026051901");
    expect(canonical.player.id).toBe("swing-user-B");
    expect(canonical.shots).toHaveLength(2);
    // launch_angle → launch_deg normalised by preprocess
    expect(canonical.shots[0]!.launch_deg).toBe(22.8);
    expect(canonical.shots[0]!.carry_yd).toBe(158.0);
    expect(canonical.shots[0]!.offline_yd).toBe(-2.1);
  });

  it("produces NormalisedShots from v2 fixture", () => {
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const shots = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shots).toHaveLength(2);
    expect(shots[0]!.vendor).toBe("swingmetric");
    expect(shots[0]!.vendor_user_id).toBe("swing-user-B");
  });

  it("normalises club names from V2 payload", () => {
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const shots = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shots[0]!.club_code).toBe("7I");
    expect(shots[0]!.club_raw).toBe("7I");
    expect(shots[1]!.club_code).toBe("DR");
  });

  it("maps launch_angle → launch_deg in NormalisedShot", () => {
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const shots = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shots[0]!.launch_angle_deg).toBe(22.8);
    expect(shots[1]!.launch_angle_deg).toBe(11.5);
  });

  it("converts carry_yd to carry_m", () => {
    const raw = loadFixture<unknown>("swingmetric.v2.json");
    const canonical = SwingmetricPayloadSchema.parse(raw);
    const shots = parseSwingmetric(canonical, RECEIVED_AT);
    expect(shots[0]!.carry_m).toBeCloseTo(144.48, 1);
  });

  it("rejects ball_speed_mph > 268", () => {
    const raw = {
      session_id: "sm-v2-test",
      player: { id: "p1" },
      device: "D1",
      shots: [
        {
          ts_ms: 1779199398000,
          club: "7I",
          ball_speed_mph: 350,
          launch_angle: 22.8,
          carry_yd: 158.0,
          offline_yd: -2.1,
        },
      ],
    };
    expect(() => SwingmetricPayloadSchema.parse(raw)).toThrow();
  });

  it("rejects missing launch field (both launch_deg and launch_angle absent)", () => {
    const raw = {
      session_id: "sm-v2-test",
      player: { id: "p1" },
      device: "D1",
      shots: [
        {
          ts_ms: 1779199398000,
          club: "7I",
          ball_speed_mph: 121.5,
          carry_yd: 158.0,
          offline_yd: -2.1,
        },
      ],
    };
    expect(() => SwingmetricPayloadSchema.parse(raw)).toThrow();
  });
});

// ─── ProSwing V1 ──────────────────────────────────────────────────────────────
//
// parseProswingRaw() detects the version by structural inspection and routes
// each payload to the matching schema. All three formats produce a
// ProswingCanonicalPayload so parseProswing() is version-agnostic.

describe("ProSwing parser — V1 (nested {value, unit} measurements)", () => {
  it("parses valid payload with timezone offset", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.vendor).toBe("proswing");
    expect(shot!.idempotency_key).toBe("ps|ps_tok_b2a14e7c91f0|ps_shot_001");
  });

  it("uses user_token as vendor_user_id", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.vendor_user_id).toBe("ps_tok_b2a14e7c91f0");
  });

  it("converts +10:00 offset to captured_at_tz_offset_min=600 and UTC timestamp", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.captured_at_tz_offset_min).toBe(600);
    expect(shot!.captured_at_utc).toBe("2026-05-18T10:14:22.000Z");
  });

  it("converts ball_speed mph → mps", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.ball_speed_mps).toBeCloseTo(58.29, 1);
  });

  it("converts club_speed mph → mps", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.club_head_speed_mps).toBeCloseTo(38.49, 1);
  });

  it("converts ball_speed kph → mps", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json") as Record<
      string,
      unknown
    >;
    const data = raw["data"] as Record<string, unknown>;
    const shot = data["shot"] as Record<string, unknown>;
    const modified = {
      ...raw,
      data: {
        ...data,
        shot: { ...shot, ball_speed: { value: 180.0, unit: "kph" } },
      },
    };
    const canonical = parseProswingRaw(modified);
    const [result] = parseProswing(canonical, RECEIVED_AT);
    expect(result!.ball_speed_mps).toBeCloseTo(50, 2);
  });

  it("sets spin_rpm=null for V1 (no spin_rpm field)", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.spin_rpm).toBeNull();
  });

  it("converts deviation yd → lateral_m", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.lateral_m).toBeCloseTo(-3.2004, 3);
  });

  it('normalises "I7" → "7I"', () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.club_code).toBe("7I");
    expect(shot!.club_raw).toBe("I7");
  });

  it("V1 schema rejects ball_speed_mps > 120 (unit-mistag)", () => {
    const raw = loadFixture<unknown>("adversarial/unit-mistag.json");
    expect(() => ProswingPayloadSchema.parse(raw)).toThrow();
  });

  it("parseProswingRaw rejects unit-mistag payload", () => {
    const raw = loadFixture<unknown>("adversarial/unit-mistag.json");
    expect(() => parseProswingRaw(raw)).toThrow();
  });
});

// ─── ProSwing V2 ──────────────────────────────────────────────────────────────

describe("ProSwing parser — V2 flat (ball_speed_mph / launch_deg / carry_yd / deviation_yd)", () => {
  it("parseProswingRaw routes V2 payload to canonical nested form", () => {
    const raw = loadFixture<unknown>("proswing.v2.json");
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.shot.ball_speed).toEqual({
      value: 132.5,
      unit: "mph",
    });
    expect(canonical.data.shot.launch).toEqual({ value: 19.5, unit: "deg" });
    expect(canonical.data.shot.carry).toEqual({ value: 162.0, unit: "yd" });
    expect(canonical.data.shot.deviation).toEqual({ value: -1.8, unit: "yd" });
  });

  it("produces NormalisedShot from v2 fixture", () => {
    const raw = loadFixture<unknown>("proswing.v2.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.vendor).toBe("proswing");
    expect(shot!.vendor_user_id).toBe("ps_tok_v2_a1b2c3d4ef");
    expect(shot!.idempotency_key).toBe(
      "ps|ps_tok_v2_a1b2c3d4ef|ps_v2_shot_001",
    );
  });

  it("converts ball_speed_mph through parser", () => {
    const raw = loadFixture<unknown>("proswing.v2.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.ball_speed_mps).toBeCloseTo(59.23, 1);
  });

  it("converts carry_yd through parser", () => {
    const raw = loadFixture<unknown>("proswing.v2.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.carry_m).toBeCloseTo(148.13, 1);
  });

  it("converts deviation_yd through parser", () => {
    const raw = loadFixture<unknown>("proswing.v2.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.lateral_m).toBeCloseTo(-1.65, 1);
  });

  it("handles ball_speed_kph variant", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        user_token: "ps_tok_kph_test12345",
        shot: {
          id: "ps_kph_001",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "5I",
          ball_speed_kph: 214.0,
          launch_deg: 20.0,
          carry_yd: 175.0,
          deviation_yd: 1.5,
        },
      },
    };
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.shot.ball_speed).toEqual({
      value: 214.0,
      unit: "kph",
    });
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.ball_speed_mps).toBeCloseTo(59.44, 1);
  });

  it("handles deviation_m variant", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        user_token: "ps_tok_dev_test12345",
        shot: {
          id: "ps_dev_m_001",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "7I",
          ball_speed_mph: 125.0,
          launch_deg: 22.0,
          carry_m: 145.0,
          deviation_m: -2.5,
        },
      },
    };
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.shot.carry).toEqual({ value: 145.0, unit: "m" });
    expect(canonical.data.shot.deviation).toEqual({ value: -2.5, unit: "m" });
  });

  it("rejects missing all ball_speed variants", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        user_token: "ps_tok_missing_speed1",
        shot: {
          id: "ps_no_speed",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "7I",
          launch_deg: 22.0,
          carry_yd: 155.0,
          deviation_yd: -1.0,
        },
      },
    };
    expect(() => parseProswingRaw(raw)).toThrow();
  });

  it("rejects ball_speed_mps > 120 (unit-mistag)", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        user_token: "ps_tok_mistag_test123",
        shot: {
          id: "ps_mistag",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "DR",
          ball_speed_mps: 180.0,
          launch_deg: 11.0,
          carry_yd: 240.0,
          deviation_yd: 2.0,
        },
      },
    };
    expect(() => parseProswingRaw(raw)).toThrow();
  });
});

// ─── ProSwing V3 ──────────────────────────────────────────────────────────────

describe("ProSwing parser — V3 (player/device envelope + scalar launch_angle + spin_rpm)", () => {
  it("parseProswingRaw routes V3 fixture to canonical form", () => {
    const raw = loadFixture<unknown>("proswing.v3.json");
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.shot.ball_speed).toEqual({
      value: 129.5,
      unit: "mph",
    });
    expect(canonical.data.shot.launch).toEqual({ value: 17.8, unit: "deg" });
    expect(canonical.data.shot.carry).toEqual({ value: 155.6, unit: "yd" });
    expect(canonical.data.shot.deviation).toEqual({ value: -4.0, unit: "ft" });
  });

  it("maps player.id → user_token (vendor_user_id)", () => {
    const raw = loadFixture<unknown>("proswing.v3.json");
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.user_token).toBe("ps-v3-player-001");
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.vendor_user_id).toBe("ps-v3-player-001");
  });

  it("propagates spin_rpm through to NormalisedShot", () => {
    const raw = loadFixture<unknown>("proswing.v3.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.spin_rpm).toBe(7200);
  });

  it("converts ball_speed mph → mps", () => {
    const raw = loadFixture<unknown>("proswing.v3.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.ball_speed_mps).toBeCloseTo(57.91, 1);
  });

  it("V3 without spin_rpm produces spin_rpm=null", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        player: { id: "ps-v3-no-spin" },
        shot: {
          id: "ps-v3-no-spin-001",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "6I",
          ball_speed: { value: 130.0, unit: "mph" },
          launch_angle: 18.0,
          carry: { value: 160.0, unit: "yd" },
          deviation: { value: -2.0, unit: "yd" },
        },
      },
    };
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.spin_rpm).toBeNull();
  });

  it("rejects V3 payload with ball_speed_mps > 120 (unit-mistag)", () => {
    const raw = {
      type: "shot.recorded",
      data: {
        player: { id: "ps-v3-mistag-player" },
        shot: {
          id: "ps-v3-mistag",
          occurred_at: "2026-05-19T10:00:00Z",
          club_code: "DR",
          ball_speed: { value: 180.0, unit: "mps" },
          launch_angle: 11.0,
          carry: { value: 240.0, unit: "yd" },
          deviation: { value: 2.0, unit: "yd" },
        },
      },
    };
    expect(() => parseProswingRaw(raw)).toThrow();
  });

  it("detectVersion routes V3 fixture correctly (player marker)", () => {
    // V3 is detected by data.player existing. Verify via parseProswingRaw.
    const raw = loadFixture<unknown>("proswing.v3.json");
    const canonical = parseProswingRaw(raw);
    expect(canonical.data.shot.id).toBe("ps-v3-shot-001");
  });

  it("V1 payload still produces spin_rpm=null after V3 schema is registered", () => {
    const raw = loadFixture<unknown>("proswing.tz-offset.json");
    const canonical = parseProswingRaw(raw);
    const [shot] = parseProswing(canonical, RECEIVED_AT);
    expect(shot!.spin_rpm).toBeNull();
  });
});

// ─── Adversarial ──────────────────────────────────────────────────────────────

describe("Adversarial cases", () => {
  it("rejects SwingMetric empty batch", () => {
    expect(() =>
      SwingmetricPayloadSchema.parse(
        loadFixture("adversarial/empty-batch.json"),
      ),
    ).toThrow();
  });

  it("TrackPro clock-skew-24h passes schema (staleness caught by processor)", () => {
    // Schema intentionally allows any timestamp — processor validates staleness
    expect(() =>
      TrackproPayloadSchema.parse(
        loadFixture("adversarial/clock-skew-24h.json"),
      ),
    ).not.toThrow();
  });
});
