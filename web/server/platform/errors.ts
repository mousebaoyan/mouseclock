// Business errors; the global error handler turns them into `{ error: { code, message } }`
// (api.md §1): `code` for programs, `message` in Chinese for people.
export class AppError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429;
  readonly code: string;

  constructor(status: AppError["status"], code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}
