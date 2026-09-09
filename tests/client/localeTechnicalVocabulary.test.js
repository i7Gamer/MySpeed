import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {localeCodes, readLocale} from "../helpers/source.js";
import {TIMEFRAMES} from "../../client/src/common/utils/TimeframeUtil.js";

describe("technical vocabulary in translated help", () => {
    for (const code of localeCodes()) {
        const locale = readLocale(code);

        it(`${code}: names both packet-loss providers and the required UDP mode`, () => {
            // parseData reports loss for Ookla and iperf3 UDP, not just Ookla.
            const description = locale.info.packet_loss.description;
            for (const term of ["Ookla", "iperf3", "UDP"])
                assert.ok(description.includes(term), `${code}: packet-loss help omits ${term}`);
        });

        it(`${code}: keeps the ntfy emoji tag identifiers usable`, () => {
            // These values go straight into ntfy's Tags header; only the
            // explanation around the comma-separated example is localizable.
            assert.match(locale.integrations.ntfy.fields.tags_placeholder, /\bwarning,satellite\b/);
        });
    }
});

describe("rolling-year vocabulary", () => {
    const year = TIMEFRAMES.find(({id}) => id === "1y");
    for (const code of ["en", "de", "nl", "da", "nb", "sv"])
        it(`${code}: states the rolling day count instead of the previous calendar year`, () => {
            assert.ok(readLocale(code).calendar.last_year.includes(String(year.days)));
        });
});
