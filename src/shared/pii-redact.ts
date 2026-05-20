// PII blocklist — field paths to redact before writing to ingestion_failures.raw_body.
// Add new paths here; never remove (audit trail).
// 'player.email'          — TrackPro top-level player object
// 'envelope.player.email' — SwingMetric envelope wrapper
// 'user_token'            — ProSwing top-level token
// 'data.user_token'       — ProSwing data-nested token
const BLOCKED_PATHS = [
  'player.email',
  'envelope.player.email',
  'user_token',
  'data.user_token',
] as const;

// RFC5322-simplified email regex — catches the vast majority of real addresses.
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function deleteNestedPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current === null || typeof current !== 'object') return;
    current = (current as Record<string, unknown>)[part];
  }

  if (current !== null && typeof current === 'object') {
    const lastPart = parts[parts.length - 1]!;
    delete (current as Record<string, unknown>)[lastPart];
  }
}

export function redactPii(payload: Record<string, unknown>): string {
  // Deep clone to avoid mutating the original
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  // Remove known PII field paths
  for (const path of BLOCKED_PATHS) {
    deleteNestedPath(clone, path);
  }

  // Scrub any remaining email addresses from the serialised string
  const json = JSON.stringify(clone);
  return json.replace(EMAIL_REGEX, '[REDACTED]');
}
