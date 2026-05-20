import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const correlationId =
      (req.headers as Record<string, string | undefined>)['x-correlation-id'] ??
      (req.id as string | undefined) ??
      randomUUID();

    // Ensure correlation ID is on both request and response
    (req.headers as Record<string, string>)['x-correlation-id'] = correlationId;
    void reply.header('x-correlation-id', correlationId);

    return next.handle();
  }
}
