const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parse_dump, summarize } = require('../src/js/decor-dump');
const { export_dump, inspect_glb } = require('../src/js/decor-dump-export');
const { applyMaterialBlend, M2_BLEND, M2_MATERIAL_FLAG } = require('../src/js/3D/writers/gltf-material-blend');

const header = 'recordID\tname\tcategory\tsubcategory\tsize\thave\tindoor\toutdoor\tcost\tmodelFDID\titemID';
const row = (id, model, have = 1, name = 'Chair') => [id, name, 'Furniture', 'Chairs', 'Small', have, 1, 0, 2, model ?? '', 123].join('\t');
const dump = rows => 'DecorDumpDB = {\n' + [header, ...rows].map(value => JSON.stringify(value) + ',').join('\n') + '\n}';

function triangle() {
	const binary = Buffer.alloc(36);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => binary.writeFloatLE(value, i * 4));
	const gltf = {
		asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }]
	};
	const json = Buffer.from(JSON.stringify(gltf));
	const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
	json.copy(padded);
	const result = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
	result.write('glTF');
	result.writeUInt32LE(2, 4);
	result.writeUInt32LE(result.length, 8);
	result.writeUInt32LE(padded.length, 12);
	result.writeUInt32LE(0x4e4f534a, 16);
	padded.copy(result, 20);
	result.writeUInt32LE(binary.length, 20 + padded.length);
	result.writeUInt32LE(0x004e4942, 24 + padded.length);
	binary.copy(result, 28 + padded.length);
	return result;
}

test('reads actual addon columns, escapes, Unicode, comments and indexed rows without executing Lua', () => {
	const text = dump([row(1, 10, 2, 'Elune "moon" \\ shelf — 雪 🦉'), row(2, 10), row(3, null), row(4, 11, 0)]);
	const entries = parse_dump('\uFEFF-- saved by WoW\n' + text + '\n-- end');
	assert.equal(entries[0].name, 'Elune "moon" \\ shelf — 雪 🦉');
	assert.deepEqual(summarize(entries), { catalogEntries: 4, availableEntries: 3, models: 1, missingModels: 1 });
	assert.equal(entries[2].modelFDID, null);
	assert.equal(entries[0].indoor, true);
	assert.equal(entries[0].outdoor, false);
	assert.equal(parse_dump(dump([row(1, 10), row(1, 10)])).length, 1);
	const indexed = text.replace('"' + header.split('\t')[0], '[1] = "' + header.split('\t')[0]);
	assert.equal(parse_dump(indexed).length, 4);
	const bytes = dump([row(1, 10, 1, 'Cafe')]).replace('Cafe', String.raw`Caf\195\169`);
	assert.equal(parse_dump(bytes)[0].name, 'Café');
	for (const invalid of [
		text + '\nos.execute("bad")',
		'DecorDumpDB = { (function() return "bad" end)() }',
		text.replace('DecorDumpDB', 'SomethingElse'),
		text.slice(0, -1),
		dump([row(1, 10), row(1, 11)]),
		dump([row(1, '../escape')]),
		dump([row(1, 10, -1)]),
		dump([row(1, 10)]).replace('"recordID', '"unknown'),
		'DecorDumpDB = {}'
	])
		assert.throws(() => parse_dump(invalid));
});

test('validates GLB output instead of trusting a resolved export promise', () => {
	assert.equal(inspect_glb(triangle()).warnings.length, 1);
	assert.throws(() => inspect_glb(Buffer.from('not a model')));
	assert.throws(() => inspect_glb(triangle().subarray(0, 100)));
	const external = triangle();
	const jsonLength = external.readUInt32LE(12);
	const gltf = JSON.parse(external.toString('utf8', 20, 20 + jsonLength));
	gltf.buffers[0].uri = '../../outside.bin';
	const json = Buffer.from(JSON.stringify(gltf));
	const buffer = Buffer.alloc(20 + json.length);
	buffer.write('glTF');
	buffer.writeUInt32LE(2, 4);
	buffer.writeUInt32LE(buffer.length, 8);
	buffer.writeUInt32LE(json.length, 12);
	buffer.writeUInt32LE(0x4e4f534a, 16);
	json.copy(buffer, 20);
	assert.throws(() => inspect_glb(buffer), /external resource/);
});

test('deduplicates, checkpoints, resumes, retries failures, separates builds and cancels safely', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-decordump-test-'));
	try {
		const entries = parse_dump(dump([row(1, 10), row(2, 10), row(3, 20), row(4, 30), row(5, null), row(6, 40, 0)]));
		const calls = [];
		let fail = true;
		const options = {
			outputDirectory: root, source: { product: 'wow', buildKey: 'build-a' }, profile: { version: 1 },
			exportModel: async (id, out) => {
				calls.push(id);
				if (id === 20 && fail)
					throw new Error('Missing texture fixture');
				await fs.writeFile(out, triangle());
				return { modelType: 'm2', warnings: [] };
			}
		};
		const first = await export_dump(entries, { ...options, limit: 2 });
		assert.deepEqual(calls, [10, 20]);
		assert.deepEqual(first.manifest.assets.map(a => a.status), ['partial', 'failed', 'pending']);
		assert.deepEqual(first.manifest.unresolvedRecordIDs, [5]);
		assert.equal(first.manifest.catalog.length, 6);
		fail = false;
		calls.length = 0;
		const second = await export_dump(entries, options);
		assert.deepEqual(calls, [20, 30]);
		assert.equal(second.manifest.assets[0].reused, true);
		assert.equal(second.manifest.assets.every(a => a.status === 'partial'), true);
		calls.length = 0;
		await fs.writeFile(path.join(second.directory, 'models', '10.glb'), 'truncated');
		await export_dump(entries, options);
		assert.deepEqual(calls, [10]);
		const other = await export_dump(entries, { ...options, source: { product: 'wow', buildKey: 'build-b' }, limit: 1 });
		assert.notEqual(other.directory, second.directory);
		let cancelled = false;
		const cancelledResult = await export_dump(entries, {
			...options, profile: { version: 2 },
			shouldCancel: () => cancelled,
			exportModel: async (id, out) => { await fs.writeFile(out, triangle()); cancelled = true; }
		});
		assert.equal(cancelledResult.manifest.runState, 'cancelled');
		assert.equal(cancelledResult.manifest.assets[0].status, 'cancelled');
		assert.deepEqual(await fs.readdir(path.join(cancelledResult.directory, 'models')), []);
		await assert.rejects(export_dump(entries, { ...options, limit: -1 }));
		await assert.rejects(export_dump(entries, { ...options, outputDirectory: 'relative' }));
	} finally {
		// Only the unique directory created by this test is removed.
		assert.ok(root.startsWith(path.join(os.tmpdir(), 'wow-decordump-test-')));
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('glTF materials carry the M2 blend mode instead of exporting as flat opaque', () => {
	const blend = (blendingMode, flags = 0) => applyMaterialBlend({ name: 'm' }, { blendingMode, flags });

	// Opaque stays untouched, so ordinary furniture exports exactly as before.
	assert.deepEqual(blend(M2_BLEND.OPAQUE), { name: 'm' });

	// Alpha key is the cut-out mode: leaves, chains and grates were exporting as filled quads.
	const key = blend(M2_BLEND.ALPHA_KEY);
	assert.equal(key.alphaMode, 'MASK');
	assert.equal(key.alphaCutoff, 0.5);

	assert.equal(blend(M2_BLEND.ALPHA).alphaMode, 'BLEND');

	// Additive is the black-square case: glTF has no additive mode, so it rides in extras.
	for (const mode of [M2_BLEND.NO_ALPHA_ADD, M2_BLEND.ADD, M2_BLEND.BLEND_ADD]) {
		const add = blend(mode);
		assert.equal(add.alphaMode, 'BLEND');
		assert.equal(add.extras.blendMode, 'add');
		assert.equal(add.extras.m2BlendingMode, mode);
	}
	assert.equal(blend(M2_BLEND.MOD).extras.blendMode, 'mod');
	assert.equal(blend(M2_BLEND.MOD2X).extras.blendMode, 'mod2x');

	// Flags are independent of the blend mode.
	assert.equal(blend(M2_BLEND.OPAQUE, M2_MATERIAL_FLAG.TWO_SIDED).doubleSided, true);
	assert.ok(blend(M2_BLEND.ADD, M2_MATERIAL_FLAG.UNLIT).extensions.KHR_materials_unlit);
	assert.equal(blend(M2_BLEND.OPAQUE, M2_MATERIAL_FLAG.UNFOGGED).doubleSided, undefined);
	assert.equal(applyMaterialBlend({ name: 'm' }, undefined).alphaMode, undefined);
});
