import { register } from "node:module";

// Loaded through --import so the hook is in place before any test file is
// evaluated. Registering it from inside a test would be too late for that
// file's own imports, which are hoisted.
register("./aliasResolver.mjs", import.meta.url);
