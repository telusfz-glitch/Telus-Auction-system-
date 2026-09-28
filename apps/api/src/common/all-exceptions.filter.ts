import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/** Clients never see stack traces, SQL errors or internals — only a correlation id that
 *  support can match to the server log. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    // Socket handlers answer via acks and never throw by design; anything else is logged, never sent.
    if (host.getType() !== 'http') {
      this.logger.error(`[${host.getType()}]`, exception instanceof Error ? exception.stack : String(exception));
      return;
    }
    const http = host.switchToHttp();
    const res = http.getResponse();
    const req = http.getRequest();
    const correlationId = randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body, correlationId } : { ...(body as object), correlationId });
      return;
    }
    this.logger.error(`[${correlationId}] ${req.method} ${req.path}`, exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ statusCode: 500, message: 'Something went wrong. Please try again.', correlationId });
  }
}
