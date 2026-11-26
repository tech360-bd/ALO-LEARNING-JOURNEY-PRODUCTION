// Node ESM resolve hook: maps the Next.js `@/*` path alias to ./src/* so the
// test runner (plain node + --experimental-strip-types) can load modules from
// the source tree without Next's bundler. Passes every other specifier
// through untouched.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tryResolveExisting(base, context, nextResolve) {
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(cand) && !cand.endsWith("/")) {
      return nextResolve(pathToFileURL(cand).href, context);
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // `@/*` → ./src/* (Next.js path alias).
  if (specifier.startsWith("@/")) {
    const hit = tryResolveExisting(path.join(ROOT, "src", specifier.slice(2)), context, nextResolve);
    if (hit) return hit;
    // Unresolved @/ target — let the default resolver produce the usual error.
  }
  // Extensionless relative imports (allowed in TS, required to carry a real
  // extension in node ESM) — try the TS extensions.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL ?? `${ROOT}/`)), specifier);
    const hit = tryResolveExisting(base, context, nextResolve);
    if (hit) return hit;
  }
  return nextResolve(specifier, context);
}
