import type { FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication is required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You are not allowed to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (resource: string) =>
  new AppError(404, 'NOT_FOUND', `${resource} was not found`);
export const conflict = (code: string, message: string) =>
  new AppError(409, code, message);

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const validation = typeof error === 'object' && error !== null && 'validation' in error
      ? error.validation
      : undefined;
    const errorMessage = error instanceof Error ? error.message : 'Request validation failed';
    const appError = error instanceof AppError
      ? error
      : validation
        ? badRequest('VALIDATION_ERROR', errorMessage, { validation })
        : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');

    if (appError.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    }

    return reply.status(appError.statusCode).send({
      code: appError.code,
      message: appError.message,
      details: appError.details,
      requestId: request.id,
    });
  });
}
