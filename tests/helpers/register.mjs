import { register } from "node:module";

// Loaded through --import so the hook is in place before any test file is
// evaluated. Registering it from inside a test would be too late for that
// file's own imports, which are hoisted.
register("./aliasResolver.mjs", import.meta.url);

// And, once the resolver has found a file, the loader that turns a component
// into something node will evaluate - see jsxLoader.mjs for why the suite
// reading JSX as text is not enough.
register("./jsxLoader.mjs", import.meta.url);
