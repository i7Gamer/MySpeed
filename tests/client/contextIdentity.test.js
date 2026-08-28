import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readSource } from "../helpers/source.js";

/**
 * A context provider's value keeps its identity between changes.
 *
 * The providers nest - Config holds Node holds Status holds Speedtest - and
 * four of them handed out a fresh array on every render. useContext re-renders
 * every consumer whenever that identity changes, so a parent re-rendering for
 * reasons of its own re-rendered everything below it to show exactly what was
 * already on screen: the status poll alone did it every few seconds at idle.
 * AlertContext already does this right, and is the pattern being held to here -
 * a memoised value over callbacks that are themselves memoised, because a
 * useMemo over functions rebuilt each render memoises nothing.
 */
const PROVIDERS = [
    "client/src/common/contexts/Preferences/PreferencesContext.jsx",
    "client/src/common/contexts/Status/StatusContext.jsx",
    "client/src/common/contexts/Config/ConfigContext.jsx",
    "client/src/common/contexts/Node/NodeContext.jsx"
];

describe("a context provider's value keeps its identity", () => {
    for (const file of PROVIDERS) {
        const name = path.basename(file, ".jsx");
        const source = readSource(file);

        it(`${name} hands out a memoised value`, () => {
            assert.match(source, /const contextValue = useMemo\(/,
                `${name} builds no memoised value at all`);
            assert.match(source, /\.Provider value=\{contextValue}/,
                `${name} memoises a value and then hands out something else`);
        });

        it(`${name} hands out no inline array`, () => {
            assert.doesNotMatch(source, /\.Provider value=\{\[/,
                `${name} rebuilds its value on every render`);
        });
    }
});
