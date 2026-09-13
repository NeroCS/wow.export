// Reuse the official NW.js/native runtime and bundle this checkout's source.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const output = path.join(root, 'bin', 'decordump');
const cache = path.join(root, 'bin', '_cache');
const archive = path.join(cache, 'portable-wow-export-win-x64-0.2.19.zip');
if (process.platform !== 'win32' || process.arch !== 'x64')
	throw new Error('This local launcher currently targets Windows x64.');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(output, { recursive: true });
if (!await fs.stat(archive).catch(() => null)) {
	console.log('Downloading the official 0.2.19 Windows runtime (335 MB)...');
	const response = await fetch('https://github.com/Kruithne/wow.export/releases/download/0.2.19/portable-wow-export-win-x64-0.2.19.zip');
	if (!response.ok)
		throw new Error('Runtime download failed: ' + response.status);
	await Bun.write(archive + '.download', response);
	await fs.rename(archive + '.download', archive);
}
if (!await fs.stat(path.join(output, 'wow.export.exe')).catch(() => null)) {
	const extraction = Bun.spawn(['tar', '-xf', archive, '-C', output], { stdout: 'inherit', stderr: 'inherit' });
	if (await extraction.exited !== 0)
		throw new Error('Runtime archive extraction failed.');
}
await fs.cp(path.join(root, 'src'), path.join(output, 'src'), { recursive: true, force: true });
const result = await Bun.build({
	entrypoints: [path.join(root, 'src', 'app.js')],
	outdir: path.join(output, 'src'),
	target: 'node',
	format: 'cjs',
	define: { 'process.env.BUILD_RELEASE': '"true"' }
});
if (!result.success)
	throw new AggregateError(result.logs, 'Application bundle failed.');
const manifestPath = path.join(output, 'package.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest['chromium-args'] = JSON.parse(await fs.readFile(path.join(root, 'build.json'), 'utf8')).manifest['chromium-args'];
manifest.name = 'wow.export.decordump';
manifest.flavour = 'decordump';
manifest.decorDump = true;
manifest.window.id = 'wow-export-decordump';
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Built ' + path.join(output, 'wow.export.exe'));
