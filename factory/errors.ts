// A failed HTTP call to a tracker or code host. The message names the status and endpoint, never the token.
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const isNotFound = (e: unknown) => e instanceof HttpError && e.status === 404;

// An error as short text for a log line or a comment.
export const errText = (e: unknown, n = 300) => String(e).slice(0, n);
