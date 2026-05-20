import { Counter, Histogram, Gauge, register } from "prom-client";

// Lazy singleton — safe to call multiple times (prom-client deduplicates by name).
let _shotsTotal: Counter | undefined;
let _e2eLag: Histogram | undefined;
let _nearDuplicates: Counter | undefined;
let _queueDepth: Gauge | undefined;
let _jobsFailed: Counter | undefined;
let _authFailures: Counter | undefined;

export function getShotsTotal(): Counter {
  if (!_shotsTotal) {
    try {
      _shotsTotal = new Counter({
        name: "pureplay_ingest_shots_total",
        help: "Ingest funnel counts",
        labelNames: ["vendor", "outcome", "parser_version"] as const,
      });
    } catch {
      // Already registered — retrieve existing
      _shotsTotal = register.getSingleMetric(
        "pureplay_ingest_shots_total",
      ) as Counter;
    }
  }
  return _shotsTotal;
}

export function getE2eLag(): Histogram {
  if (!_e2eLag) {
    try {
      _e2eLag = new Histogram({
        name: "pureplay_ingest_e2e_lag_ms",
        help: "Lag from received_at_utc to DB row visible (ms)",
        labelNames: ["vendor"] as const,
        buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
      });
    } catch {
      _e2eLag = register.getSingleMetric(
        "pureplay_ingest_e2e_lag_ms",
      ) as Histogram;
    }
  }
  return _e2eLag;
}

export function getNearDuplicates(): Counter {
  if (!_nearDuplicates) {
    try {
      _nearDuplicates = new Counter({
        name: "pureplay_ingest_near_duplicates_total",
        help: "Near-duplicate detections (duplicate_of set)",
        labelNames: ["vendor"] as const,
      });
    } catch {
      _nearDuplicates = register.getSingleMetric(
        "pureplay_ingest_near_duplicates_total",
      ) as Counter;
    }
  }
  return _nearDuplicates;
}

export function getQueueDepth(): Gauge {
  if (!_queueDepth) {
    try {
      _queueDepth = new Gauge({
        name: "pureplay_ingest_queue_depth",
        help: "Current BullMQ waiting job count",
      });
    } catch {
      _queueDepth = register.getSingleMetric(
        "pureplay_ingest_queue_depth",
      ) as Gauge;
    }
  }
  return _queueDepth;
}

export function getJobsFailed(): Counter {
  if (!_jobsFailed) {
    try {
      _jobsFailed = new Counter({
        name: "pureplay_ingest_jobs_failed_total",
        help: "BullMQ jobs that failed all retry attempts (dead-lettered)",
        labelNames: ["vendor"] as const,
      });
    } catch {
      _jobsFailed = register.getSingleMetric(
        "pureplay_ingest_jobs_failed_total",
      ) as Counter;
    }
  }
  return _jobsFailed;
}

export function getAuthFailures(): Counter {
  if (!_authFailures) {
    try {
      _authFailures = new Counter({
        name: "pureplay_ingest_auth_failures_total",
        help: "Webhook authentication failures by vendor and mode",
        labelNames: ["vendor", "mode"] as const,
      });
    } catch {
      _authFailures = register.getSingleMetric(
        "pureplay_ingest_auth_failures_total",
      ) as Counter;
    }
  }
  return _authFailures;
}
