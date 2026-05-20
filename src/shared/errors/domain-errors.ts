/**
 * Domain Error Hierarchy
 *
 * Domain errors are plain classes with no HTTP knowledge.
 * They are thrown from service/domain layers and mapped to HTTP status codes
 * by GlobalExceptionFilter at the presentation boundary.
 *
 * Adding a new error:
 *   1. Extend DomainError with a unique `code`.
 *   2. Add a mapping row in domainErrorToHttp().
 *   3. Throw from the appropriate service.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Preserve stack trace across transpilation
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ── Validation errors ──────────────────────────────────────────────────────

export class InvalidCursorError extends DomainError {
  readonly code = "INVALID_CURSOR";
  constructor() {
    super("Pagination cursor is malformed or expired.");
  }
}

export class InvalidDateError extends DomainError {
  readonly code = "PAYLOAD_VALIDATION_FAILED";
  constructor(field: "since" | "until", value: string) {
    super(
      `Invalid date for '${field}': '${value}'. Must be a valid ISO-8601 datetime.`,
    );
  }
}

export class UnknownVendorError extends DomainError {
  readonly code = "PAYLOAD_VALIDATION_FAILED";
  constructor(vendor: string, validVendors: readonly string[]) {
    super(
      `Unknown vendor: ${vendor}. Valid values: ${validVendors.join(", ")}`,
    );
  }
}

export class UnknownClubCodeError extends DomainError {
  readonly code = "PAYLOAD_VALIDATION_FAILED";
  constructor(club: string, validCodes: readonly string[]) {
    super(`Unknown club code: ${club}. Valid values: ${validCodes.join(", ")}`);
  }
}

// ── Not-found errors ───────────────────────────────────────────────────────

export class IdentityNotFoundError extends DomainError {
  readonly code = "NOT_FOUND";
  constructor(vendor: string, vendorUserId: string, canonicalUserId: string) {
    super(
      `Identity mapping not found: ${vendor}/${vendorUserId} → ${canonicalUserId}`,
    );
  }
}

// ── HTTP status mapping ────────────────────────────────────────────────────

/** Maps a DomainError to its HTTP status code and canonical error_code string. */
export function domainErrorToHttp(err: DomainError): {
  status: number;
  errorCode: string;
} {
  switch (err.code) {
    case "INVALID_CURSOR":
    case "PAYLOAD_VALIDATION_FAILED":
      return { status: 400, errorCode: err.code };
    case "NOT_FOUND":
      return { status: 404, errorCode: "NOT_FOUND" };
    default:
      return { status: 500, errorCode: "INTERNAL_ERROR" };
  }
}
