import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * Who may read what the Windows installer puts under ProgramData.
 *
 * `C:\ProgramData` grants BUILTIN\Users read access, inheritable, and the
 * installer used to create `MySpeed\data` beneath it with no ACL of its own -
 * so the database holding the password hash and every integration secret, the
 * TLS private key under `certs`, and the `.env` beside them were readable by
 * every account that could log on to the machine. createFolders.js says in as
 * many words that on win32 the inherited ACL is what governs; this is where
 * that ACL is decided.
 *
 * The protection is an SDDL through the MsiLockPermissionsEx table (the core
 * PermissionEx element), not the util extension's PermissionEx: that one only
 * ADDS entries to the DACL the folder already has, so the inherited Users grant
 * would have survived it untouched. A protected DACL (`D:P`) is what stops the
 * inheritance, and it needs Windows Installer 5.0, hence the package version
 * pinned below.
 */
const workflow = readSource(".github/workflows/build-msi.yml");

// Windows Installer 5.0 is the first that reads MsiLockPermissionsEx; earlier
// engines ignore the table and leave the inherited ACL standing.
const INSTALLER_VERSION_WITH_LOCK_PERMISSIONS_EX = 500;

// The SDDL's DACL: protected against inheritance, then full control for the
// service's own account and for administrators, both inherited by everything
// created beneath - and nobody else.
const PROTECTED_DACL = /Sddl="D:P\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)"/;

// The two well-known SIDs a permissive SDDL would name.
const USERS_SID = /;;;BU\)/;
const EVERYONE_SID = /;;;WD\)/;

/** A component's XML, from its opening tag to its closing one. */
const component = (id) => {
    const start = workflow.indexOf(`<Component Id="${id}"`);
    assert.notEqual(start, -1, `the WiX source no longer declares the ${id} component`);

    const end = workflow.indexOf("</Component>", start);
    assert.notEqual(end, -1, `the ${id} component is never closed`);

    return workflow.slice(start, end);
};

describe("the installer's ProgramData permissions", () => {
    it("asks for the installer engine that honours MsiLockPermissionsEx", () => {
        assert.match(workflow, new RegExp(`<Package InstallerVersion="${INSTALLER_VERSION_WITH_LOCK_PERMISSIONS_EX}"`),
            "an older engine ignores the permission table and the inherited Users grant stands");
    });

    for (const id of ["DataRootFolder", "DataFolder"]) {
        describe(`the ${id} component`, () => {
            it("creates its folder under a protected DACL", () => {
                const xml = component(id);

                assert.match(xml, /<CreateFolder>/, "the folder is created without a body to carry permissions");
                assert.match(xml, PROTECTED_DACL,
                    "the folder inherits ProgramData's ACL, which grants every local account read access");
            });

            it("grants nothing to Users or Everyone", () => {
                const xml = component(id);

                assert.doesNotMatch(xml, USERS_SID, "the SDDL hands the secrets back to every local account");
                assert.doesNotMatch(xml, EVERYONE_SID, "the SDDL hands the secrets to everyone");
            });

            it("uses the core element rather than the util extension's", () => {
                assert.doesNotMatch(component(id), /util:PermissionEx/,
                    "the util extension only adds entries, so the inherited grant survives it");
            });
        });
    }

    it("installs the root folder's component", () => {
        assert.match(workflow, /<ComponentRef Id="DataRootFolder" \/>/,
            "a component the feature does not reference is never installed, so its ACL is never applied");
    });

    it("keeps the two components on the directories the server writes", () => {
        assert.match(component("DataRootFolder"), /Directory="DATAROOTFOLDER"/);
        assert.match(component("DataFolder"), /Directory="DATAFOLDER"/);
    });
});
