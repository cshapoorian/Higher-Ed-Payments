import type { CorsOptions } from "cors";

/**
 * CORS_ORIGIN entries are normally exact origins, but Netlify deploy
 * previews and branch deploys get unpredictable per-deploy subdomains
 * (e.g. deploy-preview-12--your-site.netlify.app,
 * some-branch--your-site.netlify.app) that a fixed list can't enumerate.
 * An entry starting with "*" is matched as a suffix instead of exact-equal —
 * e.g. "*--your-site.netlify.app" allows any preview/branch deploy of that
 * specific site without opening CORS to all of netlify.app.
 */
function originMatches(pattern: string, origin: string): boolean {
  if (pattern.startsWith("*")) return origin.endsWith(pattern.slice(1));
  return pattern === origin;
}

export function corsOriginCheck(corsOrigin: string): CorsOptions["origin"] {
  const patterns = corsOrigin.split(",").map((o) => o.trim());
  return (origin, callback) => {
    // No Origin header (curl, server-to-server, same-origin) — not a
    // cross-origin browser request, so there's nothing for CORS to police.
    if (!origin) return callback(null, true);
    const allowed = patterns.some((pattern) => originMatches(pattern, origin));
    callback(allowed ? null : new Error(`Origin ${origin} not allowed by CORS_ORIGIN`), allowed);
  };
}
