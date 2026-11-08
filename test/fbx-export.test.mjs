/*
 * FBX export: the units fix and the errors people are told.
 *
 * Real conversions were checked with the production image's assimp
 * (Debian bookworm assimp-utils 5.2.5) and Blender 4.x: before the fix
 * every export opened 100 times too small (UnitScaleFactor 1 = cm).
 */
import assert from 'node:assert/strict';

import { exportError, fbxInMetres } from '../src/export-fbx.mjs';


let passed = 0;

function check(label, fn) {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
}

// One binary-FBX property record as assimp writes it:
// "S" name, "S" "double", "S" "Number", "S" "", "D" value
function property(name, value) {
    const str = (s) => {
        const b = Buffer.alloc(5 + s.length);
        b.write('S', 0, 'latin1');
        b.writeUInt32LE(s.length, 1);
        b.write(s, 5, 'latin1');
        return b;
    };
    const d = Buffer.alloc(9);
    d.write('D', 0, 'latin1');
    d.writeDoubleLE(value, 1);
    return Buffer.concat([str(name), str('double'), str('Number'), str(''), d]);
}

function fakeFbx() {
    return Buffer.concat([
        Buffer.from('Kaydara FBX Binary  \x00\x1a\x00', 'latin1'), Buffer.alloc(16),
        property('UnitScaleFactor', 1), property('OriginalUnitScaleFactor', 1), property('UnitScaleFactorX', 1)
    ]);
}

const valueOf = (fbx, name) => {
    const at = fbx.indexOf(property(name, 1).subarray(0, 5 + name.length));
    return fbx.readDoubleLE(at + property(name, 1).length - 8);
};


console.log('\nUnits');
const before = fakeFbx();
const after = fbxInMetres(Buffer.from(before));
check('both unit properties say metres (100), in place', () => {
    assert.equal(valueOf(after, 'UnitScaleFactor'), 100);
    assert.equal(valueOf(after, 'OriginalUnitScaleFactor'), 100);
    assert.equal(after.length, before.length);
});
check('nothing else changes', () => {
    assert.equal(valueOf(after, 'UnitScaleFactorX'), 1);
    assert.equal(Buffer.compare(after.subarray(0, 39), before.subarray(0, 39)), 0);
});
check('a non-binary FBX is left alone', () => {
    const ascii = Buffer.from('; FBX 7.4.0 project file\nUnitScaleFactor: 1');
    assert.equal(fbxInMetres(ascii), ascii);
});

console.log('\nErrors say what happened');
check('converter missing', () => assert.match(exportError({ code: 'ENOENT' }).text, /not installed.*assimp/));
check('too slow for the server (stopped at the limit)', () => {
    const e = exportError({ timedOut: true });
    assert.equal(e.status, 503);
    assert.match(e.text, /took longer than 90 s.*Export fewer objects/);
});
check('killed from outside (out of memory)', () => assert.match(exportError({ signal: 'SIGKILL' }).text, /ran out of resources/));
check('assimp\'s own reason, without temp paths', () => {
    const e = exportError({ stderr: 'Launching asset import ...\nInfo,  T0: Load model.gltf\nERROR: Failed to load file /tmp/beestoon-editor-fbx-1234/model.gltf: unsupported accessor\n' });
    assert.equal(e.status, 422);
    assert.match(e.text, /^FBX conversion failed: ERROR: Failed to load file.*unsupported accessor/);
    assert.ok(!e.text.includes('/tmp/beestoon-editor-fbx-'));
});
check('never a 52x status (the hosting proxy would replace it)', () => {
    for (const error of [{ code: 'ENOENT' }, { timedOut: true }, { signal: 'SIGKILL' }, { stderr: 'x' }, {}]) {
        const { status } = exportError(error);
        assert.ok(status < 520 || status > 527);
    }
});

console.log(`\nAll ${passed} FBX checks passed`);
