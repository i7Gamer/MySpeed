import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * The mutating request helpers hand back the raw Response, so a caller that
 * does not check it reports success whatever the server said. Each entry here
 * is a dialog that used to do exactly that: toast "changes applied" over a
 * 400, fade a card the server refused to delete, or say nothing at all.
 *
 * Source-scanned because these are components with no render harness; the
 * regexes pin the pattern that makes the failure visible, not the layout.
 */
const CHECKED_WRITES = [
    {
        file: "common/components/OptimalValuesDialog/OptimalValuesDialog.jsx",
        patterns: [
            [/assertOk\(await patchRequest\(/, "config writes are not checked"],
            [/instanceof RequestError \? e\.message/, "the server's refusal is not surfaced"]
        ]
    },
    {
        file: "common/components/WelcomeDialog/WelcomeDialog.jsx",
        patterns: [
            [/assertOk\(await patchRequest\(/, "setup writes are not checked"],
            [/instanceof RequestError \? e\.message/, "the server's refusal is not surfaced"]
        ]
    },
    {
        file: "common/components/PauseDialog/PauseDialog.jsx",
        patterns: [
            [/assertOk\(await postRequest\("\/speedtests\/pause"/, "the pause request is not checked"]
        ]
    },
    {
        file: "common/components/FrequencyDialog/FrequencyDialog.jsx",
        patterns: [
            [/assertOk\(await patchRequest\("\/config\/cron"/, "the cron write is not checked"],
            [/assertOk\(await patchRequest\("\/config\/scheduleOffset"/, "the offset write is not checked"],
            // A failed second write leaves the first applied; the config has
            // to resync either way or the dialog shows a schedule that is no
            // longer stored.
            [/finally[\s\S]{0,200}reloadConfig\(\)/, "a partial save does not resync the config"]
        ]
    },
    {
        file: "common/components/IntegrationDialog/IntegrationDialog.jsx",
        patterns: [
            [/response\?\.ok/, "a refused integration delete still removes the card"]
        ]
    }
];

/**
 * The storage tabs read a user-chosen backup file. Both used to run
 * JSON.parse(reader.result) bare inside reader.onload - a truncated file threw
 * uncaught and nothing on screen moved - and both treated any response to a
 * delete or reset as success.
 */
const STORAGE_TABS = [
    "common/components/StorageDialog/tabs/Speedtests.jsx",
    "common/components/StorageDialog/tabs/Configuration.jsx"
];

describe("mutations surface their failures", () => {
    for (const {file, patterns} of CHECKED_WRITES) {
        const source = read(file);
        const name = path.basename(file, ".jsx");

        for (const [pattern, message] of patterns) {
            it(`${name}: ${message.replace("is not", "is").replace("does not", "does")}`, () => {
                assert.match(source, pattern, `${name}: ${message}`);
            });
        }
    }
});

describe("the storage tabs import and destroy with feedback", () => {
    for (const tab of STORAGE_TABS) {
        const source = read(tab);
        const name = path.basename(tab, ".jsx");

        it(`${name} reads files through the guarded helper`, () => {
            assert.match(source, /chooseAndReadJson/, `${name} does not use the FileImport helper`);
            assert.doesNotMatch(source, /JSON\.parse\(reader\.result\)/,
                `${name} still parses the file bare inside reader.onload`);
            assert.doesNotMatch(source, /new FileReader/, `${name} still hand-rolls the reader`);
        });

        it(`${name} does not report a refused delete as done`, () => {
            assert.match(source, /res(ponse)?\??\.ok/, `${name} never checks the delete response`);
        });

        it(`${name} catches a failed download`, () => {
            assert.match(source, /downloadRequest[\s\S]{0,300}?\.catch\(/,
                `${name} leaves a failed export as an unhandled rejection`);
        });
    }
});
