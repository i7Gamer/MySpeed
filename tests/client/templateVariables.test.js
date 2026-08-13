import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    appendVariable, variableToken
} from "@/common/components/IntegrationDialog/templateVariables.js";

/**
 * The chips under a message template.
 *
 * Nothing in the interface said the templates understood %ping% at all - the
 * only hint was the example in the placeholder, which disappears the moment
 * anything is typed, and which named four of the two dozen names that work.
 * Upstream #774 asks for the list, and for it to be usable rather than only
 * readable, so a chip writes its own name into the template.
 */
describe("variableToken", () => {
    it("wraps a name the way a template spells it", () => {
        assert.equal(variableToken("ping"), "%ping%");
        assert.equal(variableToken("packetLoss"), "%packetLoss%");
    });
});

describe("appendVariable", () => {
    it("adds the variable to an empty template", () => {
        assert.equal(appendVariable("", "ping"), "%ping%");
    });

    // Written onto the end rather than over the top: the operator has usually
    // typed the sentence already and wants the value dropped into it.
    it("keeps what was already written", () => {
        assert.equal(appendVariable("Ping:", "ping"), "Ping: %ping%");
    });

    it("does not double the space it separates with", () => {
        assert.equal(appendVariable("Ping: ", "ping"), "Ping: %ping%");
    });

    // A template is often several lines, and a name appended to the last of
    // them belongs on that line rather than pushed onto a new one.
    it("stays on the line the template ends on", () => {
        assert.equal(appendVariable("Down: %download%\nUp:", "upload"), "Down: %download%\nUp: %upload%");
    });

    it("adds no space directly after a newline", () => {
        assert.equal(appendVariable("Down: %download%\n", "upload"), "Down: %download%\n%upload%");
    });

    it("treats an absent template as an empty one", () => {
        for (const empty of [null, undefined]) assert.equal(appendVariable(empty, "ping"), "%ping%");
    });

    // The same name twice is a reasonable thing to want - a subject line and a
    // body both naming the download, say.
    it("adds a name the template already uses", () => {
        assert.equal(appendVariable("%ping%", "ping"), "%ping% %ping%");
    });
});
