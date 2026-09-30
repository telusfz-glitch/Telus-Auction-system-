import { HttpException } from '@nestjs/common';

/** A deliberate, client-safe error: a stable machine-readable `code` plus a human message. */
export class ApiError extends HttpException {
  constructor(readonly code: string, message: string, status: number) {
    super({ statusCode: status, code, message }, status);
  }
}
