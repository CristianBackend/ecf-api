/**
 * CORS origin utilities.
 *
 * CORS_ORIGIN accepts a comma-separated list of allowed origins.
 * The HTTP spec requires Access-Control-Allow-Origin to contain EXACTLY ONE
 * origin (or '*').  We use a dynamic callback so NestJS reflects back the
 * caller's own origin when it matches, instead of echoing the whole list.
 *
 * Examples:
 *   '*'                                  → dev wildcard (allow everything)
 *   'https://app.example.com'            → single production origin
 *   'https://app.example.com,http://localhost:3000' → two origins
 */

/**
 * Parse the CORS_ORIGIN env var into a trimmed, non-empty array of origins.
 * Returns ['*'] when the value is absent/blank (development default).
 */
export function parseCorsOrigins(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return ['*'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Build the NestJS `origin` option for app.enableCors().
 *
 * - If the list contains '*', every request is allowed (dev convenience).
 * - Requests without an Origin header are always allowed (server-to-server,
 *   same-origin, curl).
 * - Otherwise only origins in the allow-list get a 200; the rest get a CORS
 *   error which the browser converts to a network error.
 */
export function buildCorsOriginOption(
  raw: string | undefined | null,
): (origin: string | undefined, callback: OriginCallback) => void {
  const allowed = parseCorsOrigins(raw);

  return (origin: string | undefined, callback: OriginCallback) => {
    // No Origin header → server-to-server / same-origin / curl → allow
    if (!origin) return callback(null, true);
    // Wildcard (dev/test) → allow any origin
    if (allowed.includes('*')) return callback(null, true);
    // Exact match → allow, reflecting the caller's own origin
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error(`Origin '${origin}' is not allowed by CORS policy`), false);
  };
}
