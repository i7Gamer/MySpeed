import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

/**
 * React calls an event handler with the event, so a function whose first
 * parameter carries a default never sees that default when it is passed bare:
 *
 *   const showPasswordDialog = async (failed = false) => ...
 *   <FontAwesomeIcon onClick={showPasswordDialog} />
 *
 * `failed` is then a MouseEvent - an object, so truthy - and the admin login
 * opened already accusing the operator of typing the wrong password, before
 * they had typed anything at all.
 *
 * The default is the tell: a parameter with one is meant to be omitted, and an
 * event handler is the one place it never can be. Wrapping the call in an arrow
 * (`onClick={() => showPasswordDialog()}`) is what restores it.
 */

// `const f = (x = ...`, `const f = async (x = ...`, `function f(x = ...`.
const DEFAULTED_FIRST_PARAM = /(?:const|let|function)\s+(\w+)\s*=?\s*(?:async\s*)?\(\s*(\w+)\s*=\s*[^,)]+/g;

// `onClick={handler}` - an identifier, not an inline arrow or a call.
const BARE_HANDLER = /(on[A-Z]\w+)=\{(\w+)\}/g;

const sourcesIn = (directory) => fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesIn(full);

    return /\.jsx?$/.test(entry.name) ? [full] : [];
});

const matchAll = (source, pattern) => [...source.matchAll(new RegExp(pattern.source, pattern.flags))];

const collect = () => {
    const defaulted = new Map();
    const handlers = [];

    for (const file of sourcesIn(CLIENT_SRC)) {
        const source = fs.readFileSync(file, "utf8");
        const relative = path.relative(CLIENT_SRC, file);

        for (const match of matchAll(source, DEFAULTED_FIRST_PARAM))
            defaulted.set(match[1], {file: relative, parameter: match[2]});

        for (const match of matchAll(source, BARE_HANDLER))
            handlers.push({
                file: relative,
                line: source.slice(0, match.index).split("\n").length,
                prop: match[1],
                name: match[2]
            });
    }

    return handlers
        .filter((handler) => defaulted.has(handler.name))
        .map((handler) => ({...handler, ...defaulted.get(handler.name)}));
};

describe("passing a function straight to an event handler", () => {
    it("finds sources to check", () => {
        assert.ok(sourcesIn(CLIENT_SRC).length > 10, "the component scan found almost nothing - has the path moved?");
    });

    /**
     * A source scan rather than a rendering test: the component renders
     * perfectly either way. What is wrong is the argument it was handed, and
     * this repo has no DOM testing that could observe it.
     */
    it("never hands the event to a parameter that has a default", () => {
        const offenders = collect().map((entry) =>
            `${entry.file}:${entry.line}  ${entry.prop}={${entry.name}}  ` +
            `-> ${entry.name}(${entry.parameter} = ...) receives the event as ${entry.parameter}`);

        assert.equal(offenders.length, 0,
            `an event handler is passed bare to a function whose first parameter has a default, so the ` +
            `default never applies - wrap it: on...={() => ${offenders.length ? collect()[0].name : "handler"}()}:\n` +
            offenders.join("\n"));
    });

    // The scan is worthless if its own patterns stop matching what it hunts, so
    // both halves are checked against the shape that actually shipped broken.
    it("still recognises the shape it exists to catch", () => {
        assert.deepEqual(
            matchAll("const showPasswordDialog = async (failed = false) => {", DEFAULTED_FIRST_PARAM)
                .map((match) => [match[1], match[2]]),
            [["showPasswordDialog", "failed"]]
        );
        assert.deepEqual(
            matchAll("<FontAwesomeIcon onClick={showPasswordDialog} />", BARE_HANDLER)
                .map((match) => [match[1], match[2]]),
            [["onClick", "showPasswordDialog"]]
        );
    });

    it("does not object to a wrapped call or to a plain parameter", () => {
        assert.equal(matchAll("<a onClick={() => showPasswordDialog()} />", BARE_HANDLER).length, 0);
        assert.equal(matchAll("const handleBackdropClick = (event) => {", DEFAULTED_FIRST_PARAM).length, 0);
    });
});
