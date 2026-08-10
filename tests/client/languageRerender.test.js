import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * Almost every component renders its strings with the global `t` from i18next,
 * which reads the current language at render time but subscribes to nothing.
 * Switching the language therefore only translated whatever happened to
 * re-render for its own reasons - the statistics page, which refetches on
 * languageChanged - while the header kept its old words until a reload or a
 * navigation forced it through a render.
 *
 * The cure is one subscription at the layout root: useTranslation() re-renders
 * the shell on languageChanged, and since none of the chrome below memoises,
 * the render sweeps through every global-t call in the tree.
 */
describe("switching the language", () => {
    it("re-renders the whole layout through one subscription at the root", () => {
        const app = read("App.jsx");

        assert.match(app, /useTranslation/, "the layout root does not subscribe to language changes");
    });

    // The one component the sweep cannot reach: memo with no props blocks the
    // parent-driven re-render, so the pagination has to subscribe for itself.
    it("reaches the memoised pagination through its own subscription", () => {
        const pagination = read("common/components/Header/components/Pagination/Pagination.jsx");

        assert.match(pagination, /useTranslation/, "the memoised pagination never hears the change");
    });
});
