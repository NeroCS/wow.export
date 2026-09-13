// Data-only reader for the SavedVariables format emitted by the DecorDump addon.
const MAX_BYTES = 8 * 1024 * 1024;
const COLUMNS = ['recordID', 'name', 'category', 'subcategory', 'size', 'have', 'indoor', 'outdoor', 'cost', 'modelFDID', 'itemID'];

function parse_dump(text) {
	if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES)
		throw new Error('DecorDump must be a UTF-8 text file smaller than 8 MiB.');

	let offset = 0;
	const whitespace = /(?:\s+|--[^\r\n]*)*/y;
	const skip = () => {
		whitespace.lastIndex = offset;
		whitespace.exec(text);
		offset = whitespace.lastIndex;
	};
	const take = value => {
		skip();
		if (!text.startsWith(value, offset))
			throw new Error('Expected ' + value + ' at character ' + offset + '. Use the saved DecorDump.lua file.');
		offset += value.length;
	};
	const string = () => {
		skip();
		const quote = text[offset++];
		if (quote !== '"' && quote !== "'")
			throw new Error('Only literal strings are allowed in DecorDumpDB.');
		const chunks = [];
		let start = offset;
		while (offset < text.length) {
			const char = text[offset++];
			if (char === quote) {
				chunks.push(Buffer.from(text.slice(start, offset - 1)));
				return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
			}
			if (char === '\n' || char === '\r')
				throw new Error('Unescaped newline in a Lua string.');
			if (char !== '\\')
				continue;
			chunks.push(Buffer.from(text.slice(start, offset - 1)));
			const escape = text[offset++];
			const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39 };
			if (Object.hasOwn(simple, escape)) {
				chunks.push(Buffer.from([simple[escape]]));
			} else if (escape && /[0-9]/.test(escape)) {
				const digits = text.slice(offset - 1).match(/^\d{1,3}/)[0];
				if (Number(digits) > 255)
					throw new Error('Lua byte escape is outside 0..255.');
				offset += digits.length - 1;
				chunks.push(Buffer.from([Number(digits)]));
			} else if (escape === 'x' && /^[0-9a-f]{2}/i.test(text.slice(offset, offset + 2))) {
				chunks.push(Buffer.from([parseInt(text.slice(offset, offset + 2), 16)]));
				offset += 2;
			} else {
				throw new Error('Unsupported Lua escape at character ' + (offset - 1) + '.');
			}
			start = offset;
		}
		throw new Error('Truncated Lua string.');
	};

	take('DecorDumpDB');
	take('=');
	take('{');
	const rows = [];
	skip();
	while (text[offset] !== '}') {
		if (rows.length > 50000)
			throw new Error('Too many DecorDump rows.');
		if (text[offset] === '[') {
			take('[');
			skip();
			const index = text.slice(offset).match(/^\d+/)?.[0];
			if (!index || Number(index) !== rows.length + 1)
				throw new Error('DecorDump row indices must be consecutive.');
			offset += index.length;
			take(']');
			take('=');
		}
		rows.push(string());
		skip();
		if (text[offset] === '}')
			break;
		take(',');
		skip();
	}
	take('}');
	skip();
	if (text[offset] === ';') {
		offset++;
		skip();
	}
	if (offset !== text.length)
		throw new Error('Unexpected content after DecorDumpDB; Lua code is never executed.');
	if (rows.shift() !== COLUMNS.join('\t'))
		throw new Error('Unsupported DecorDump header. Expected the current eleven-column addon dump.');

	const seen = new Map();
	const entries = rows.map((row, index) => {
		const values = row.split('\t');
		if (values.length !== COLUMNS.length)
			throw new Error('Row ' + (index + 2) + ' must contain eleven columns.');
		const entry = Object.fromEntries(COLUMNS.map((name, i) => [name, values[i]]));
		for (const field of ['recordID', 'have', 'indoor', 'outdoor', 'cost', 'modelFDID', 'itemID']) {
			if ((field === 'modelFDID' || field === 'itemID') && entry[field] === '') {
				entry[field] = null;
				continue;
			}
			if (!/^\d+$/.test(entry[field]) || !Number.isSafeInteger(Number(entry[field])))
				throw new Error('Invalid ' + field + ' in row ' + (index + 2) + '.');
			entry[field] = Number(entry[field]);
		}
		if (entry.recordID < 1 || (entry.modelFDID !== null && entry.modelFDID < 1) ||
			(entry.itemID !== null && entry.itemID < 1) || entry.indoor > 1 || entry.outdoor > 1)
			throw new Error('Invalid ID or indoor/outdoor flag in row ' + (index + 2) + '.');
		entry.indoor = Boolean(entry.indoor);
		entry.outdoor = Boolean(entry.outdoor);
		const serialized = JSON.stringify(entry);
		if (seen.has(entry.recordID)) {
			if (seen.get(entry.recordID) !== serialized)
				throw new Error('Conflicting duplicate recordID ' + entry.recordID + '; quantities are not summed.');
			return null; // Catalog search can repeat identical aggregate rows for variants.
		}
		seen.set(entry.recordID, serialized);
		return entry;
	}).filter(entry => entry !== null);
	if (entries.length === 0)
		throw new Error('The dump contains no catalog entries.');
	return entries;
}

function summarize(entries) {
	const available = entries.filter(entry => entry.have > 0);
	return {
		catalogEntries: entries.length,
		availableEntries: available.length,
		models: new Set(available.map(entry => entry.modelFDID).filter(id => id !== null)).size,
		missingModels: available.filter(entry => entry.modelFDID === null).length
	};
}

module.exports = { parse_dump, summarize, MAX_BYTES };
