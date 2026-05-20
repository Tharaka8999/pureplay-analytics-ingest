import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError, domainErrorToHttp } from "./errors/domain-errors";

/**
 * RFC 9457 Problem Details response body (extended with `error_code`).
 * https://datatracker.ietf.org/doc/html/rfc9457
 *
 * `error_code` is a custom extension field (RFC 9457 §3.2 allows extensions).
 * It carries the UPPER_SNAKE_CASE code that clients pattern-match on, while
 * `type` carries the canonical machine-readable URI for RFC 9457 consumers.
 */
interface ProblemDetails {
  type: string; // urn:problem:<error_code_kebab>
  error_code: string; // UPPER_SNAKE_CASE code — custom RFC 9457 extension
  title: string; // human-readable summary
  status: number; // HTTP status code
  detail?: string; // additional context
  correlation_id: string; // trace ID for support
  issues?: Array<{ path: string; code: string; message: string }>;
}

@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const correlationId =
      (request.headers as Record<string, string | undefined>)[
        "x-correlation-id"
      ] ??
      request.id ??
      "unknown";

    // ── Domain errors (thrown from service/domain layer) ──────────────────────
    if (exception instanceof DomainError) {
      const { status, errorCode } = domainErrorToHttp(exception);
      if (status >= 500) {
        this.logger.error(
          { correlation_id: correlationId, err: exception },
          exception.message,
        );
      } else {
        this.logger.warn(
          { correlation_id: correlationId, error_code: errorCode },
          exception.message,
        );
      }
      void reply
        .status(status)
        .send(
          buildProblem(status, errorCode, exception.message, correlationId),
        );
      return;
    }

    // ── NestJS HTTP exceptions ────────────────────────────────────────────────
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      let errorCode = mapStatusToCode(status);
      let title = "An error occurred.";
      let issues: ProblemDetails["issues"];

      if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        if (resp["error_code"]) errorCode = resp["error_code"] as string;
        if (resp["message"]) title = resp["message"] as string;
        if (resp["issues"]) issues = resp["issues"] as ProblemDetails["issues"];
      } else if (typeof exceptionResponse === "string") {
        title = exceptionResponse;
      }

      const retryAfter =
        typeof exceptionResponse === "object" && exceptionResponse !== null
          ? ((exceptionResponse as Record<string, unknown>)["retryAfter"] as
              | number
              | undefined)
          : undefined;

      if (status >= 500) {
        this.logger.error(
          { correlation_id: correlationId, err: exception },
          "HTTP error",
        );
      } else {
        this.logger.warn(
          { correlation_id: correlationId, error_code: errorCode },
          title,
        );
      }

      if (retryAfter !== undefined) {
        void reply.header("Retry-After", String(retryAfter));
      }

      const body = buildProblem(
        status,
        errorCode,
        title,
        correlationId,
        issues,
      );
      void reply.status(status).send(body);
      return;
    }

    // ── Unhandled exception — never expose internals ──────────────────────────
    this.logger.error(
      { correlation_id: correlationId, err: exception },
      "Unhandled exception",
    );
    void reply
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .send(
        buildProblem(
          500,
          "INTERNAL_ERROR",
          "An unexpected error occurred.",
          correlationId,
        ),
      );
  }
}

function buildProblem(
  status: number,
  errorCode: string,
  title: string,
  correlationId: string,
  issues?: ProblemDetails["issues"],
): ProblemDetails {
  const body: ProblemDetails = {
    type: `urn:problem:${errorCode.toLowerCase().replace(/_/g, "-")}`,
    error_code: errorCode,
    title,
    status,
    correlation_id: correlationId,
  };
  if (issues) body.issues = issues;
  return body;
}

function mapStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return "PAYLOAD_VALIDATION_FAILED";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL_ERROR";
  }
}
