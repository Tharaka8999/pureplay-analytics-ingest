// Pureplay Analytics Ingest — k6 load test
//
// Usage:
//   brew install k6
//
//   k6 run \
//     -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod \
//     k6-load-test.js                          # load scenario (default)
//
//   k6 run -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod -e SCENARIO=smoke   k6-load-test.js  # 1 VU, 30s
//   k6 run -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod -e SCENARIO=nft     k6-load-test.js  # NFR ramp
//   k6 run -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod -e SCENARIO=peak    k6-load-test.js  # 96 shots/s burst
//   k6 run -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod -e SCENARIO=stress  k6-load-test.js  # breaking-point ramp
//   k6 run -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod --out json=results.json k6-load-test.js
//
// Required env vars:
//   INTERNAL_API_KEY  Bearer token for identity / query / stats / metrics endpoints.
//                     Must match INTERNAL_API_KEY in .env (min 32 chars).
//                     The service returns 401 on all query paths if this is wrong.
//
// Optional env vars:
//   BASE_URL          (default: http://localhost:3000)
//   SCENARIO          smoke | nft | peak | load | stress  (default: load)
//
// Prerequisites:
//   docker compose up -d          # postgres + redis + api + 2 × worker
//   THROTTLE_ENABLED=false        # set in .env or docker-compose env — prevents
//                                 # single-IP throttle bucket exhaustion from k6 VUs

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SCENARIO  = __ENV.SCENARIO  || 'load';
const V1        = `${BASE_URL}/v1`;

const INTERNAL_API_KEY = __ENV.INTERNAL_API_KEY || '';

// Canonical user ID — must be exactly 26 chars (ULID alphabet).
const CANONICAL_USER_ID = '01JVLOADTEST000000000000A1';

// Identity link pool — 10 distinct trackpro vendor_user_ids, all pre-linked in setup().
// Each VU picks one by (VU index mod 10), so at peak (120 VUs) each row gets ~12
// concurrent writers instead of all 120 serialising on the same row.
// In production, distinct customers write distinct rows — this distributes contention
// the same way.
const IDENTITY_LINK_POOL_SIZE = 10;
const IDENTITY_LINK_POOL = Array.from(
  { length: IDENTITY_LINK_POOL_SIZE },
  (_, i) => `load-test-pool-${i}`,
);

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const ingestSuccessRate = new Rate('ingest_success_rate');
const identityOpSuccess = new Rate('identity_op_success');
const queryLatency      = new Trend('query_latency_ms',    true);
const identityLatency   = new Trend('identity_latency_ms', true);

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const scenarios = {
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '30s',
  },

  // NFR: minimum 32 shots/sec sustained, sub-1s queryability.
  // Each iteration posts 3 shots (TrackPro + SwingMetric + ProSwing) →
  // 16 iter/s = 48 shots/s floor. Ramps through 64 → 96 → 128+ shots/s
  // to reveal where the system saturates beyond the NFR floor.
  nft: {
    executor: 'ramping-arrival-rate',
    startRate: 16,           // floor: 16 iter/s × 3 shots = 48 shots/s
    timeUnit: '1s',
    preAllocatedVUs: 30,
    maxVUs: 150,
    stages: [
      { duration: '1m', target: 16 },  // hold floor  — 48 shots/s  (NFR gate)
      { duration: '1m', target: 32 },  // ramp 2×     — 96 shots/s
      { duration: '1m', target: 48 },  // ramp 3×     — 144 shots/s
      { duration: '1m', target: 64 },  // ramp 4×     — 192 shots/s
      { duration: '1m', target: 16 },  // cool-down   — back to floor, observe recovery
    ],
  },

  // Peak burst — constant 3× average for 1 minute.
  peak: {
    executor: 'constant-arrival-rate',
    rate: 48,              // 48 iter/s × 3 = 144 shots/s
    timeUnit: '1s',
    duration: '1m',
    preAllocatedVUs: 40,
    maxVUs: 120,
  },

  // Busy Saturday morning — 200 concurrent launch monitors
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0  },
    ],
  },

  // Find the breaking point
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 100 },
      { duration: '3m', target: 200 },
      { duration: '2m', target: 100 },
      { duration: '2m', target: 0   },
    ],
  },
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

// At peak (3× sustained load, 144 shots/s) latency budgets are relaxed.
// The NFR floor is 32 shots/s; peak intentionally exceeds it and SLA degradation
// is expected. All other scenarios use the tighter NFR-aligned budgets.
const isPeak   = SCENARIO === 'peak';
// Stress intentionally drives past MAX_QUEUE_DEPTH — 503 backpressure responses
// are expected and correct. Allow up to 10% errors in stress mode.
const isStress = SCENARIO === 'stress';

export const options = {
  scenarios: {
    [SCENARIO]: scenarios[SCENARIO],
  },
  thresholds: {
    // Overall P95/P99 in the load scenario
    'http_req_duration{scenario:load}': ['p(95)<500', 'p(99)<1000'],

    // Per-endpoint latency budgets — tighter at NFR load, relaxed at peak/stress
    'http_req_duration{name:ingest_trackpro}':       [(isPeak || isStress) ? 'p(95)<500' : 'p(95)<300'],
    'http_req_duration{name:ingest_swingmetric}':    [(isPeak || isStress) ? 'p(95)<500' : 'p(95)<300'],
    'http_req_duration{name:ingest_proswing}':       [(isPeak || isStress) ? 'p(95)<500' : 'p(95)<300'],
    'http_req_duration{name:query_stats_canonical}': [(isPeak || isStress) ? 'p(95)<1200' : 'p(95)<800'],
    'http_req_duration{name:query_stats_vendor}':    [(isPeak || isStress) ? 'p(95)<1200' : 'p(95)<800'],
    'http_req_duration{name:identity_list}':         [(isPeak || isStress) ? 'p(95)<500'  : 'p(95)<200'],
    'http_req_duration{name:identity_link}':         [(isPeak || isStress) ? 'p(95)<700'  : 'p(95)<200'],

    // Error-rate gates — stress allows up to 10% (503 backpressure is expected/correct)
    http_req_failed:     [isStress ? 'rate<0.10' : 'rate<0.01'],
    ingest_success_rate: [isStress ? 'rate>0.90' : 'rate>0.99'],
    identity_op_success: [isStress ? 'rate>0.90' : 'rate>0.99'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

// Always returns exactly 8 lowercase hex chars
function randomHex8() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const QUERY_HEADERS = INTERNAL_API_KEY
  ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${INTERNAL_API_KEY}` }
  : { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Payload builders — one per vendor
// ---------------------------------------------------------------------------

function trackproPayload(userExternalId) {
  return JSON.stringify({
    shot_uid:            `tp-${todayStr()}-${randomHex8()}`,
    user_external_id:    userExternalId || 'load-test-user',
    session_id:          'sess-load-test',
    device_id:           'tp-device-LOAD',
    captured_at:         new Date().toISOString(),
    club:                '7i',
    ball_speed_mps:      parseFloat(rand(45,  80).toFixed(2)),
    club_head_speed_mps: parseFloat(rand(30,  55).toFixed(2)),
    launch_angle_deg:    parseFloat(rand(8,   25).toFixed(2)),
    spin_rpm:            randInt(3000, 7500),
    carry_distance_m:    parseFloat(rand(100, 300).toFixed(1)),
    total_distance_m:    parseFloat(rand(110, 320).toFixed(1)),
    side_deviation_m:    parseFloat(rand(-15,  15).toFixed(2)),
  });
}

function swingmetricPayload(playerId) {
  return JSON.stringify({
    session_id: `sm-sess-load-${__VU}`,
    player:     { id: playerId || 'sm-load-test-user' },
    device:     'SWING_PRO_LOAD',
    shots: [{
      ts_ms:           Date.now() - randInt(0, 5000),
      club_used:       '7i',
      ball_speed_mph:  parseFloat(rand(100, 178).toFixed(1)),
      swing_speed_mph: parseFloat(rand(65,  122).toFixed(1)),
      launch_deg:      parseFloat(rand(8,    25).toFixed(1)),
      spin_rpm:        randInt(3000, 7500),
      carry_yds:       randInt(110, 330),
      total_yds:       randInt(120, 350),
      offline_yds:     parseFloat(rand(-16, 16).toFixed(1)),
    }],
  });
}

function proswingPayload(userToken) {
  return JSON.stringify({
    type: 'shot.recorded',
    data: {
      user_token: userToken || 'ps-load-test-user',
      shot: {
        id:          `ps-${todayStr()}-${randomHex8()}`,
        occurred_at: new Date().toISOString(),
        club_code:   '7i',
        ball_speed:  { value: parseFloat(rand(100, 178).toFixed(1)), unit: 'mph' },
        club_speed:  { value: parseFloat(rand(65,  122).toFixed(1)), unit: 'mph' },
        launch:      { value: parseFloat(rand(8,    25).toFixed(1)), unit: 'deg' },
        carry:       { value: randInt(110, 330),                     unit: 'yd'  },
        total:       { value: randInt(120, 350),                     unit: 'yd'  },
        deviation:   { value: parseFloat(rand(-16, 16).toFixed(1)),  unit: 'yd'  },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// setup() — seed shots + identity mappings before VUs start
// ---------------------------------------------------------------------------

export function setup() {
  const clubs = ['driver', '7i', '5i', 'PW'];

  // Seed 20 TrackPro shots
  for (let i = 0; i < 20; i++) {
    const body = JSON.stringify({
      shot_uid:            `tp-${todayStr()}-${randomHex8()}`,
      user_external_id:    'load-test-user',
      session_id:          'sess-seed',
      device_id:           'tp-device-SEED',
      captured_at:         new Date(Date.now() - i * 60000).toISOString(),
      club:                clubs[i % clubs.length],
      ball_speed_mps:      parseFloat(rand(45,  80).toFixed(2)),
      club_head_speed_mps: parseFloat(rand(30,  55).toFixed(2)),
      launch_angle_deg:    parseFloat(rand(8,   25).toFixed(2)),
      spin_rpm:            randInt(3000, 7500),
      carry_distance_m:    parseFloat(rand(100, 300).toFixed(1)),
      total_distance_m:    parseFloat(rand(110, 320).toFixed(1)),
      side_deviation_m:    parseFloat(rand(-15,  15).toFixed(2)),
    });
    const res = http.post(`${V1}/webhooks/trackpro`, body, { headers: JSON_HEADERS });
    if (res.status !== 202) {
      console.warn(`[setup] TrackPro seed ${i} → ${res.status}: ${res.body}`);
    }
  }

  // Seed 10 SwingMetric shots
  for (let i = 0; i < 10; i++) {
    const body = JSON.stringify({
      session_id: `sm-sess-seed-${i}`,
      player:     { id: 'sm-load-test-user' },
      device:     'SWING_PRO_SEED',
      shots: [{
        ts_ms:           Date.now() - i * 30000,
        club_used:       'Driver',
        ball_speed_mph:  parseFloat(rand(140, 178).toFixed(1)),
        swing_speed_mph: parseFloat(rand(90,  122).toFixed(1)),
        launch_deg:      parseFloat(rand(8,    14).toFixed(1)),
        spin_rpm:        randInt(2000, 3500),
        carry_yds:       randInt(230, 300),
        total_yds:       randInt(250, 330),
        offline_yds:     parseFloat(rand(-10, 10).toFixed(1)),
      }],
    });
    const res = http.post(`${V1}/webhooks/swingmetric`, body, { headers: JSON_HEADERS });
    if (res.status !== 202) {
      console.warn(`[setup] SwingMetric seed ${i} → ${res.status}: ${res.body}`);
    }
  }

  // Seed 10 ProSwing shots
  for (let i = 0; i < 10; i++) {
    const body = JSON.stringify({
      type: 'shot.recorded',
      data: {
        user_token: 'ps-load-test-user',
        shot: {
          id:          `ps-${todayStr()}-${randomHex8()}`,
          occurred_at: new Date(Date.now() - i * 45000).toISOString(),
          club_code:   clubs[i % clubs.length],
          ball_speed:  { value: parseFloat(rand(100, 178).toFixed(1)), unit: 'mph' },
          club_speed:  { value: parseFloat(rand(65,  122).toFixed(1)), unit: 'mph' },
          launch:      { value: parseFloat(rand(8,    25).toFixed(1)), unit: 'deg' },
          carry:       { value: randInt(110, 330),                     unit: 'yd'  },
          total:       { value: randInt(120, 350),                     unit: 'yd'  },
          deviation:   { value: parseFloat(rand(-16, 16).toFixed(1)),  unit: 'yd'  },
        },
      },
    });
    const res = http.post(`${V1}/webhooks/proswing`, body, { headers: JSON_HEADERS });
    if (res.status !== 202) {
      console.warn(`[setup] ProSwing seed ${i} → ${res.status}: ${res.body}`);
    }
  }

  // Wait for the async worker to process the seeded shots
  sleep(3);

  // Register identity mappings — idempotent upsert, always returns 201
  const vendors = [
    { vendor: 'trackpro',    vendor_user_id: 'load-test-user'    },
    { vendor: 'swingmetric', vendor_user_id: 'sm-load-test-user' },
    { vendor: 'proswing',    vendor_user_id: 'ps-load-test-user' },
  ];

  for (const v of vendors) {
    const res = http.post(
      `${V1}/users/${CANONICAL_USER_ID}/identities`,
      JSON.stringify(v),
      { headers: QUERY_HEADERS },
    );
    if (res.status !== 201) {
      console.warn(`[setup] ${v.vendor} identity link → ${res.status}: ${res.body}`);
    }
  }

  // Pre-link all pool identities so default() Step 5 only does no-op UPDATEs.
  // At peak (120 VUs), each pool row sees ~12 concurrent writers instead of all
  // 120 serialising on the same row — matching how distinct customers behave in prod.
  for (const vendorUserId of IDENTITY_LINK_POOL) {
    const res = http.post(
      `${V1}/users/${CANONICAL_USER_ID}/identities`,
      JSON.stringify({ vendor: 'trackpro', vendor_user_id: vendorUserId }),
      { headers: QUERY_HEADERS },
    );
    if (res.status !== 201) {
      console.warn(`[setup] pool identity ${vendorUserId} → ${res.status}: ${res.body}`);
    }
  }

  console.log(
    `[setup] done — canonical user ${CANONICAL_USER_ID} linked to ` +
    `trackpro/load-test-user, swingmetric/sm-load-test-user, proswing/ps-load-test-user, ` +
    `and ${IDENTITY_LINK_POOL_SIZE} pool identities (load-test-pool-0…${IDENTITY_LINK_POOL_SIZE - 1})`,
  );
}

// ---------------------------------------------------------------------------
// Default function — full "ingest → identity → query" journey
// ---------------------------------------------------------------------------

export default function () {

  // ── Step 1: Ingest TrackPro shot ──────────────────────────────────────────
  const tpRes = http.post(
    `${V1}/webhooks/trackpro`,
    trackproPayload('load-test-user'),
    { headers: JSON_HEADERS, tags: { name: 'ingest_trackpro' } },
  );
  const tpOk = check(tpRes, {
    'TrackPro ingest: status 202': (r) => r.status === 202,
    'TrackPro ingest: status=accepted': (r) => {
      try { return JSON.parse(r.body).status === 'accepted'; } catch (_) { return false; }
    },
  });
  ingestSuccessRate.add(tpOk);

  sleep(0.1);

  // ── Step 2: Ingest SwingMetric shot ───────────────────────────────────────
  const smRes = http.post(
    `${V1}/webhooks/swingmetric`,
    swingmetricPayload('sm-load-test-user'),
    { headers: JSON_HEADERS, tags: { name: 'ingest_swingmetric' } },
  );
  const smOk = check(smRes, {
    'SwingMetric ingest: status 202': (r) => r.status === 202,
    'SwingMetric ingest: status=accepted': (r) => {
      try { return JSON.parse(r.body).status === 'accepted'; } catch (_) { return false; }
    },
  });
  ingestSuccessRate.add(smOk);

  sleep(0.1);

  // ── Step 3: Ingest ProSwing shot ──────────────────────────────────────────
  const psRes = http.post(
    `${V1}/webhooks/proswing`,
    proswingPayload('ps-load-test-user'),  // V1 format: data.user_token (V3 uses data.player.id)
    { headers: JSON_HEADERS, tags: { name: 'ingest_proswing' } },
  );
  const psOk = check(psRes, {
    'ProSwing ingest: status 202': (r) => r.status === 202,
    'ProSwing ingest: status=accepted': (r) => {
      try { return JSON.parse(r.body).status === 'accepted'; } catch (_) { return false; }
    },
  });
  ingestSuccessRate.add(psOk);

  sleep(0.1);

  // ── Step 4: List identities for canonical user ────────────────────────────
  const idListStart = Date.now();
  const idListRes = http.get(
    `${V1}/users/${CANONICAL_USER_ID}/identities`,
    { headers: QUERY_HEADERS, tags: { name: 'identity_list' } },
  );
  identityLatency.add(Date.now() - idListStart);
  const idListOk = check(idListRes, {
    'Identity list: status 200':       (r) => r.status === 200,
    'Identity list: returns array':    (r) => {
      try { return Array.isArray(JSON.parse(r.body)); } catch (_) { return false; }
    },
    'Identity list: has ≥3 vendors':   (r) => {
      try { return JSON.parse(r.body).length >= 3; } catch (_) { return false; }
    },
    'Identity list: all vendors present': (r) => {
      try {
        const vs = JSON.parse(r.body).map((v) => v.vendor);
        return vs.includes('trackpro') && vs.includes('swingmetric') && vs.includes('proswing');
      } catch (_) { return false; }
    },
  });
  identityOpSuccess.add(idListOk);

  sleep(0.1);

  // ── Step 5: Idempotent identity re-link (exercises write path under load) ─
  // Each VU picks a different pool row so 120 VUs distribute ~12 writers per row
  // rather than all serialising on the same DB row.
  const poolVendorUserId = IDENTITY_LINK_POOL[(__VU - 1) % IDENTITY_LINK_POOL_SIZE];
  const idLinkStart = Date.now();
  const idLinkRes = http.post(
    `${V1}/users/${CANONICAL_USER_ID}/identities`,
    JSON.stringify({ vendor: 'trackpro', vendor_user_id: poolVendorUserId }),
    { headers: QUERY_HEADERS, tags: { name: 'identity_link' } },
  );
  identityLatency.add(Date.now() - idLinkStart);
  const idLinkOk = check(idLinkRes, {
    'Identity link: status 201': (r) => r.status === 201,
    'Identity link: canonical_user_id matches': (r) => {
      try { return JSON.parse(r.body).canonical_user_id === CANONICAL_USER_ID; } catch (_) { return false; }
    },
    'Identity link: vendor is trackpro': (r) => {
      try { return JSON.parse(r.body).vendor === 'trackpro'; } catch (_) { return false; }
    },
  });
  identityOpSuccess.add(idLinkOk);

  sleep(0.1);

  // ── Step 6: Shots by canonical user (cross-vendor unified view) ───────────
  const canonShotsStart = Date.now();
  const canonShotsRes = http.get(
    `${V1}/users/${CANONICAL_USER_ID}/shots?limit=10`,
    { headers: QUERY_HEADERS, tags: { name: 'query_shots_canonical' } },
  );
  queryLatency.add(Date.now() - canonShotsStart);
  check(canonShotsRes, {
    'Canonical shots: status 200': (r) => r.status === 200,
    'Canonical shots: has data array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).data); } catch (_) { return false; }
    },
    'Canonical shots: has paging.has_more': (r) => {
      try { return typeof JSON.parse(r.body).paging?.has_more === 'boolean'; } catch (_) { return false; }
    },
    'Canonical shots: has meta': (r) => {
      try { return JSON.parse(r.body).meta != null; } catch (_) { return false; }
    },
    'Canonical shots: shots have canonical_user_id': (r) => {
      try {
        const data = JSON.parse(r.body).data;
        return data.length === 0 || data[0].canonical_user_id === CANONICAL_USER_ID;
      } catch (_) { return false; }
    },
  });

  sleep(0.1);

  // ── Step 7: Shots by vendor user (vendor-scoped view) ─────────────────────
  const vendorShotsStart = Date.now();
  const vendorShotsRes = http.get(
    `${V1}/users/by-vendor/trackpro/load-test-user/shots?limit=10`,
    { headers: QUERY_HEADERS, tags: { name: 'query_shots_vendor' } },
  );
  queryLatency.add(Date.now() - vendorShotsStart);
  check(vendorShotsRes, {
    'Vendor shots: status 200': (r) => r.status === 200,
    'Vendor shots: has data array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).data); } catch (_) { return false; }
    },
    'Vendor shots: has paging': (r) => {
      try { return typeof JSON.parse(r.body).paging?.has_more === 'boolean'; } catch (_) { return false; }
    },
  });

  sleep(0.1);

  // ── Step 8: Stats by canonical user ───────────────────────────────────────
  const canonStatsStart = Date.now();
  const canonStatsRes = http.get(
    `${V1}/users/${CANONICAL_USER_ID}/stats`,
    { headers: QUERY_HEADERS, tags: { name: 'query_stats_canonical' } },
  );
  queryLatency.add(Date.now() - canonStatsStart);
  check(canonStatsRes, {
    'Canonical stats: status 200': (r) => r.status === 200,
    'Canonical stats: has by_club array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).by_club); } catch (_) { return false; }
    },
    'Canonical stats: has window': (r) => {
      try { const w = JSON.parse(r.body).window; return w?.since != null && w?.until != null; } catch (_) { return false; }
    },
  });

  sleep(0.1);

  // ── Step 9: Stats by vendor user (with club filter to exercise param path) ─
  const vendorStatsStart = Date.now();
  const vendorStatsRes = http.get(
    `${V1}/users/by-vendor/trackpro/load-test-user/stats?club=7I`,
    { headers: QUERY_HEADERS, tags: { name: 'query_stats_vendor' } },
  );
  queryLatency.add(Date.now() - vendorStatsStart);
  check(vendorStatsRes, {
    'Vendor stats: status 200': (r) => r.status === 200,
    'Vendor stats: has by_club array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).by_club); } catch (_) { return false; }
    },
  });

  sleep(0.1);

  // ── Step 10: Healthz ──────────────────────────────────────────────────────
  const healthRes = http.get(`${BASE_URL}/healthz`, { tags: { name: 'healthz' } });
  check(healthRes, {
    'Healthz: status 200': (r) => r.status === 200,
    'Healthz: status=ok':  (r) => {
      try { return JSON.parse(r.body).status === 'ok'; } catch (_) { return false; }
    },
  });

  // Realistic inter-iteration think time
  sleep(rand(0.1, 0.5));
}

// ---------------------------------------------------------------------------
// teardown() — remove identity mappings created by setup()
// ---------------------------------------------------------------------------

export function teardown() {
  const DELETE_HEADERS = INTERNAL_API_KEY
    ? { 'Authorization': `Bearer ${INTERNAL_API_KEY}` }
    : {};

  const vendors = [
    { vendor: 'trackpro',    vendor_user_id: 'load-test-user'    },
    { vendor: 'swingmetric', vendor_user_id: 'sm-load-test-user' },
    { vendor: 'proswing',    vendor_user_id: 'ps-load-test-user' },
  ];
  for (const v of vendors) {
    const res = http.del(
      `${V1}/users/${CANONICAL_USER_ID}/identities/${v.vendor}/${v.vendor_user_id}`,
      null,
      { headers: DELETE_HEADERS },
    );
    if (res.status !== 204) {
      console.warn(`[teardown] ${v.vendor} identity unlink → ${res.status}`);
    }
  }

  // Remove all pool identities seeded in setup()
  for (const vendorUserId of IDENTITY_LINK_POOL) {
    const res = http.del(
      `${V1}/users/${CANONICAL_USER_ID}/identities/trackpro/${vendorUserId}`,
      null,
      { headers: DELETE_HEADERS },
    );
    if (res.status !== 204) {
      console.warn(`[teardown] pool identity trackpro/${vendorUserId} → ${res.status}`);
    }
  }

  console.log(
    `[teardown] removed 3 seed + ${IDENTITY_LINK_POOL_SIZE} pool identity mappings for ${CANONICAL_USER_ID}`,
  );
}
