import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {buildSync} from "esbuild";

// Bundle the actual registry: the standard JSX test loader intentionally
// replaces image imports with empty strings and cannot verify these cards.
const {outputFiles} = buildSync({
    entryPoints: [fileURLToPath(new URL(
        "../../client/src/common/components/TargetsDialog/providers.jsx", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node",
    loader: {".png": "dataurl", ".webp": "dataurl"}
});
const {providers, providerById} = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
const PNG_PREFIX = "data:image/png;base64,";
const OFFICIAL_LOGOS = [
    ["iperf3", "72c5e572b076402be9ea82bd27c198f8dac8b5ea7605531e49c9864e820a8844"],
    ["openspeedtest", "7e02e40c7b6e825b2bdc00f07dee7d00383d5384c3cde6058217e06ff95313ec"]
];

describe("bundled official provider logos", () => {
    for (const [id, sha256] of OFFICIAL_LOGOS) {
        it(`${id} uses the unchanged upstream PNG instead of a generic glyph`, () => {
            const provider = providerById(id);
            assert.equal(typeof provider.image, "string");
            assert.ok(provider.image.startsWith(PNG_PREFIX));
            assert.equal(provider.icon, undefined);
            const bytes = Buffer.from(provider.image.slice(PNG_PREFIX.length), "base64");
            assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
        });
    }

    it("keeps every provider and the existing provider images", () => {
        assert.deepEqual(providers.map(({id}) => id),
            ["ookla", "libre", "cloudflare", "iperf3", "openspeedtest"]);
        for (const id of ["ookla", "libre", "cloudflare"])
            assert.ok(providerById(id).image.startsWith("data:image/webp;base64,"));
        assert.equal(providerById("unknown"), null);
    });
});
