import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {sealInstalledBaseDescriptor} from
    "../../scripts/qualification/windows-msi-installed-base-seal-helper.mjs";

const NONCE = "0123456789abcdef0123456789abcdef";
const IMAGE = `/home/runner/work/_temp/myspeed-windows-cpu-floor-${NONCE}/system.qcow2`;

function stat(overrides = {}) {
    return {isFile: () => true, dev: 8n, ino: 1234n, nlink: 1n, size: 4_294_967_296n,
        uid: 1001n, gid: 1001n, mode: 0o100600n, ...overrides};
}

describe("privileged installed-base descriptor seal helper", () => {
    it("changes ownership and mode on the same verified no-follow descriptor", () => {
        const calls = [];
        const before = stat();
        const after = stat({uid: 0n, gid: 0n, mode: 0o100444n});
        const result = sealInstalledBaseDescriptor({nonce: NONCE, path: IMAGE, dev: "8", ino: "1234"}, {
            assertRuntime() { calls.push("runtime"); },
            openReadNoFollow(target) { calls.push(["open", target]); return 17; },
            readDescriptorPath(descriptor) { calls.push(["path", descriptor]); return IMAGE; },
            fstat(descriptor) { calls.push(["stat", descriptor]);
                return calls.filter(value => Array.isArray(value) && value[0] === "stat").length === 1 ? before : after; },
            fchown(descriptor, uid, gid) { calls.push(["chown", descriptor, uid, gid]); },
            fchmod(descriptor, mode) { calls.push(["chmod", descriptor, mode]); },
            close(descriptor) { calls.push(["close", descriptor]); }
        });
        assert.deepEqual(calls, ["runtime", ["open", IMAGE], ["path", 17], ["stat", 17],
            ["chown", 17, 0, 0], ["chmod", 17, 0o444], ["path", 17], ["stat", 17], ["close", 17]]);
        assert.deepEqual(result, {path: IMAGE, dev: "8", ino: "1234", uid: "0", gid: "0", mode: "444"});
        assert.ok(Object.isFrozen(result));
    });

    it("rejects aliases, hard links, and changed identities before or after mutation", () => {
        const requests = [
            {request: {nonce: NONCE, path: `${IMAGE}.other`, dev: "8", ino: "1234"}},
            {descriptorPath: `${IMAGE}.alias`},
            {descriptorPathAfter: `${IMAGE}.renamed`},
            {before: stat({nlink: 2n})},
            {before: stat({ino: 1235n})},
            {after: stat({uid: 0n, gid: 0n, mode: 0o100444n, ino: 1235n})},
            {after: stat({uid: 0n, gid: 0n, mode: 0o100644n})}
        ];
        for (const candidate of requests) {
            const calls = [];
            const request = candidate.request ?? {nonce: NONCE, path: IMAGE, dev: "8", ino: "1234"};
            assert.throws(() => sealInstalledBaseDescriptor(request, {
                assertRuntime() {}, openReadNoFollow() { calls.push("open"); return 19; },
                readDescriptorPath() { calls.push("path");
                    const reads = calls.filter(value => value === "path").length;
                    return candidate.descriptorPath ?? (reads > 1 ? candidate.descriptorPathAfter ?? IMAGE : IMAGE); },
                fstat() { calls.push("stat"); return calls.filter(value => value === "stat").length === 1 ?
                    (candidate.before ?? stat()) : (candidate.after ?? stat({uid: 0n, gid: 0n, mode: 0o100444n})); },
                fchown() { calls.push("chown"); }, fchmod() { calls.push("chmod"); }, close() { calls.push("close"); }
            }));
            if (candidate.request) assert.deepEqual(calls, []);
            else assert.equal(calls.at(-1), "close");
            if (candidate.descriptorPath) assert.equal(calls.includes("chown"), false);
        }
    });
});
