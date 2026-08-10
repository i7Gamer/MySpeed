import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * The import helpers target the browser; stub the two globals they reach for
 * before the module loads, the way requestUtil.test.js stubs fetch.
 *
 * The fake FileReader reads a fake file: {content} succeeds with it, anything
 * else fails the read. The fake document captures the input element the picker
 * builds so a test can fire its events by hand.
 */
class FakeFileReader {
    readAsText(file) {
        queueMicrotask(() => {
            if (typeof file?.content === "string") {
                this.result = file.content;
                this.onload?.();
            } else {
                this.error = new Error("read failed");
                this.onerror?.();
            }
        });
    }
}

globalThis.FileReader = FakeFileReader;

let lastInput = null;

globalThis.document = {
    createElement: () => {
        lastInput = {
            files: [],
            click() {},
            remove() {}
        };
        return lastInput;
    }
};

const { readAsJson, chooseJsonFile, chooseAndReadJson } = await import("../../client/src/common/utils/FileImport.js");

beforeEach(() => {
    lastInput = null;
});

describe("readAsJson", () => {
    it("resolves the parsed content", async () => {
        assert.deepEqual(await readAsJson({content: '{"config": {"ping": "25"}}'}), {config: {ping: "25"}});
    });

    /**
     * Regression: both storage imports ran JSON.parse(reader.result) bare
     * inside reader.onload, so a truncated backup threw an uncaught exception
     * - no toast, no error, the dialog just sat there.
     */
    it("rejects a file that is not JSON instead of throwing uncaught", async () => {
        await assert.rejects(() => readAsJson({content: '{"config": tru'}), (error) => {
            assert.ok(error instanceof Error);
            return true;
        });
    });

    it("rejects when the file cannot be read at all", async () => {
        await assert.rejects(() => readAsJson({}));
    });
});

describe("chooseJsonFile", () => {
    it("resolves the picked file", async () => {
        const pending = chooseJsonFile();
        lastInput.files = [{content: "{}"}];
        lastInput.onchange();

        assert.deepEqual(await pending, {content: "{}"});
    });

    it("resolves null when the picker is dismissed", async () => {
        const pending = chooseJsonFile();
        lastInput.oncancel();

        assert.equal(await pending, null);
    });

    it("resolves null when the change carries no file", async () => {
        const pending = chooseJsonFile();
        lastInput.onchange();

        assert.equal(await pending, null);
    });

    it("asks for json files", async () => {
        chooseJsonFile();
        assert.equal(lastInput.accept, ".json");
        assert.equal(lastInput.type, "file");
    });
});

describe("chooseAndReadJson", () => {
    it("returns the parsed file end to end", async () => {
        const pending = chooseAndReadJson();
        lastInput.files = [{content: '[{"ping": 10}]'}];
        lastInput.onchange();

        assert.deepEqual(await pending, [{ping: 10}]);
    });

    it("returns null for a dismissed picker without touching a reader", async () => {
        const pending = chooseAndReadJson();
        lastInput.oncancel();

        assert.equal(await pending, null);
    });

    it("rejects on an unparseable file", async () => {
        const pending = chooseAndReadJson();
        lastInput.files = [{content: "not json"}];
        lastInput.onchange();

        await assert.rejects(() => pending);
    });
});
