// Registers the `@/` → ./src/ resolve hook for the node test runner.
// Loaded via `node --import ./tests/ts-alias-loader.mjs`.
import { register } from "node:module";

register(new URL("./ts-alias-resolver.mjs", import.meta.url));
