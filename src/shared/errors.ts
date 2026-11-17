/**
 * Business error with a stable code. The API always answers errors as
 * { "error": { "code": "...", "message": "..." } } and apps translate codes to FR/EN.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404),
  unauthorized: () => new AppError('UNAUTHORIZED', 'Missing or invalid credentials', 401),
  forbidden: () => new AppError('FORBIDDEN', 'You are not allowed to do this', 403),
  conflict: (message: string) => new AppError('CONFLICT', message, 409),
};
