const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function inspect_glb(data) {
	if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF' ||
		data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length ||
		data.readUInt32LE(16) !== 0x4e4f534a)
		throw new Error('Exporter did not produce a complete GLB 2.0 file.');
	const jsonLength = data.readUInt32LE(12);
	if (20 + jsonLength > data.length)
		throw new Error('Truncated GLB JSON chunk.');
	const gltf = JSON.parse(data.toString('utf8', 20, 20 + jsonLength).trim());
	if (!gltf.meshes?.some(mesh => mesh.primitives?.length))
		throw new Error('Exported GLB has no geometry.');
	for (const resource of [...(gltf.buffers || []), ...(gltf.images || [])]) {
		if (resource.uri && !resource.uri.startsWith('data:'))
			throw new Error('GLB references an external resource: ' + resource.uri);
	}
	const warnings = [];
	if (gltf.meshes.some(mesh => mesh.primitives.some(primitive =>
		!gltf.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorTexture)))
		warnings.push('Some geometry has no base-color texture. Check the model and exporter log.');
	return { bytes: data.length, sha256: hash(data), warnings };
}

async function write_json(file, value) {
	const temporary = file + '.tmp';
	await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
	await fs.rename(temporary, file);
}

// exportModel is the existing application's exporter; no CASC or model parsing is duplicated here.
async function export_dump(entries, options) {
	const { outputDirectory, source, profile, exportModel, onProgress = () => {}, shouldCancel = () => false, limit = 0 } = options;
	if (!path.isAbsolute(outputDirectory))
		throw new Error('Choose an absolute export directory in Settings first.');
	if (!source?.buildKey || !source?.product)
		throw new Error('Select a WoW CASC build before exporting DecorDump.');
	if (!Number.isSafeInteger(limit) || limit < 0)
		throw new Error('Model limit must be a nonnegative integer.');

	const cacheKey = hash(JSON.stringify({ source, profile })).slice(0, 24);
	const directory = path.join(outputDirectory, 'decordump', cacheKey);
	const modelDirectory = path.join(directory, 'models');
	await fs.mkdir(modelDirectory, { recursive: true });
	const manifestPath = path.join(directory, 'catalog.json');
	let previous;
	try {
		previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
		if (previous.cacheKey !== cacheKey)
			throw new Error('Existing manifest does not match this build/export profile.');
	} catch (error) {
		if (error.code !== 'ENOENT')
			throw error;
	}

	const ids = [...new Set(entries.filter(entry => entry.have > 0 && entry.modelFDID !== null)
		.map(entry => entry.modelFDID))].sort((a, b) => a - b);
	const selected = new Set(limit ? ids.slice(0, limit) : ids);
	const oldAssets = new Map((previous?.assets || []).map(asset => [asset.modelFDID, asset]));
	const manifest = {
		schemaVersion: 1,
		cacheKey,
		source,
		profile,
		importedAt: new Date().toISOString(),
		inventoryMeaning: 'have = stored plus redeemable copies; placed and total-owned counts are unknown',
		appearance: 'Default exported appearance; in-game scale, dyes, effects and fidelity are unverified.',
		catalogSha256: hash(JSON.stringify(entries)),
		catalog: entries,
		unresolvedRecordIDs: entries.filter(entry => entry.have > 0 && entry.modelFDID === null).map(entry => entry.recordID),
		runState: 'running',
		assets: ids.map(id => {
			const old = oldAssets.get(id);
			return {
				modelFDID: id, status: old?.status || 'pending', file: 'models/' + id + '.glb',
				sha256: old?.sha256, bytes: old?.bytes, warnings: old?.warnings, modelType: old?.modelType
			};
		})
	};
	await write_json(manifestPath, manifest);
	let processed = 0;

	// ponytail: serial exports share upstream app state; parallelize only after that state is isolated.
	for (const asset of manifest.assets) {
		if (shouldCancel())
			break;
		const file = path.join(modelDirectory, asset.modelFDID + '.glb');
		const old = oldAssets.get(asset.modelFDID);
		if (old && (old.status === 'ready' || old.status === 'partial')) {
			try {
				const checked = inspect_glb(await fs.readFile(file));
				if (checked.sha256 === old.sha256) {
					Object.assign(asset, checked, { status: old.status, warnings: old.warnings || checked.warnings, reused: true });
					if (selected.has(asset.modelFDID)) {
						processed++;
						onProgress(asset, processed, selected.size);
					}
					continue;
				}
			} catch (error) {
				if (error.code && error.code !== 'ENOENT')
					throw error;
				// Missing, truncated, or changed files are exported again.
			}
		}
		asset.status = 'pending';
		delete asset.sha256;
		delete asset.bytes;
		if (!selected.has(asset.modelFDID))
			continue;

		const temporary = path.join(modelDirectory, asset.modelFDID + '.' + crypto.randomUUID() + '.tmp.glb');
		try {
			const details = await exportModel(asset.modelFDID, temporary);
			if (shouldCancel()) {
				asset.status = 'cancelled';
				break;
			}
			const checked = inspect_glb(await fs.readFile(temporary));
			const warnings = [...checked.warnings, ...(details?.warnings || [])];
			await fs.rename(temporary, file);
			Object.assign(asset, checked, { status: warnings.length ? 'partial' : 'ready', warnings, modelType: details?.modelType });
		} catch (error) {
			asset.status = shouldCancel() ? 'cancelled' : 'failed';
			asset.error = error.message;
		} finally {
			await fs.rm(temporary, { force: true });
		}
		processed++;
		await write_json(manifestPath, manifest);
		onProgress(asset, processed, selected.size);
	}
	manifest.runState = shouldCancel() ? 'cancelled' : 'finished';
	manifest.completedAt = new Date().toISOString();
	await write_json(manifestPath, manifest);
	return { directory, manifest };
}

module.exports = { export_dump, inspect_glb };
