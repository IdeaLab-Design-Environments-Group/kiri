/**
 * Unified application error vocabulary (core layer — imports nothing).
 *
 * Every failure the UI can surface carries a `domain` so controllers, tests,
 * and future retry logic can branch on error *kind* instead of parsing
 * message strings. `PipelineError` (src/pipeline/types.ts) extends this with
 * its stage tag; parse/io/sim/create failures are wrapped at the catch site
 * via `toAppError`. `statusFromError` is the single bridge from any thrown
 * value into the AppStore status channel.
 */

export type ErrorDomain = "parse" | "pipeline" | "sim" | "io" | "create";

export class AppError extends Error {
  readonly domain: ErrorDomain;
  readonly details?: unknown;

  constructor(domain: ErrorDomain, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.domain = domain;
    this.details = details;
  }
}

/**
 * Normalize any thrown value into an AppError. Existing AppErrors (incl.
 * PipelineError) pass through untouched; bare errors are wrapped with the
 * fallback domain and an optional `prefix: ` on the message — formats chosen
 * to reproduce the exact status strings the UI showed before unification.
 */
export function toAppError(err: unknown, fallbackDomain: ErrorDomain, prefix?: string): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(fallbackDomain, prefix ? `${prefix}: ${message}` : message, err);
}

/** The single bridge from a thrown value into the AppStore status line. */
export function statusFromError(err: unknown, fallbackDomain: ErrorDomain = "io", prefix?: string): { msg: string; kind: "bad" } {
  return { msg: toAppError(err, fallbackDomain, prefix).message, kind: "bad" };
}
