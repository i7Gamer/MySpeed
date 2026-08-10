import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

const header = read("common/components/Header/HeaderComponent.jsx");
const about = read("common/components/AboutDialog/AboutDialog.jsx");

/**
 * The title used to split on viewMode: a read-only visitor got a bare, inert
 * heading while everyone else got the logo and the About dialog behind it.
 * There is nothing in that dialog a visitor may not see - the description and
 * three public links - so the split bought nothing and cost the affordance.
 */
describe("the header title for a read-only visitor", () => {
    it("is the same clickable title everyone else gets", () => {
        assert.doesNotMatch(header, /config\.viewMode\s*&&\s*<h2/,
            "the title still splits into a view-mode variant");
        assert.match(header, /header-about/);
        assert.match(header, /setShowAboutDialog\(true\)/);
    });
});

/**
 * The version is the one thing in the dialog a visitor does not get: the
 * endpoint is admin-gated, matching the header's own update check. The dialog
 * already coped - the badge simply never rendered - but it fired a request
 * guaranteed to 401 on every open. Not asking is the same policy without the
 * noise.
 */
describe("the about dialog for a read-only visitor", () => {
    it("does not ask for the version it will be refused", () => {
        assert.match(about, /viewMode/, "the dialog never considers who is asking");
    });

    it("still shows no version rather than an error when the answer is missing", () => {
        assert.match(about, /version\s*&&/, "the version badge does not guard on having one");
    });
});
