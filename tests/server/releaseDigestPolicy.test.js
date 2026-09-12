import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {validateReleaseDigestPolicy} from '../../scripts/release/qualification-manifest.mjs';

const asset = (name, sha256) => ({name, sha256});

describe('sealed release digest aliases', () => {
    it('allows only the verified Linux and Windows compatibility pairs', () => {
        assert.doesNotThrow(() => validateReleaseDigestPolicy([
            asset('MySpeed-linux-x64', 'a'.repeat(64)),
            asset('MySpeed-linux-x64-baseline', 'a'.repeat(64)),
            asset('MySpeed-windows-x64.exe', 'b'.repeat(64)),
            asset('MySpeed-windows-x64-baseline.exe', 'b'.repeat(64)),
            asset('MySpeed-linux-arm64', 'c'.repeat(64))
        ]));
    });

    it('accepts compatibility assets that compile to distinct bytes', () => {
        assert.doesNotThrow(() => validateReleaseDigestPolicy([
            asset('MySpeed-linux-x64', 'a'.repeat(64)),
            asset('MySpeed-linux-x64-baseline', 'b'.repeat(64))
        ]));
    });

    it('rejects unrelated and three-member collisions before publication', () => {
        for (const names of [
            ['MySpeed-linux-x64', 'MySpeed-linux-arm64'],
            ['MySpeed-linux-x64', 'MySpeed-linux-x64-baseline', 'MySpeed-linux-arm64'],
            ['MySpeed-installer.msi', 'MySpeed-installer-baseline.msi']
        ]) assert.throws(() => validateReleaseDigestPolicy(names.map((name) => asset(name, 'a'.repeat(64)))),
            /collision/i);
    });
});
