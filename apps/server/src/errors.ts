import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AuditCursorError, AuditMetaError } from './audit/audit.js';

/** Approval links are capabilities: never log the token part of /approve/<token> or /api/approve/<token>/…. */
export function redactApproveUrl(url: string): string {
  return url.replace(/\/(api\/)?approve\/[^/?#]+/g, (_m, api: string | undefined) => `/${api ?? ''}approve/[REDACTED]`);
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
    /** Extra response fields (error codes only — never values). */
    readonly details?: Record<string, string>,
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

/** RFC 6749 §5.2 style error: `{ error, error_description? }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description?: string,
    readonly statusCode = 400,
  ) {
    super(error);
    this.name = 'OAuthError';
  }
}

/** Error responses never echo request bodies or arbitrary error messages. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof OAuthError) {
      return reply
        .status(err.statusCode)
        .header('cache-control', 'no-store')
        .send(err.description ? { error: err.error, error_description: err.description } : { error: err.error });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ ...err.details, error: err.code });
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
    req.log.error({ errName: err.name, url: redactApproveUrl(req.url) }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));
}
