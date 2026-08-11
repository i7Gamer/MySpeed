import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const read = (file) => fs.readFileSync(path.join(CLIENT_SRC, file), "utf8");

/**
 * The dialogs that edit stored settings, every one of which used to seed its
 * state from a context in useState initialisers - run once, at mount. The
 * dialogs are mounted with the header, and on an instance with read-level
 * access the header first mounts against the visitor config, which omits the
 * very keys they edit. After logging in they showed defaults over the stored
 * values; whatever the operator then re-saved is what actually changed them -
 * and the password dialog, comparing its stale access level against the fresh
 * config, would have written passwordLevel back to "none" as a side effect of
 * changing the password.
 *
 * The welcome wizard is the same disease with a worse ending. It is rendered by
 * ConfigProvider itself, so it mounts on the provider's very first render -
 * when the config is still `{}` - and its three targets seed to 0. Finishing
 * the wizard PATCHes all three unconditionally, so clicking through a fresh
 * install without editing that step writes 0 over the shipped defaults: every
 * metric then renders blue forever and no target bar appears anywhere.
 */
const SETTINGS_DIALOGS = [
    "common/components/FrequencyDialog/FrequencyDialog.jsx",
    "common/components/OptimalValuesDialog/OptimalValuesDialog.jsx",
    "common/components/PasswordDialog/PasswordDialog.jsx",
    "common/components/ProviderDialog/ProviderDialog.jsx",
    "common/components/PreferencesDialog/PreferencesDialog.jsx",
    "common/components/WelcomeDialog/WelcomeDialog.jsx"
];

// A useState whose initial value reads the config or preferences context - the
// capture-at-mount pattern this sweep removed. The context reference may sit
// inside a call, which is how `useState(parseInt(config.ping) || 0)` slipped
// past the narrower version of this pattern.
const MOUNT_CAPTURE = /useState\([^)]*\b(config|preferences)[.[]/;

describe("the settings dialogs read their values when they open", () => {
    for (const dialog of SETTINGS_DIALOGS) {
        const source = read(dialog);
        const name = path.basename(dialog, ".jsx");

        it(`${name} syncs on open instead of capturing at mount`, () => {
            assert.match(source, /useSyncOnOpen\(\s*open/, `${name} never re-reads its context`);
            assert.doesNotMatch(source, MOUNT_CAPTURE,
                `${name} still seeds state from a context at mount`);
        });
    }

    it("the frequency dialog derives its state through the pure function", () => {
        assert.match(read(SETTINGS_DIALOGS[0]), /frequencyStateFrom\(config\)/);
    });

    // The comparison that made the stale capture destructive: it decides
    // whether saving a password also rewrites the access level.
    it("the password dialog still only writes the access level when it changed", () => {
        assert.match(read("common/components/PasswordDialog/PasswordDialog.jsx"),
            /accessLevel !== config\.passwordLevel/);
    });
});

describe("the open-sync hook", () => {
    const hook = read("common/hooks/useSyncOnOpen.js");

    it("runs its sync exactly when the dialog opens", () => {
        assert.match(hook, /useEffect/);
        assert.match(hook, /if \(open\)/);
        assert.match(hook, /\[open\]/);
    });

    // The sync closure reads whatever context is current at open time; holding
    // it in a ref keeps the effect keyed on `open` alone without capturing a
    // stale closure - the very disease this hook exists to cure.
    it("reads the latest sync rather than the one it mounted with", () => {
        assert.match(hook, /useRef/);
    });
});
