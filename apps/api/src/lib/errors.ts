export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'リソース') => new AppError(404, 'NOT_FOUND', `${what}が見つかりません`);
