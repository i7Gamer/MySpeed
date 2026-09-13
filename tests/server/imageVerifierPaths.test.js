import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readSource} from '../helpers/source.js';

it('converts only host mount sources when Git Bash invokes native Docker', () => {
    const script = readSource('scripts/verify-image.sh');
    assert.match(script, /MINGW\*\|MSYS\*/);
    assert.match(script, /QUALIFICATION_DIR="\$\(cygpath -m "\$QUALIFICATION_DIR"\)"/);
    assert.match(script, /EVIDENCE_MOUNT_DIR="\$\(cygpath -m "\$EVIDENCE_ROOT"\)"/);
    assert.match(script, /COLLECTOR="\$\(cygpath -m "\$COLLECTOR"\)"/);
    assert.match(script, /export MSYS2_ARG_CONV_EXCL='\*'/);
    assert.match(script, /source=\$\{EVIDENCE_MOUNT_DIR\},target=\/evidence/);
});

it('proves both newly owned volumes empty before Docker copies image content', () => {
    const script = readSource('scripts/verify-image.sh');
    const preflight = script.indexOf('Prove fresh volumes are empty');
    const candidate = script.indexOf('Starting isolated verification container');
    assert.ok(preflight >= 0 && preflight < candidate);
    const proof = script.slice(preflight, candidate);
    assert.match(proof, /--network none/);
    assert.match(proof, /source=\$\{DATA_VOLUME\},target=\/myspeed\/data,volume-nocopy/);
    assert.match(proof, /source=\$\{BIN_VOLUME\},target=\/myspeed\/bin,volume-nocopy/);
    assert.match(proof, /readdirSync\(directory\)\.length/);
    assert.match(proof, /container_is_owned/);
    assert.match(proof, /volume-preflight\.log/);
});

it('uses the same chosen port for the application and image healthcheck', () => {
    const script = readSource('scripts/verify-image.sh');
    assert.match(script, /--env SERVER_PORT="\$PORT"/);
    assert.match(script, /--port "\$PORT"/);
    assert.match(script, /container-inspect\.json/);
});

it('retains uniquely owned evidence and forwards the already-validated source SHA', () => {
    const script = readSource('scripts/verify-image.sh');
    assert.match(script, /QUALIFICATION_EVIDENCE_DIRECTORY/);
    assert.match(script, /Refusing nonempty qualification evidence/);
    assert.match(script, /--source-sha "\$QUALIFICATION_SOURCE_SHA"/);
    assert.match(script, /collect-summary\.mjs/);
    assert.match(script, /qualification-summary\.json/);
});

it('acknowledges Docker health while the verified app is still held alive', () => {
    const script = readSource('scripts/verify-image.sh');
    assert.match(script, /--healthcheck-handshake \/evidence/);
    assert.match(script, /healthcheck-request\.json/);
    assert.match(script, /healthcheck-ack\.json/);
    assert.match(script, /mv -n/);
    assert.match(script, /--arg \/myspeed\/server\/index\.js/);
});
