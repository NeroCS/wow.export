const fs = require('node:fs');
const { parse_dump, summarize } = require('../src/js/decor-dump');
try {
	if (!process.argv[2])
		throw new Error('Usage: node scripts/inspect-decordump.js <SavedVariables/DecorDump.lua>');
	console.log(JSON.stringify(summarize(parse_dump(fs.readFileSync(process.argv[2], 'utf8'))), null, 2));
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
