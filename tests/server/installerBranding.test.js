import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * What the Windows installer says about who made it.
 *
 * None of this is the "Unknown publisher" line on the UAC prompt. That line is
 * read out of the file's Authenticode signature and nowhere else, so an unsigned
 * MSI says "Unknown publisher" no matter what the Product element claims - which
 * is the trap these assertions exist beside rather than close. What the metadata
 * below does reach is the Add/Remove Programs entry and the file's own property
 * sheet, where a bare given name gives someone who found the installer no way to
 * tell whether they are looking at this project or at a repackage of it.
 */
const workflow = readSource(".github/workflows/build-msi.yml");

const REPOSITORY = "https://github.com/i7Gamer/MySpeed";

/** The one `<Product …>` line the WiX source is built from. */
const product = (() => {
    const line = workflow.split("\n").find((text) => text.includes("<Product "));
    assert.notEqual(line, undefined, "the WiX source no longer declares a Product");
    return line;
})();

describe("the publisher the Windows installer registers", () => {
    it("credits the project's account rather than a given name", () => {
        assert.match(product, /Manufacturer="i7Gamer"/,
            "the MSI's Manufacturer is what Add/Remove Programs shows as Publisher");
    });

    /**
     * Both installers are one product under one UpgradeCode, so a Manufacturer
     * that drifted between them would show a different publisher depending on
     * which one happened to be installed last.
     */
    it("is the only publisher either installer declares", () => {
        const publishers = new Set([...workflow.matchAll(/Manufacturer="([^"]*)"/g)].map((found) => found[1]));

        assert.deepEqual([...publishers], ["i7Gamer"],
            "the two matrix legs disagree about who published them");
    });
});

describe("where the installed entry points back to", () => {
    /**
     * ARPURLINFOABOUT and ARPHELPLINK are the two links Add/Remove Programs
     * offers, and without them the entry is a name with nothing behind it -
     * which is the same standing an unsigned repackage has.
     */
    it("offers the repository from Add/Remove Programs", () => {
        assert.match(workflow, new RegExp(`Id="ARPURLINFOABOUT" Value="${REPOSITORY}"`),
            "nothing links the installed entry back to the project");
    });

    it("offers somewhere to report a broken install", () => {
        assert.match(workflow, new RegExp(`Id="ARPHELPLINK" Value="${REPOSITORY}/issues"`),
            "someone whose service never starts has no link to follow");
    });

    /**
     * And where to find a newer one. The third of the three was written and
     * then left unheld, which is the state a property reaches just before
     * someone tidies it away as unused - the other two say what they are for,
     * and this one said nothing.
     */
    it("offers where to look for a newer version", () => {
        assert.match(workflow, new RegExp(`Id="ARPURLUPDATEINFO" Value="${REPOSITORY}/releases"`),
            "the installed entry does not say where updates come from");
    });

    /**
     * All three point at this project. A property that kept an old owner's URL
     * would be the same fault the Manufacturer above was fixed for, and harder
     * to notice: nothing renders these until someone opens the entry's details.
     */
    it("points every link at the project's own repository", () => {
        const links = [...workflow.matchAll(/Id="(ARP\w*(?:URL|LINK)\w*)" Value="([^"]*)"/g)];

        assert.equal(links.length, 3, `expected three links, found ${links.length}`);

        for (const [, property, value] of links)
            assert.ok(value.startsWith(`${REPOSITORY}/`) || value === REPOSITORY,
                `${property} points at ${value}, which is not this project`);
    });
});
