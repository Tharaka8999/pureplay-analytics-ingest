import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { FastifyRequest, FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

// Cache identity-link responses for 24 hours.
// RFC 9562 / draft-ietf-httpapi-idempotency-key-header specifies no minimum TTL;
// 24h is a widely-adopted default for webhook-style idempotency windows.
const IDEMPOTENCY_CACHE_TTL_S = 86_400;

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

interface CachedResponse {
  status: number;
  body: unknown;
}

function buildCacheKey(key: string, path: string): string {
  return `idempotency:${path}:${key}`;
}

/**
 * Idempotency interceptor for state-mutating endpoints (POST identity link).
 *
 * Algorithm:
 *  1. Read the `Idempotency-Key` header. If absent, pass through (no enforcement).
 *  2. Look up the key in Redis. On a hit, replay the cached status + body.
 *  3. On a miss, execute the handler, cache the successful response, then return it.
 *
 * Only 2xx responses are cached — error responses are not idempotent by nature
 * (the client should fix the request and retry, not replay the error).
 *
 * Scope: keyed on (path, idempotency-key) so the same key on different endpoints
 * is treated as distinct operations.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Header absent — normal flow, no caching
    if (!idempotencyKey) {
      return next.handle();
    }

    const cacheKey = buildCacheKey(idempotencyKey, request.url);

    // Return an Observable that asynchronously checks Redis, then either replays
    // the cached response or delegates to the handler and caches the result.
    return new Observable((subscriber) => {
      this.redis.get(cacheKey)
        .then((cached) => {
          if (cached !== null) {
            // Cache hit — replay the stored response
            let parsed: CachedResponse;
            try {
              parsed = JSON.parse(cached) as CachedResponse;
            } catch {
              this.logger.warn({ cacheKey }, 'Idempotency cache entry is malformed — treating as miss');
              return this.executeAndCache(cacheKey, next, reply, subscriber);
            }

            reply.status(parsed.status);
            subscriber.next(parsed.body);
            subscriber.complete();
            return;
          }

          // Cache miss — execute handler
          this.executeAndCache(cacheKey, next, reply, subscriber);
        })
        .catch((err: unknown) => {
          // Redis unavailable — degrade gracefully; let the request through uncached
          this.logger.warn({ err, cacheKey }, 'Idempotency Redis lookup failed — degrading to pass-through');
          next.handle().subscribe(subscriber);
        });
    });
  }

  private executeAndCache(
    cacheKey: string,
    next: CallHandler,
    reply: FastifyReply,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscriber: any,
  ): void {
    next.handle()
      .pipe(
        tap({
          next: (body: unknown) => {
            // Cache only successful (2xx) responses
            const status: number = (reply as { statusCode?: number }).statusCode ?? 200;
            if (status >= 200 && status < 300) {
              const entry: CachedResponse = { status, body };
              this.redis
                .set(cacheKey, JSON.stringify(entry), 'EX', IDEMPOTENCY_CACHE_TTL_S)
                .catch((err: unknown) => {
                  this.logger.warn({ err, cacheKey }, 'Failed to write idempotency cache — response not cached');
                });
            }
          },
          error: (_err: unknown) => {
            // Errors are not cached — no-op here
          },
        }),
      )
      .subscribe(subscriber);
  }
}
