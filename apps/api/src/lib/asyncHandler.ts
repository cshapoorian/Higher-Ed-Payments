import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejections thrown by an async route handler —
 * they become an unhandled promise rejection, which by default crashes the
 * entire Node process (not just the one request). Every route in this API
 * is async (Prisma + Hyperswitch calls), so every route must be wrapped in
 * this to route failures to Express's error handler instead of taking the
 * whole server down. See the error-handling middleware in index.ts.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Final Express error-handling middleware (4-arg signature is what makes
 * Express treat this as one). Catches whatever asyncHandler forwards via
 * next(err) and returns a clean 500 instead of letting the error escape as
 * an unhandled rejection, which crashes the whole process — see
 * asyncHandler's comment above.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_server_error" });
};
