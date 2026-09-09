import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readLocale } from "../helpers/source.js";

describe("Romance locale terminology", () => {
    // A named test destination is distinct from the numeric goal shown by
    // statistics.values.target. Both concepts appear on the same page.
    for (const [code, destination, goal] of [
        ["it", /destinazion/i, /obiettiv/i],
        ["es", /destino/i, /objetivo/i],
        ["ca", /destinaci/i, /objectiu/i]
    ]) {
        it(`${code} distinguishes destinations from numeric goals`, () => {
            const locale = readLocale(code);
            for (const label of [locale.statistics.targets.title,
                locale.statistics.targets.empty, locale.connections.unknown_target,
                locale.targets.baseline_desc]) {
                assert.match(label, destination);
                assert.doesNotMatch(label, goal);
            }
            assert.match(locale.statistics.values.target, goal);
        });
    }

    it("Portuguese explains lower jitter rather than releasing something", () => {
        const description = readLocale("pt").info.jitter.description;
        assert.match(description, /jitter mais baixo/i);
        assert.doesNotMatch(description, /soltar/i);
    });
});
