import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

/**
 * Who a Windows installation's data directory belongs to, as opposed to who
 * may read it - which installerPermissions.test.js covers.
 *
 * `C:\ProgramData` lets every local account create a folder in it, and whoever
 * creates one owns it. The installer's ACL is a DACL: it says who may touch
 * `ProgramData\MySpeed` and nothing about who owns it, and an owner can always
 * rewrite the DACL. So an account that made the folder before MySpeed was
 * first installed kept control of everything a LocalSystem service then did
 * there - the database, the TLS key, `.env`, and `bin`, whose executables the
 * server runs as found. Releases 1.1.1 to 1.5.2 also created the folder with
 * ProgramData's inherited ACL, under which any account could add files to it,
 * and what was added then is still owned by whoever added it.
 *
 * scripts/installer/protect-data-directory.ps1 is the installer's answer: what
 * an account that is not an administrator owns is moved out to a quarantine
 * folder only administrators can open, never deleted, and the data root is
 * left owned and readable by SYSTEM and administrators alone.
 *
 * Two halves. The source half runs everywhere, because the behavioural half
 * needs Windows and an elevated prompt and so is skipped on the Linux runners a
 * pull request is checked on.
 */
const SCRIPT_PATH = "scripts/installer/protect-data-directory.ps1";
const ENTRY_POINT = "Protect-MySpeedDataRoot";

const workflow = readSource(".github/workflows/build-msi.yml");
const script = readSource(SCRIPT_PATH);

// The well-known SIDs. Names are localised - Administratoren, Administrateurs -
// and a script that compared names would trust nobody on a German Windows.
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const USERS_SID = "S-1-5-32-545";
const BACKUP_OPERATORS_SID = "S-1-5-32-551";

// The DACL the installer's own PermissionEx elements state - see
// installerPermissions.test.js. The script re-applies it, so the two must be
// the same string or an upgrade would loosen what the install tightened.
const PROTECTED_DACL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

const customAction = (id) => {
    const start = workflow.indexOf(`<CustomAction Id="${id}"`);
    assert.notEqual(start, -1, `the WiX source declares no ${id} custom action`);

    return workflow.slice(start, workflow.indexOf("/>", start));
};

describe("the data-directory protection the installer ships", () => {
    it("defines functions and runs nothing when it is loaded", () => {
        // Loading it must be inert: the installer pipes the file into the
        // session and then calls the entry point with the directory, and a
        // development machine that merely reads the file must not have its own
        // installation's data directory walked.
        const topLevel = script.split("\n").filter((line) => /^\S/.test(line));

        for (const line of topLevel)
            assert.match(line, /^(#|function |\}|\$script:[A-Za-z]+ = |Set-StrictMode |'@$)/,
                `a top-level statement runs on load: ${line}`);
        assert.doesNotMatch(script, new RegExp(`^${ENTRY_POINT}\\b`, "m"), "the script calls its own entry point");
    });

    it("has no default for the directory it rewrites", () => {
        const entry = script.slice(script.indexOf(`function ${ENTRY_POINT}`));

        assert.match(entry, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$DataRoot/,
            "a default would aim the script at a real installation whenever a caller forgot the argument");
        assert.doesNotMatch(script, /\$env:ProgramData/i, "the directory is the installer's to name, not the script's to guess");
    });

    it("judges ownership by SID and trusts only SYSTEM, administrators and the installer service", () => {
        for (const sid of [SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID])
            assert.ok(script.includes(`'${sid}'`), `${sid} is not among the trusted owners`);
        assert.ok(!script.includes(`'${USERS_SID}'`), "BUILTIN\\Users is trusted to own the service's files");
    });

    it("applies the same DACL the installer does", () => {
        assert.ok(script.includes(`'${PROTECTED_DACL}'`), "the script and the WiX source disagree about the DACL");
        assert.ok(workflow.includes(`Sddl="${PROTECTED_DACL}"`), "the WiX source no longer states this DACL");
    });

    it("never recurses with a tool that follows links", () => {
        // A junction costs nothing to plant, and a recursive takeown or icacls
        // walks through one into whatever it points at - as SYSTEM.
        assert.doesNotMatch(script, /takeown(\.exe)?['"]?\s[^\n]*\/R\b/i, "takeown /R follows junctions");
        assert.doesNotMatch(script, /icacls(\.exe)?['"]?\s[^\n]*\/T\b/i, "icacls /T follows junctions");
        assert.doesNotMatch(script, /-Recurse\b/, "a recursive cmdlet decides for itself what a directory is");
    });

    describe("what it does to an item another account may still control", () => {
        // A path is a name, and the account that planted a directory can make
        // "directory\child" name a file somewhere else between two uses of it.
        // The behavioural half proves the outcome on Windows; this half keeps
        // the means from quietly coming back on the runners that cannot.
        const native = script.slice(script.indexOf("$script:MySpeedNativeSource = @'"), script.indexOf("\n'@"));
        const body = (name) => {
            const start = script.indexOf(`function ${name} {`);
            assert.notEqual(start, -1, `the script defines no ${name}`);

            return script.slice(start, script.indexOf("\n}\n", start));
        };
        const acting = ["Lock-MySpeedQuarantined", "Remove-MySpeedVerifiedLink", "Move-MySpeedForeignItem"];

        it("opens it without following it, and asks the handle where it is", () => {
            assert.match(native, /FlagOpenReparsePoint = 0x00200000;/);
            assert.match(native, /FlagBackupSemantics \| FlagOpenReparsePoint/, "an item is opened through whatever it links to");
            assert.match(native, /GetFinalPathNameByHandleW\(handle,/);
            assert.match(body("Open-MySpeedVerified"), /\[string\]::Equals\(\$opened\.FinalPath, \$ExpectedFinal,/,
                "nothing compares where the item is with where it was expected to be");
        });

        it("reaches it only through that check", () => {
            for (const name of acting)
                assert.match(body(name), /Open-MySpeedVerified -Path \$Path -ExpectedFinal \$ExpectedFinal/,
                    `${name} opens an item some other way`);
            assert.equal(script.split("[MySpeedHandle]::Open(").length - 1, 2,
                "an item is opened outside Open-MySpeedVerified and the lookup of a directory this script vouches for");
        });

        it("changes, moves and removes it by its handle and never by its name", () => {
            for (const name of acting) {
                const text = body(name);

                assert.doesNotMatch(text, /SetAccessControl|Set-Acl|icacls|takeown/i, `${name} sets security by path`);
                assert.doesNotMatch(text, /\]::(Move|Delete)\(|Remove-Item|Move-Item|Rename-Item/, `${name} moves or removes by path`);
            }
            assert.doesNotMatch(script, /takeown/i, "takeown works on a path");
            assert.match(native, /SetKernelObjectSecurity\(handle,/);
            assert.doesNotMatch(native, /SetNamedSecurityInfo|SetFileSecurity/, "security is set by path");
        });

        it("hands nothing down to what is beneath it", () => {
            // Propagation rewrites the inherited entries of every child, and a
            // hard-linked child shares its descriptor with a file elsewhere.
            assert.doesNotMatch(native, /\bSetSecurityInfo\b/, "SetSecurityInfo propagates to children");
            assert.ok(script.includes("$script:MySpeedLockedFile = 'O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'"));
            assert.ok(script.includes('$script:MySpeedLockedDirectory = "O:BA$($script:MySpeedProtectedDacl)"'));
        });

        it("compiles nothing until there is something to quarantine", () => {
            assert.equal(script.split("Add-Type").length - 1, 1);
            assert.match(body("Import-MySpeedNative"), /Add-Type -TypeDefinition \$script:MySpeedNativeSource/);
            assert.doesNotMatch(script.slice(script.indexOf(`function ${ENTRY_POINT}`)), /Import-MySpeedNative|\[MySpeedHandle\]/,
                "an installation with nothing to move would compile the native source anyway");
        });

        it("keeps to the C# that Windows PowerShell's own compiler accepts", () => {
            // Add-Type in Windows PowerShell 5.1 compiles C# 5. None of this
            // can be compiled on the runners a pull request is checked on.
            assert.doesNotMatch(native, /\$"/, "interpolated strings are C# 6");
            assert.doesNotMatch(native, /\?\.|\?\[/, "null-conditional access is C# 6");
            assert.doesNotMatch(native, /\bnameof\(/, "nameof is C# 6");
            assert.doesNotMatch(native, /\)\s*=>|\bout var\b/, "expression bodies and inline out variables are newer than C# 5");
            assert.doesNotMatch(native, /\{ get; \}/, "getter-only auto-properties are C# 6");
        });
    });

    describe("its place in the installer", () => {
        it("is installed beside the binary, where only administrators can write", () => {
            assert.match(workflow, /<File Id="ProtectDataDirectoryScript" Source="protect-data-directory\.ps1"/);

            const group = workflow.slice(workflow.indexOf('<ComponentGroup Id="ProductComponents" Directory="INSTALLFOLDER">'),
                workflow.indexOf("</ComponentGroup>"));
            assert.ok(group.includes('Id="ProtectDataDirectoryScript"'),
                "a script the service account runs must not live in the directory it is there to distrust");
        });

        it("comes from the qualified source, not from wherever the runner finds one", () => {
            assert.ok(workflow.includes(`            ${SCRIPT_PATH}\n`), "the build never checks the script out");
            assert.match(workflow, /Copy-Item -LiteralPath \$env:PROTECTION_SCRIPT_SOURCE -Destination "installer\\protect-data-directory\.ps1" -ErrorAction Stop/);
            assert.match(workflow, /git -C \$env:PROTECTION_SCRIPT_CHECKOUT rev-parse HEAD/,
                "the checkout is never compared with the qualified source SHA");
        });

        it("runs as the service's own account, after the files exist and before the service starts", () => {
            const action = customAction("ProtectDataDirectory");

            assert.match(action, /Execute="deferred"/, "an immediate action runs as the installing user, unelevated");
            assert.match(action, /Impersonate="no"/, "an impersonated action cannot take ownership");
            assert.match(action, /DllEntry="WixQuietExec64"/);
            assert.match(workflow, /<Custom Action="ProtectDataDirectory" After="InstallFiles">NOT REMOVE<\/Custom>/);
        });

        it("fails the installation when the directory could not be secured", () => {
            assert.match(customAction("ProtectDataDirectory"), /Return="check"/,
                "an ignored failure installs a LocalSystem service over a directory nobody vouched for");
        });

        it("hands the script the directory the installer created", () => {
            const start = workflow.indexOf('<SetProperty Id="ProtectDataDirectory"');
            assert.notEqual(start, -1, "the deferred action is never given its command line");
            const property = workflow.slice(start, workflow.indexOf("/>", start));

            assert.match(property, /\[System64Folder\]WindowsPowerShell\\v1\.0\\powershell\.exe/,
                "a bare powershell.exe is resolved through PATH");
            assert.ok(property.includes("Get-Content -Raw -LiteralPath '[#ProtectDataDirectoryScript]' | Invoke-Expression"),
                "run as a file, the script is refused wherever group policy sets an execution policy");
            assert.ok(property.includes(`${ENTRY_POINT} -DataRoot '[DATAROOTFOLDER]'`));
            // Square brackets are property references to Windows Installer, and
            // a dollar sign is a variable to the here-string this lives in.
            assert.doesNotMatch(property.replaceAll(/\[(System64Folder|#ProtectDataDirectoryScript|DATAROOTFOLDER)\]/g, ""),
                /[[\]$]/, "the command line holds a character the installer or the here-string would rewrite");
        });
    });
});

// ----------------------------------------------------------------------------
// Behaviour, against real NTFS security descriptors in a temporary directory.
// ----------------------------------------------------------------------------

const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const ICACLS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const TAKEOWN = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "takeown.exe");
const POWERSHELL_TIMEOUT_MS = 60_000;
const SCRIPT_FILE = fileURLToPath(new URL(`../../${SCRIPT_PATH}`, import.meta.url));
const QUARANTINE_PREFIX = "MySpeed-quarantine-";

const powershell = (command) => spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", command],
    {encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS});

const elevated = process.platform === "win32" && powershell(
    "[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())"
    + ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))").stdout.trim() === "True";

const quoted = (value) => `'${value.replaceAll("'", "''")}'`;

describe("protecting a data directory", {skip: elevated ? false : "needs Windows and an elevated prompt"}, () => {
    let sandbox;
    let counter = 0;

    before(() => {
        sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-data-owner-")));
    });

    after(() => {
        // What the tests locked away has to be opened again before it can be
        // removed; nothing outside the sandbox is named here.
        spawnSync(TAKEOWN, ["/A", "/R", "/D", "Y", "/F", sandbox], {timeout: POWERSHELL_TIMEOUT_MS});
        spawnSync(ICACLS, [sandbox, "/reset", "/T", "/C", "/Q"], {timeout: POWERSHELL_TIMEOUT_MS});
        fs.rmSync(sandbox, {recursive: true, force: true});
    });

    /** A stand-in for C:\ProgramData with its own MySpeed inside, one per test. */
    const programData = () => {
        const directory = path.join(sandbox, `case-${++counter}`, "ProgramData");
        fs.mkdirSync(directory, {recursive: true});

        return {directory, root: path.join(directory, "MySpeed")};
    };

    const write = (file, text = "content") => {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, text);

        return file;
    };

    const icacls = (...parameters) => {
        const result = spawnSync(ICACLS, parameters, {encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS});
        assert.equal(result.status, 0, `icacls ${parameters.join(" ")} failed: ${result.stdout}${result.stderr}`);
    };

    const ownedBy = (target, sid) => icacls(target, "/setowner", `*${sid}`, "/L", "/Q");
    const grant = (target, sid, rights) => icacls(target, "/grant", `*${sid}:${rights}`, "/Q");
    const junction = (link, target) => fs.symlinkSync(target, link, "junction");

    /** Exactly the command line the installer builds, aimed at the sandbox. */
    const protect = (root) => {
        assert.ok(root.startsWith(sandbox + path.sep), "the script is only ever run against the sandbox");

        return powershell(`Get-Content -Raw -LiteralPath ${quoted(SCRIPT_FILE)} | Invoke-Expression; `
            + `${ENTRY_POINT} -DataRoot ${quoted(root + path.sep)}`);
    };

    const succeeded = (result) =>
        assert.equal(result.status, 0, `the script failed:\n${result.stdout}\n${result.stderr}`);

    /** Owner, DACL and whether BUILTIN\Users is named in it, for several paths at once. */
    const security = (...targets) => {
        const result = powershell(`$ErrorActionPreference='Stop'; ConvertTo-Json -Compress @(${targets.map(quoted).join(",")} | ForEach-Object {`
            + " $acl = Get-Acl -LiteralPath $_;"
            + " [pscustomobject]@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;"
            + " sddl = $acl.GetSecurityDescriptorSddlForm('Access');"
            + ` users = [bool]($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq '${USERS_SID}' });`
            + ` backup = [bool]($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq '${BACKUP_OPERATORS_SID}' }) } })`);
        assert.equal(result.status, 0, `could not read the security of ${targets.join(", ")}: ${result.stderr}`);

        return JSON.parse(result.stdout);
    };

    const quarantines = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith(QUARANTINE_PREFIX));

    const onlyQuarantine = (directory) => {
        const found = quarantines(directory);
        assert.equal(found.length, 1, `expected one quarantine folder, found ${JSON.stringify(found)}`);

        return path.join(directory, found[0]);
    };

    const currentUserSid = () => powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value").stdout.trim();

    it("does nothing where there is no data directory yet", () => {
        const {directory, root} = programData();

        succeeded(protect(root));

        assert.equal(fs.existsSync(root), false, "the installer creates the directory, with its ACL - not this script");
        assert.deepEqual(quarantines(directory), []);
    });

    it("leaves an administrator's installation where it is", () => {
        const {directory, root} = programData();
        const database = write(path.join(root, "data", "storage.db"), "history");
        const binary = write(path.join(root, "bin", "speedtest.exe"), "cli");

        succeeded(protect(root));

        assert.deepEqual(quarantines(directory), [], "files an administrator owns were treated as planted");
        assert.equal(fs.readFileSync(database, "utf8"), "history");
        assert.equal(fs.readFileSync(binary, "utf8"), "cli");
    });

    it("closes the directory to everyone but SYSTEM and administrators", () => {
        const {root} = programData();
        fs.mkdirSync(root, {recursive: true});
        // What releases before 1.5.3 left behind: the grant ProgramData hands
        // down, inherited by everything made beneath it.
        grant(root, USERS_SID, "(OI)(CI)(M)");
        const binary = write(path.join(root, "bin", "speedtest.exe"));
        assert.equal(security(binary)[0].users, true, "the fixture never reproduced the inherited grant");

        succeeded(protect(root));

        const [rootSecurity, binarySecurity] = security(root, binary);
        assert.match(rootSecurity.sddl, /^D:P(AI)?\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)$/);
        assert.equal(binarySecurity.users, false,
            "a file made before the DACL was protected still answers to every local account");
    });

    it("keeps an access entry an administrator added on purpose", () => {
        const {root} = programData();
        const shared = path.join(root, "data");
        write(path.join(shared, "storage.db"));
        grant(shared, BACKUP_OPERATORS_SID, "(OI)(CI)(RX)");

        succeeded(protect(root));

        assert.equal(security(shared)[0].backup, true,
            "the operator's own grant to a backup account was thrown away with the inherited ones");
    });

    it("moves a file another account planted out of the directory, and nothing else", () => {
        const {directory, root} = programData();
        const database = write(path.join(root, "data", "storage.db"), "history");
        const planted = write(path.join(root, "bin", "iperf3.exe"), "payload");
        const kept = write(path.join(root, "bin", "speedtest.exe"), "cli");
        ownedBy(planted, USERS_SID);

        succeeded(protect(root));

        const quarantine = onlyQuarantine(directory);
        assert.equal(fs.existsSync(planted), false, "the planted executable is still where the server would run it");
        assert.equal(fs.readFileSync(path.join(quarantine, "MySpeed", "bin", "iperf3.exe"), "utf8"), "payload",
            "the planted file was deleted rather than kept for the administrator to look at");
        assert.equal(fs.readFileSync(database, "utf8"), "history");
        assert.equal(fs.readFileSync(kept, "utf8"), "cli");
    });

    it("moves a planted directory whole, including what an administrator later put in it", () => {
        const {directory, root} = programData();
        write(path.join(root, "data", "storage.db"));
        const planted = path.join(root, "build");
        write(path.join(planted, "index.html"), "<script>");
        ownedBy(planted, USERS_SID);

        succeeded(protect(root));

        const quarantine = onlyQuarantine(directory);
        assert.equal(fs.existsSync(planted), false, "the server would still serve the planted client");
        assert.equal(fs.readFileSync(path.join(quarantine, "MySpeed", "build", "index.html"), "utf8"), "<script>");
    });

    it("locks what it quarantined away from the account that planted it", () => {
        const {directory, root} = programData();
        write(path.join(root, "data", "storage.db"));
        const planted = path.join(root, "build");
        const payload = write(path.join(planted, "nested", "payload.js"));
        // A DACL of the planter's own choosing, protected against inheritance,
        // on the directory and on what is inside it. Deepest first: once a
        // directory is closed, what is beneath it can no longer be reached to
        // be given the same treatment.
        for (const target of [payload, path.join(planted, "nested"), planted]) {
            ownedBy(target, USERS_SID);
            icacls(target, "/inheritance:r", "/grant:r", `*${USERS_SID}:F`, "/Q");
        }

        succeeded(protect(root));

        const quarantine = onlyQuarantine(directory);
        const moved = path.join(quarantine, "MySpeed", "build");
        const all = security(quarantine, moved, path.join(moved, "nested"), path.join(moved, "nested", "payload.js"));
        for (const entry of all) {
            assert.equal(entry.owner, ADMINISTRATORS_SID, "a quarantined item is still owned by the account that planted it");
            assert.equal(entry.users, false, "a quarantined item is still open to every local account");
        }
        assert.match(all[0].sddl, /^D:P(AI)?\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)$/);
        // Each item's DACL is its own and inherits from nobody, so it stays
        // closed wherever an administrator later moves it.
        assert.equal(all[1].sddl, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        assert.equal(all[2].sddl, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        assert.equal(all[3].sddl, "D:P(A;;FA;;;SY)(A;;FA;;;BA)");
    });

    it("says what it moved, and why, where the administrator will find it", () => {
        const {directory, root} = programData();
        const planted = write(path.join(root, "bin", "iperf3.exe"));
        ownedBy(planted, USERS_SID);

        const result = protect(root);
        succeeded(result);

        const readme = fs.readFileSync(path.join(onlyQuarantine(directory), "README.txt"), "utf8");
        assert.ok(readme.includes(path.join("bin", "iperf3.exe")), "the note does not name the file");
        assert.ok(readme.includes(USERS_SID), "the note does not say whose it was");
        assert.match(result.stdout, /quarantin/i, "the installer log says nothing about it");
    });

    it("replaces a directory another account created before the installation", () => {
        const {directory, root} = programData();
        write(path.join(root, "bin", "speedtest.exe"), "payload");
        write(path.join(root, "data", "storage.db"), "prepared");
        write(path.join(root, "bunfig.toml"), "preload");
        ownedBy(root, USERS_SID);

        succeeded(protect(root));

        const quarantine = onlyQuarantine(directory);
        // Everything, including what looks like the service's own: under a
        // directory somebody else controls, an owner of SYSTEM proves nothing.
        assert.equal(fs.readFileSync(path.join(quarantine, "MySpeed", "bin", "speedtest.exe"), "utf8"), "payload");
        assert.equal(fs.readFileSync(path.join(quarantine, "MySpeed", "data", "storage.db"), "utf8"), "prepared");
        assert.equal(fs.readFileSync(path.join(quarantine, "MySpeed", "bunfig.toml"), "utf8"), "preload");

        assert.deepEqual(fs.readdirSync(root).sort(), ["data", "logs"],
            "the new directory holds something from the old one, or lacks what the service writes into");
        const [rootSecurity] = security(root);
        assert.equal(rootSecurity.owner, ADMINISTRATORS_SID);
        assert.match(rootSecurity.sddl, /^D:P(AI)?\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)$/);
    });

    it("replaces a directory that was created again while the old one was being moved away", () => {
        // ProgramData lets any account make a folder, so the instant between
        // moving the old directory out and making the new one is an opening:
        // creating a directory that already exists succeeds and applies no
        // security at all. Reproduced here by calling the step that builds the
        // new root with somebody else's directory already standing in its place.
        const {directory, root} = programData();
        write(path.join(root, "bin", "speedtest.exe"), "planted again");
        ownedBy(root, USERS_SID);

        const result = powershell(`Get-Content -Raw -LiteralPath ${quoted(SCRIPT_FILE)} | Invoke-Expression; `
            + "$ErrorActionPreference = 'Stop'; $notes = New-Object System.Collections.Generic.List[string]; "
            + `$quarantine = New-MySpeedQuarantine ${quoted(root)}; `
            + `New-MySpeedDataRoot -Root ${quoted(root)} -Quarantine $quarantine -Notes $notes`);
        succeeded(result);

        assert.deepEqual(fs.readdirSync(root), [], "the directory another account made is the new data root");
        assert.equal(security(root)[0].owner, ADMINISTRATORS_SID);
        assert.equal(fs.readFileSync(path.join(onlyQuarantine(directory), "MySpeed-2", "bin", "speedtest.exe"), "utf8"),
            "planted again");
        assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes("-new-")), [],
            "a staging directory was left behind");
    });

    it("builds the new directory under an unpredictable name and renames it into place", () => {
        const build = script.slice(script.indexOf("function New-MySpeedDataRoot"),
            script.indexOf("function Write-MySpeedQuarantineReadme"));

        assert.match(build, /\[System\.Guid\]::NewGuid\(\)/, "the staging name can be guessed and created first");
        assert.match(build, /\[System\.IO\.Directory\]::Move\(\$staging, \$Root\)/,
            "the root is created in place, which succeeds silently over a directory somebody else just made");
        assert.doesNotMatch(build, /New-MySpeedPrivateDirectory \$Root/);
    });

    it("vouches for the directory once more before anything is created in it", () => {
        const entry = script.slice(script.indexOf(`function ${ENTRY_POINT}`));
        const check = entry.indexOf("still does not belong to an administrator");

        assert.notEqual(check, -1, "nothing confirms the outcome before the service is started");
        assert.ok(check < entry.indexOf("$script:MySpeedServiceFolders"),
            "the service's folders are created before the directory has been vouched for");
    });

    it("drops a planted hard link without touching the file it names", () => {
        // A hard link shares one security descriptor with the file's other
        // names, so quarantining it the usual way - take ownership, reset the
        // DACL - would rewrite the security of a file outside the directory.
        const {directory, root} = programData();
        write(path.join(root, "data", "storage.db"));
        const original = write(path.join(directory, "elsewhere", "shared.txt"), "shared");
        ownedBy(original, USERS_SID);
        grant(original, USERS_SID, "(M)");
        const before = security(original);
        const link = path.join(root, "bin", "iperf3.exe");
        fs.mkdirSync(path.dirname(link), {recursive: true});
        fs.linkSync(original, link);

        succeeded(protect(root));

        assert.equal(fs.existsSync(link), false, "the planted name is still in the directory");
        assert.equal(fs.readFileSync(original, "utf8"), "shared", "the file itself was removed with its second name");
        assert.deepEqual(security(original), before, "the file's security was rewritten through its second name");
        assert.match(fs.readFileSync(path.join(onlyQuarantine(directory), "README.txt"), "utf8"), /hard link/);
    });

    it("drops a hard link inside a planted directory the same way", () => {
        const {directory, root} = programData();
        write(path.join(root, "data", "storage.db"));
        const original = write(path.join(directory, "elsewhere", "shared.txt"), "shared");
        ownedBy(original, USERS_SID);
        grant(original, USERS_SID, "(M)");
        const before = security(original);
        const planted = path.join(root, "build");
        fs.mkdirSync(planted, {recursive: true});
        fs.linkSync(original, path.join(planted, "index.html"));
        ownedBy(planted, USERS_SID);

        succeeded(protect(root));

        assert.equal(fs.existsSync(path.join(onlyQuarantine(directory), "MySpeed", "build", "index.html")), false,
            "the second name was carried into the quarantine, where locking it rewrites the file it names");
        assert.equal(fs.readFileSync(original, "utf8"), "shared");
        assert.deepEqual(security(original), before, "the file's security was rewritten through its second name");
    });

    it("trusts a member of the administrators group as it trusts the group", () => {
        // The legacy migration copies an old database in as the installing
        // user, whose files are then owned by that user rather than by the
        // group - and whoever can install this is an administrator.
        const {directory, root} = programData();
        const database = write(path.join(root, "data", "storage.db"), "migrated");
        ownedBy(root, currentUserSid());
        ownedBy(database, currentUserSid());

        succeeded(protect(root));

        assert.deepEqual(quarantines(directory), [], "an administrator's own files were quarantined");
        assert.equal(fs.readFileSync(database, "utf8"), "migrated");
    });

    describe("links", () => {
        /** Somewhere a planted link points, with something in it worth protecting. */
        const outside = (directory) => {
            const target = path.join(directory, "elsewhere");
            const canary = write(path.join(target, "canary.txt"), "canary");
            grant(target, USERS_SID, "(OI)(CI)(M)");

            return {target, canary, before: security(target, canary)};
        };

        const untouched = ({target, canary, before}) => {
            assert.equal(fs.readFileSync(canary, "utf8"), "canary", "the link was followed and its target emptied");
            assert.deepEqual(security(target, canary), before, "the link was followed and its target's security rewritten");
        };

        it("removes a planted link without following it", () => {
            const {directory, root} = programData();
            const elsewhere = outside(directory);
            write(path.join(root, "data", "storage.db"));
            const link = path.join(root, "bin");
            junction(link, elsewhere.target);
            ownedBy(link, USERS_SID);

            const result = protect(root);
            succeeded(result);

            assert.equal(fs.existsSync(link), false, "the server would still run executables from wherever the link points");
            untouched(elsewhere);
            assert.ok(fs.readFileSync(path.join(onlyQuarantine(directory), "README.txt"), "utf8").includes(elsewhere.target),
                "the note does not say where the link pointed");
        });

        it("does not follow a link inside a planted directory", () => {
            const {directory, root} = programData();
            const elsewhere = outside(directory);
            write(path.join(root, "data", "storage.db"));
            const planted = path.join(root, "build");
            write(path.join(planted, "index.html"));
            junction(path.join(planted, "assets"), elsewhere.target);
            ownedBy(planted, USERS_SID);

            succeeded(protect(root));

            untouched(elsewhere);
            assert.equal(fs.existsSync(path.join(onlyQuarantine(directory), "MySpeed", "build", "assets")), false,
                "a link somebody else made is still standing in the quarantine");
        });

        it("replaces a planted link standing where the data directory belongs", () => {
            const {directory, root} = programData();
            const elsewhere = outside(directory);
            junction(root, elsewhere.target);
            ownedBy(root, USERS_SID);

            succeeded(protect(root));

            untouched(elsewhere);
            assert.equal(fs.lstatSync(root).isSymbolicLink(), false, "the service would still write wherever the link points");
            assert.deepEqual(fs.readdirSync(root).sort(), ["data", "logs"]);
            assert.equal(security(root)[0].owner, ADMINISTRATORS_SID);
        });

        describe("whose target the service's own account owns", () => {
            // A link is judged by who made the link. Were its owner read
            // through it, a link any account planted at a folder SYSTEM owns
            // would pass for one an administrator made and be left in place,
            // for its maker to point somewhere else once the service runs.
            // Windows PowerShell reads the link's own owner; these keep it so.
            const systemOwned = (directory) => {
                const elsewhere = outside(directory);
                ownedBy(elsewhere.canary, SYSTEM_SID);
                ownedBy(elsewhere.target, SYSTEM_SID);

                return {...elsewhere, before: security(elsewhere.target, elsewhere.canary)};
            };

            for (const [kind, type, leaf, aim] of [
                ["junction", "junction", "bin", "target"],
                ["directory symbolic link", "dir", "bin", "target"],
                ["file symbolic link", "file", path.join("bin", "iperf3.exe"), "canary"],
            ]) {
                it(`removes a planted ${kind} from the data directory`, () => {
                    const {directory, root} = programData();
                    const elsewhere = systemOwned(directory);
                    write(path.join(root, "data", "storage.db"));
                    const link = path.join(root, leaf);
                    fs.mkdirSync(path.dirname(link), {recursive: true});
                    fs.symlinkSync(elsewhere[aim], link, type);
                    ownedBy(link, USERS_SID);

                    succeeded(protect(root));

                    assert.throws(() => fs.lstatSync(link), {code: "ENOENT"}, "the link passed for one an administrator made");
                    untouched(elsewhere);
                    assert.ok(fs.readFileSync(path.join(onlyQuarantine(directory), "README.txt"), "utf8").includes(elsewhere[aim]),
                        "the note does not say where the link pointed");
                });
            }

            for (const [kind, type] of [["junction", "junction"], ["directory symbolic link", "dir"]]) {
                it(`replaces a planted ${kind} standing where the data directory belongs`, () => {
                    const {directory, root} = programData();
                    const elsewhere = systemOwned(directory);
                    fs.symlinkSync(elsewhere.target, root, type);
                    ownedBy(root, USERS_SID);

                    const result = protect(root);
                    succeeded(result);

                    assert.doesNotMatch(result.stdout, /a link an administrator created/);
                    assert.equal(fs.lstatSync(root).isSymbolicLink(), false, "the service would still write wherever the link points");
                    assert.deepEqual(fs.readdirSync(root).sort(), ["data", "logs"]);
                    untouched(elsewhere);
                });
            }
        });

        it("leaves a link an administrator made, and what it points at, alone", () => {
            // The operator who moved the database to another volume did it on
            // purpose - the same reading install.sh gives a symlinked data
            // directory.
            const {directory, root} = programData();
            const elsewhere = outside(directory);
            fs.mkdirSync(root, {recursive: true});
            const link = path.join(root, "data");
            junction(link, elsewhere.target);

            succeeded(protect(root));

            assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "the operator's own link was removed");
            untouched(elsewhere);
            assert.deepEqual(quarantines(directory), []);
        });
    });

    describe("a directory swapped for a link while it is being dealt with", () => {
        // The check and the act are two steps, and the account that planted a
        // directory can still reach it between them: through a handle it opened
        // beforehand, or by path, since traversing a closed folder is a right
        // every account has. Emptying a directory and turning it into a
        // junction then makes "directory\child" name a file somewhere else -
        // and a path is followed through every component but its last.
        //
        // The race is reproduced, not run: a function the script calls between
        // its two steps is wrapped, and the wrapper makes the swap at exactly
        // the moment the planter would have to win.
        const LOAD = `Get-Content -Raw -LiteralPath ${quoted(SCRIPT_FILE)} | Invoke-Expression; `;

        /** Somewhere else, holding a file whose security is its own and not inherited. */
        const guarded = (directory, name) => {
            const target = path.join(directory, "elsewhere");
            const victim = write(path.join(target, name), "another service's file");
            icacls(victim, "/inheritance:r", "/grant:r", `*${SYSTEM_SID}:F`, `*${ADMINISTRATORS_SID}:F`, "/Q");
            ownedBy(victim, SYSTEM_SID);

            return {target, victim, before: security(target, victim)};
        };

        const untouched = ({target, victim, before}) => {
            assert.equal(fs.existsSync(victim), true, "a file outside the data directory was moved or deleted");
            assert.equal(fs.readFileSync(victim, "utf8"), "another service's file");
            assert.deepEqual(security(target, victim), before, "a file outside the data directory had its security rewritten");
        };

        const swap = (parent, target) => `[System.IO.File]::Delete((Join-Path ${quoted(parent)} ${quoted(path.basename(target.victim))})); `
            + `[System.IO.Directory]::Delete(${quoted(parent)}); `
            + `[void](New-Item -ItemType Junction -Path ${quoted(parent)} -Target ${quoted(target.target)}); `;

        it("does not lock a file outside the quarantine", () => {
            const {directory, root} = programData();
            const elsewhere = guarded(directory, "payload.js");
            write(path.join(root, "data", "storage.db"));
            const planted = path.join(root, "build");
            write(path.join(planted, "assets", "payload.js"), "decoy");
            ownedBy(planted, USERS_SID);

            // The swap happens after `assets` has been listed and before the
            // file in it is dealt with, wherever the quarantine has put it.
            const result = powershell(`${LOAD}$lock = \${function:Lock-MySpeedQuarantined}; $script:swapped = $false; `
                + "function Lock-MySpeedQuarantined { param([string]$Path, [string]$ExpectedFinal, [System.Collections.Generic.List[string]]$Notes) "
                + "if (-not $script:swapped -and $Path -like '*\\assets\\payload.js') { $script:swapped = $true; $parent = Split-Path -Parent $Path; "
                + "[System.IO.File]::Delete($Path); [System.IO.Directory]::Delete($parent); "
                + `[void](New-Item -ItemType Junction -Path $parent -Target ${quoted(elsewhere.target)}) } `
                + "& $lock @PSBoundParameters }; "
                + `${ENTRY_POINT} -DataRoot ${quoted(root + path.sep)}`);

            succeeded(result);
            untouched(elsewhere);
            assert.match(fs.readFileSync(path.join(onlyQuarantine(directory), "README.txt"), "utf8"), /COULD NOT LOCK[^\n]*payload\.js/,
                "the note does not say that an item could not be vouched for");
        });

        it("does not move a file from outside the data directory, and stops the installation", () => {
            const {directory, root} = programData();
            const elsewhere = guarded(directory, "iperf3.exe");
            write(path.join(root, "data", "storage.db"));
            const bin = path.join(root, "bin");
            ownedBy(write(path.join(bin, "iperf3.exe"), "payload"), USERS_SID);

            // The swap happens after the directory has been searched and
            // before what the search found is moved.
            const result = powershell(`${LOAD}$scan = \${function:Get-MySpeedForeignItems}; $script:depth = 0; $script:swapped = $false; `
                + "function Get-MySpeedForeignItems { param([string]$Directory, [string[]]$Trusted) "
                + "$script:depth++; $found = @(& $scan @PSBoundParameters); $script:depth--; "
                + `if ($script:depth -eq 0 -and -not $script:swapped) { $script:swapped = $true; ${swap(bin, elsewhere)}} `
                + "$found }; "
                + `${ENTRY_POINT} -DataRoot ${quoted(root + path.sep)}`);

            untouched(elsewhere);
            assert.notEqual(result.status, 0, "a service would be started over a directory that changed under the check");
            assert.match(`${result.stdout}${result.stderr}`, /changed while it was being checked/);
        });

        // A deletion can be left pending for as long as somebody else holds the
        // item open, and called off by them once the installer has gone. So a
        // link has to be out of the directory the moment it is dealt with, and
        // gone for good - seen here while the planter's handle is still open.
        const listing = (label, directory) => `if (Test-Path -LiteralPath ${quoted(directory)}) { `
            + `[System.IO.Directory]::GetFileSystemEntries(${quoted(directory)}) | ForEach-Object { '${label} ' + [System.IO.Path]::GetFileName($_) } }; `;

        const whileHeld = (held, root, ...listings) => powershell(`${LOAD}Import-MySpeedNative; `
            + `$held = [MySpeedHandle]::Open(${quoted(held)}, [MySpeedHandle]::ForRemoving); `
            + `try { ${ENTRY_POINT} -DataRoot ${quoted(root + path.sep)} | Out-Null; ${listings.join("")}} finally { $held.Dispose() }`);

        const lines = (result) => result.stdout.trim().split(/\r?\n/).filter(Boolean).sort();

        it("takes a planted link out of the data directory at once, whoever holds it open", () => {
            const {directory, root} = programData();
            const elsewhere = guarded(directory, "payload.js");
            write(path.join(root, "data", "storage.db"));
            const link = path.join(root, "bin");
            junction(link, elsewhere.target);
            ownedBy(link, USERS_SID);

            const result = whileHeld(link, root, listing("root", root),
                `Get-ChildItem -LiteralPath ${quoted(directory)} -Filter '${QUARANTINE_PREFIX}*' | ForEach-Object { `
                + "[System.IO.Directory]::GetFileSystemEntries((Join-Path $_.FullName 'MySpeed')) | ForEach-Object { 'quarantine ' + [System.IO.Path]::GetFileName($_) } }; ");

            succeeded(result);
            assert.deepEqual(lines(result), ["root data", "root logs"],
                "the link is still in the data directory, or waiting in the quarantine for its deletion to be called off");
            untouched(elsewhere);
        });

        it("removes a link inside a quarantined directory at once, whoever holds it open", () => {
            // The locking step on its own: a directory cannot be moved at all
            // while something in it is held open, which stops the installation
            // before this step is reached.
            const {directory} = programData();
            const elsewhere = guarded(directory, "payload.js");
            const planted = path.join(directory, "build");
            write(path.join(planted, "index.html"));
            junction(path.join(planted, "assets"), elsewhere.target);

            const result = powershell(`${LOAD}$ErrorActionPreference = 'Stop'; $notes = New-Object System.Collections.Generic.List[string]; `
                + `$final = Get-MySpeedFinalPath ${quoted(directory)}; `
                + `$held = [MySpeedHandle]::Open(${quoted(path.join(planted, "assets"))}, [MySpeedHandle]::ForRemoving); `
                + `try { Lock-MySpeedQuarantined -Path ${quoted(planted)} -ExpectedFinal "$final\\build" -Notes $notes; `
                + `${listing("build", planted)}$notes | ForEach-Object { "note $_" } } finally { $held.Dispose() }`);

            succeeded(result);
            const [entry, note, ...rest] = lines(result);
            assert.equal(entry, "build index.html", "the link's deletion is pending, and its holder can call it off");
            assert.match(note, /^note removed link /);
            assert.deepEqual(rest, []);
            untouched(elsewhere);
        });

        it("stops the installation over a planted directory that is held open from inside", () => {
            const {directory, root} = programData();
            const elsewhere = guarded(directory, "payload.js");
            write(path.join(root, "data", "storage.db"));
            const planted = path.join(root, "build");
            write(path.join(planted, "index.html"));
            junction(path.join(planted, "assets"), elsewhere.target);
            ownedBy(planted, USERS_SID);

            const result = whileHeld(path.join(planted, "assets"), root);

            assert.notEqual(result.status, 0, "a directory that could not be moved was left for the service to use");
            assert.match(result.stderr, /could not be taken out of the data directory/);
            untouched(elsewhere);
        });

        it("drops a second name for a read-only file", () => {
            const {directory, root} = programData();
            write(path.join(root, "data", "storage.db"));
            const original = write(path.join(directory, "elsewhere", "shared.txt"), "shared");
            ownedBy(original, USERS_SID);
            const link = path.join(root, "bin", "iperf3.exe");
            fs.mkdirSync(path.dirname(link), {recursive: true});
            fs.linkSync(original, link);
            fs.chmodSync(original, 0o444);

            try {
                succeeded(protect(root));

                assert.equal(fs.existsSync(link), false, "a read-only attribute kept a planted name in the directory");
                assert.equal(fs.readFileSync(original, "utf8"), "shared");
                assert.equal(fs.statSync(original).mode & 0o200, 0, "the file elsewhere lost its read-only attribute");
            } finally {
                fs.chmodSync(original, 0o666);
            }
        });

        /** A step of the script on its own, with the location of `directory` as a handle reports it in $final. */
        const step = (directory, command) => powershell(`${LOAD}$ErrorActionPreference = 'Stop'; `
            + "$notes = New-Object System.Collections.Generic.List[string]; "
            + `$final = Get-MySpeedFinalPath ${quoted(directory)}; ${command}`);

        it("opens an item only where it is expected to be", () => {
            const {directory} = programData();
            const elsewhere = guarded(directory, "payload.js");
            const link = path.join(directory, "link");
            junction(link, elsewhere.target);

            const through = step(directory, `Open-MySpeedVerified -Path ${quoted(path.join(link, "payload.js"))} `
                + "-ExpectedFinal \"$final\\link\\payload.js\" -Access ([MySpeedHandle]::ForReading)");
            assert.notEqual(through.status, 0, "a path through a link was taken for the item it names");
            assert.match(through.stderr, /changed while it was being checked/);

            const direct = step(elsewhere.target, `$opened = Open-MySpeedVerified -Path ${quoted(elsewhere.victim)} `
                + "-ExpectedFinal \"$final\\payload.js\" -Access ([MySpeedHandle]::ForReading); "
                + "\"$($opened.Owner) $($opened.IsLink) $($opened.IsHardLink) $($opened.IsDirectory)\"; $opened.Dispose()");
            succeeded(direct);
            assert.equal(direct.stdout.trim(), `${SYSTEM_SID} False False False`);
        });

        it("reads a link as a link and a second name as a second name", () => {
            const {directory} = programData();
            const elsewhere = guarded(directory, "payload.js");
            const link = path.join(directory, "link");
            const second = path.join(directory, "second.js");
            junction(link, elsewhere.target);
            fs.linkSync(elsewhere.victim, second);

            const result = step(directory, "foreach ($name in 'link', 'second.js') { "
                + `$opened = Open-MySpeedVerified -Path (Join-Path ${quoted(directory)} $name) -ExpectedFinal "$final\\$name" `
                + "-Access ([MySpeedHandle]::ForReading); \"$($opened.IsLink) $($opened.IsHardLink) $($opened.IsDirectory)\"; $opened.Dispose() }");

            succeeded(result);
            assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["True False True", "False True False"]);
        });

        it("leaves an item that an administrator owns by the time it is opened", () => {
            const {directory, root} = programData();
            const kept = write(path.join(root, "bin", "speedtest.exe"), "cli");
            const destination = path.join(directory, "quarantine", "speedtest.exe");

            const result = step(root, `Move-MySpeedForeignItem -Path ${quoted(kept)} -ExpectedFinal "$final\\bin\\speedtest.exe" `
                + `-Destination ${quoted(destination)} -Relative 'bin\\speedtest.exe' `
                + `-Trusted @('${ADMINISTRATORS_SID}', ${quoted(currentUserSid())}) -Notes $notes; $notes.Count`);

            succeeded(result);
            assert.deepEqual(result.stdout.trim().split(/\r?\n/), ["False", "0"]);
            assert.equal(fs.readFileSync(kept, "utf8"), "cli");
            assert.equal(fs.existsSync(destination), false);
        });

        it("removes nothing that turned out not to be a link", () => {
            const {root} = programData();
            const file = write(path.join(root, "bin", "speedtest.exe"), "cli");

            const result = step(root, `Remove-MySpeedVerifiedLink -Path ${quoted(file)} -ExpectedFinal "$final\\bin\\speedtest.exe"`);

            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /no longer a link/);
            assert.equal(fs.readFileSync(file, "utf8"), "cli", "a file was deleted as though it were a link");
        });

        it("says so, and moves nothing, where an item cannot be opened for moving", () => {
            const {directory, root} = programData();
            const planted = write(path.join(root, "bin", "iperf3.exe"), "payload");
            ownedBy(planted, USERS_SID);

            // Held open without leave to delete, as a planter would hold it.
            const result = step(root, `$held = [System.IO.File]::Open(${quoted(planted)}, 'Open', 'Read', 'Read'); `
                + `try { Move-MySpeedForeignItem -Path ${quoted(planted)} -ExpectedFinal "$final\\bin\\iperf3.exe" `
                + `-Destination ${quoted(path.join(directory, "quarantine", "iperf3.exe"))} -Relative 'bin\\iperf3.exe' `
                + `-Trusted @('${ADMINISTRATORS_SID}') -Notes $notes } finally { $held.Dispose() }`);

            assert.notEqual(result.status, 0, "an item that stayed in the data directory was passed over in silence");
            assert.match(result.stderr, /could not be taken out of the data directory/);
            assert.equal(fs.readFileSync(planted, "utf8"), "payload");
        });
    });

    it("finds nothing to do the second time", () => {
        const {directory, root} = programData();
        const planted = write(path.join(root, "bin", "iperf3.exe"));
        write(path.join(root, "data", "storage.db"), "history");
        ownedBy(planted, USERS_SID);

        succeeded(protect(root));
        succeeded(protect(root));

        assert.equal(quarantines(directory).length, 1, "a clean directory was quarantined again");
        assert.equal(fs.readFileSync(path.join(root, "data", "storage.db"), "utf8"), "history");
    });

    it("refuses to guess the directory", () => {
        const result = powershell(`Get-Content -Raw -LiteralPath ${quoted(SCRIPT_FILE)} | Invoke-Expression; `
            + `${ENTRY_POINT} -DataRoot ''`);

        assert.notEqual(result.status, 0, "an empty directory name was accepted");
    });
});
