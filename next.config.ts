import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * Bake the commit this build came from into the bundle.
 *
 * `/api/health` reports `releaseSha`, and the deploy gate compares it with the
 * released commit. Reading it only from the runtime environment meant a rebuild
 * without `RELEASE_SHA` exported reported `"unknown"` forever. Inlining it at
 * build time makes the value self-describing: the SHA belongs to the build, not
 * to whoever happened to restart PM2. `RELEASE_SHA` (if already set) wins, so a
 * CI build keeps its authoritative value.
 */
function buildSha(): string {
  const fromEnv = (process.env.RELEASE_SHA ?? process.env.GIT_SHA ?? "").trim();
  if (/^[0-9a-f]{40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  } catch {
    // Not a git checkout (tarball build): fall through to "unknown".
  }
  return "";
}

const releaseSha = buildSha();

const nextConfig: NextConfig = {
  // cPanel Note: standalone output is required for cPanel Node.js app.
  // The build copies .next/static + public into .next/standalone so
  // `node .next/standalone/server.js` works both locally and in cPanel containers.
  output: "standalone",
  // Only public build metadata — never a secret. (`__`-prefixed keys are
  // reserved by Next, hence the ALO_ prefix.)
  env: releaseSha ? { ALO_BUILD_SHA: releaseSha } : {},
  reactStrictMode: false,
  // Sharp is lazy-loaded (src/lib/image-processing.ts) and must stay out of the
  // server bundle so builds work on the x86-64-v1 VPS CPU (no SSE4.2).
  // tests/image-processing.test.mjs guards this line.
  serverExternalPackages: ["sharp"],
  // ── Keep the standalone artifact to what the server actually needs ───────
  // `src/lib/runtime-config.ts` reads its JSON with a computed path, so Next's
  // tracer conservatively includes the whole project root — the artifact grew to
  // ~271 MB and shipped `tests/`, `docs/`, `audit/`, `marketingos/` and the local
  // `storage/`/`upload/` media to production.
  //
  // Excluded here are only paths that the build or the deploy script copies in
  // its own, correct way:
  //   docs|tests|audit|worklog|examples|tool-results → never needed at runtime
  //   .next/**                                       → the static chunks are copied by `npm run build`
  //   public/**                                      → copied by `npm run build` (cp -r public)
  //   storage/**|upload/**|download/**               → runtime media, must never be baked into a release
  // Nothing on a request path lives in those directories, and the standalone
  // smoke test boots the server to prove it.
  outputFileTracingExcludes: {
    // `.next/**` is deliberately NOT excluded: Turbopack emits runtime chunks
    // under `.next/server/chunks/` that the tracer must keep, and excluding them
    // shipped a server that answered 500 ("Cannot find module … [turbopack]_runtime.js").
    // Verified by booting the standalone server after every build.
    "*": ["public/**", "storage/**", "upload/**", "download/**", "docs/**", "tests/**", "audit/**", "marketingos/**", "examples/**", "tool-results/**", "worklog.md"],
  },
  // Dev-server only: hosts allowed to load /_next assets during `next dev`.
  allowedDevOrigins: ["127.0.0.1", "localhost", "21.0.4.113", "103.231.239.79", "marketing.alolabs.net"],
};

export default nextConfig;
