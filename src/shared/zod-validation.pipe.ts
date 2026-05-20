import { PipeTransform, Injectable, BadRequestException, ArgumentMetadata } from '@nestjs/common';
import type { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((e: { path: unknown[]; code: string; message: string }) => ({
        path: e.path.join('.'),
        code: e.code,
        message: e.message,
      }));
      throw new BadRequestException({
        error_code: 'PAYLOAD_VALIDATION_FAILED',
        message: 'Request payload validation failed.',
        issues,
      });
    }
    return result.data;
  }
}
