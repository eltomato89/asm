import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AuditCursorError, AuditMetaError } from './audit/audit.js';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export class ValidationError extends Error {
  constructor(readonly code = 'invalid_request') {
    super(code);
    this.name = 'ValidationError';
  }
}

/** Error responses never echo request bodies or arbitrary error messages. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'invalid_request' });
    if (err instanceof ValidationError) return reply.status(400).send({ error: err.code });
    if (err instanceof AuditCursorError) return reply.status(400).send({ error: 'invalid_cursor' });
    if (err instanceof AuditMetaError) return reply.status(400).send({ error: 'invalid_meta' });
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Framework-level client errors (bad JSON, payload too large, ...): code only.
      const code = status === 429 ? 'rate_limited' : ((err as FastifyError).code ?? 'bad_request').toLowerCase();
      return reply.status(status).send({ error: code });
    }
    req.log.error({ errName: err.name, url: req.url }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));
}
