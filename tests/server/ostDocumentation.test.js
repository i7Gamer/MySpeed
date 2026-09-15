import assert from "node:assert/strict";
import fs from "node:fs";
import {describe, it} from "node:test";

const readmes = ["README.md", "README.de.md"].map(file => fs.readFileSync(file, "utf8"));

describe("OpenSpeedTest operator documentation", () => {
    it("documents the explicit insecure TLS waiver and its lifecycle in both manuals", () => {
        for (const source of readmes) {
            assert.match(source, /trusted HTTPS|vertrauensw.rdiges HTTPS/ui);
            assert.match(source, /--insecure/u);
            assert.match(source, /redirect|Weiterleitung/ui);
            assert.match(source, /off by default|standardm..ig deaktiviert/ui);
            assert.match(source, /reaffirm|erneut best.tig/ui);
        }
    });

    it("documents interface routing, post-setup editing, and truthful progress behavior", () => {
        for (const source of readmes) {
            assert.match(source, /cannot bind|nicht.*binden/ui);
            assert.match(source, /after setup|nach.*Einrichtung/ui);
            assert.match(source, /indeterminate|unbestimmt/ui);
            assert.match(source, /elapsed|vergangen/ui);
            assert.match(source, /no.*percent|kein.*Prozent/ui);
        }
    });
});
