import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openGraphMarkup, renderOpenGraphSvg } from "../../server/controller/opengraph.js";

const font = fs.readFileSync(new URL("../../client/public/assets/fonts/inter-v12-latin-regular.ttf", import.meta.url));
const logo = fs.readFileSync(new URL("../../client/public/assets/img/logo192.png", import.meta.url));
const LOGO_SIZE_PX = 200;
// Tailwind weights above the regular 400 that the bundled Inter Regular lacks.
const HEAVIER_WEIGHTS = /^font-(medium|semibold|bold|extrabold|black)$/;
const sample = {
    date: "10/16/2026",
    time: "9:41 AM CEST",
    logo,
    test: {download: {avg: 512.34}, upload: {avg: 48.7}, ping: {avg: 12}},
};

const twClasses = (node) => {
    if (!node || typeof node !== "object") return [];
    const own = node.props?.tw ? node.props.tw.split(/\s+/) : [];
    return [...own, ...[].concat(node.props?.children ?? []).flatMap(twClasses)];
};

/**
 * The OpenGraph layout as the installed satori lays it out.
 *
 * satori 0.52 lets a flex child shrink on the row axis, which squeezed the
 * 200px logo into its 100px box, and it synthesises bold for a weight the
 * loaded fonts lack - only Inter Regular is shipped, so `font-bold` and
 * `font-semibold` turned into faux bold where they used to be no-ops.
 */
describe("the OpenGraph markup", () => {
    it("keeps the logo at its full square size", async () => {
        const svg = await renderOpenGraphSvg(openGraphMarkup(sample), font);
        const href = `data:image/png;base64,${logo.toString("base64")}`;
        const image = svg.match(/<image\b[^>]*>/g).find((element) => element.includes(href));
        assert.ok(image, "the logo is no longer rendered");
        assert.match(image, new RegExp(`\\bwidth="${LOGO_SIZE_PX}"`));
        assert.match(image, new RegExp(`\\bheight="${LOGO_SIZE_PX}"`));
    });

    it("asks for no weight the bundled font lacks", () => {
        assert.deepEqual(twClasses(openGraphMarkup(sample)).filter((name) => HEAVIER_WEIGHTS.test(name)), []);
    });
});
