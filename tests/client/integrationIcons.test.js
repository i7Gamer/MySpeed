import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import integrations from "../../server/integrations/index.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const ICONS_DIR = path.join(ROOT, "client", "src", "common", "assets", "icons");

const app = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8");

/**
 * The package each style class is served from, and the prefix it carries once
 * it is inside the library.
 *
 * An integration names its glyph as a class string - "fa-solid fa-envelope" -
 * because that string travels to the browser as data, over the integrations
 * API, and a class string is the one form FontAwesomeIcon accepts without the
 * component having to know every glyph in advance.
 *
 * The price of that is a lookup: a string is resolved against the icon library
 * at render time, and a glyph that was never added to it does not fail loudly.
 * FontAwesomeIcon logs to the console and renders null, so the card and the
 * dropdown row simply come up with a hole where the icon belongs. That is how
 * email and MQTT shipped: both named a real Font Awesome glyph, neither was
 * ever registered, and nothing in the build or the suite said so.
 */
const STYLES = {
    "fa-solid": {prefix: "fas", package: "free-solid-svg-icons"},
    "fa-brands": {prefix: "fab", package: "free-brands-svg-icons"}
};

/** "tower-broadcast" -> "faTowerBroadcast", the name the packages export. */
const exportName = (glyph) => "fa" + glyph.split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1)).join("");

const CALL = "library.add(";

/**
 * Every identifier handed to library.add(), in any of its calls.
 *
 * The registrations are split across more than one call - the packaged glyphs
 * in one, the hand-drawn ones in another - so a scan that reads only the first
 * would report the custom icons as missing. Read to the closing paren rather
 * than to the end of the line for the same reason: the packaged call is long
 * enough to wrap, and a line-at-a-time scan would see only its first half and
 * report the glyphs below the wrap as unregistered.
 */
const registered = new Set(app.split(CALL).slice(1).flatMap((rest) =>
    rest.slice(0, rest.indexOf(")")).split(",").map((entry) => entry.trim()).filter(Boolean)));

/** The names App.jsx imports from one of the icon packages. */
const importedFrom = (pkg) => {
    const line = app.split("\n").find((entry) => entry.trimStart().startsWith("import")
        && entry.includes(`@fortawesome/${pkg}`));

    if (!line) return new Set();

    return new Set(line.slice(line.indexOf("{") + 1, line.indexOf("}"))
        .split(",").map((entry) => entry.trim()).filter(Boolean));
};

/**
 * The glyphs drawn by hand rather than taken from a package, keyed the way a
 * class string names them.
 *
 * Pushover has no Font Awesome icon, so its mark is a path in an icon-shaped
 * object under assets/icons. Such an object declares the prefix and name it
 * answers to, which is what a class string is resolved against - so the file is
 * read for those rather than the pairing being written down here a second time
 * and left to go stale.
 */
const custom = new Map(fs.readdirSync(ICONS_DIR)
    .filter((file) => file.endsWith(".js"))
    .map((file) => {
        const source = fs.readFileSync(path.join(ICONS_DIR, file), "utf8");
        const iconName = source.match(/iconName: *"([^"]+)"/)?.[1];
        const prefix = source.match(/prefix: *"([^"]+)"/)?.[1];
        const exported = source.match(/export const (\w+)/)?.[1];

        assert.ok(iconName && prefix && exported,
            `${file} is not an icon definition this scan can read`);

        return [`${prefix} ${iconName}`, exported];
    }));

/**
 * What each integration says it should be drawn as.
 *
 * Read by calling the module rather than by grepping for the field: the icon
 * sits in the object a setup returns, which is the same object the controller
 * serialises for the client, so this asks the question the browser asks.
 */
const declared = integrations.map(({name, setup}) => ({name, icon: setup(() => {}).icon}));

describe("every integration's icon can be resolved", () => {
    it("covers every installed integration", () => {
        assert.equal(declared.length, integrations.length);

        for (const name of ["email", "mqtt"])
            assert.ok(declared.some((entry) => entry.name === name), `${name} is not installed`);
    });

    for (const {name, icon} of declared) {
        it(`${name} names a style and a glyph`, () => {
            assert.match(icon ?? "", /^fa-(solid|brands) fa-[a-z0-9-]+$/,
                `${name}'s icon is not a class string FontAwesomeIcon can parse`);
        });

        it(`${name}'s glyph is in the library`, () => {
            const [style, glyph] = icon.split(" ");
            const {prefix, package: pkg} = STYLES[style];
            const bare = glyph.slice("fa-".length);
            const hand = custom.get(`${prefix} ${bare}`);

            // A hand-drawn glyph answers to the prefix and name it declares;
            // anything else has to come out of the package for its style.
            const identifier = hand ?? exportName(bare);

            assert.ok(registered.has(identifier),
                `${name} draws itself as "${icon}", but App.jsx never adds ${identifier} to the `
                + "library - FontAwesomeIcon logs a miss and renders nothing in its place");

            if (hand) return;

            assert.ok(importedFrom(pkg).has(identifier),
                `${identifier} is registered but not imported from ${pkg}, which is where a `
                + `"${style}" glyph lives`);
        });
    }
});
