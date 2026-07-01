/**
 * Type declarations for `fkld/io.coffee`.
 *
 * Thin JSON transport: object ↔ text. Validation lives elsewhere (see
 * the per-step modules and the eventual Step-17 validate.coffee).
 */

/**
 * Serialize an FKLD object to JSON text with a trailing newline.
 * `indent` follows JSON.stringify's convention; default 2 spaces.
 */
export function serializeFkld(file: unknown, indent?: number | null): string;

/**
 * Parse an FKLD JSON payload. Throws SyntaxError on malformed JSON,
 * TypeError when the input is not a string.
 */
export function parseFkld(text: string): unknown;
