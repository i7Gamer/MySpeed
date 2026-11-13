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
            assert.match(line, /^(#|function |\}|\$script:[A-Za-z]+ = |Set-StrictMode )/,
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
