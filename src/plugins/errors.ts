import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError } from '../shared/errors.js';

/** One error format for the whole API: { error: { code, message } } */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );
}
