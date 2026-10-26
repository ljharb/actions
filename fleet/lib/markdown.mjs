/** @type {(text: string) => number} */
function longestRun(text) {
	return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** @type {(s: string) => string} */
export function code(s) {
	// commit messages, logins, ref/tag names, and file names are third-party input: keep them inert (no mentions, links, markup, or table cells)
	const text = s.replace(/[\r\n]+/g, ' ').trim().replace(/\|/g, '\\|');
	const ticks = '`'.repeat(longestRun(text) + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** @type {(s: string) => string} */
export function html(s) {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Units in a group share text that each part they're split across needs to render on its own:
 * a part that starts partway through the group starts with `open` (eg, a table's header), and one that ends partway through it ends with `close` (eg, `</details>`).
 * @typedef {{ open: string, close: string }} Group
 */
/** @typedef {{ text: string, group?: Group }} Unit */

// room for the notes saying which part a part is, and that it continues
const decoration = 100;
// room for a piece's note
const pieceNote = 200;

/**
 * A unit too long for any part, as pieces that each fit in one: each is shown as its source, in a fenced block, so that nothing in it is lost, and third-party text in it stays inert however it's cut.
 * @type {(text: string, budget: number) => string[]}
 */
function pieces(text, budget) {
	// a fence is at most one backtick longer than its text, so a third of what's left always fits
	const size = Math.max(2, Math.floor((budget - pieceNote) / 3) - 1);
	/** @type {string[]} */
	const chunks = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(text.length, start + size);
		// never between the halves of a surrogate pair
		if (end < text.length && (/[\uD800-\uDBFF]/).test(text[end - 1])) {
			end -= 1;
		}
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks.map((chunk, i) => {
		const ticks = '`'.repeat(Math.max(2, longestRun(chunk)) + 1);
		return `_✂️ This item is too long to fit in one part, so it’s shown as its source, in ${chunks.length} pieces: this is piece ${i + 1} of ${chunks.length}._\n\n${ticks}\n${chunk}\n${ticks}`;
	});
}

/**
 * Markdown made of `units` (joined by newlines), as parts of at most `limit` characters each, in order, as few as it takes: nothing is ever left out.
 * Parts are split only between units, except that a unit too long for any part is split into pieces of its source (see `pieces`), each in a part of its own.
 * Every part but the first starts with `prefix` (eg, a marker to find it by) and says which part it is; every part but the last says that it continues below.
 * @type {(units: (string | Unit)[], limit: number, prefix?: string) => string[]}
 */
export function split(units, limit, prefix = '') {
	const budget = limit - prefix.length - decoration;
	/** @type {Unit[]} */
	const all = units.map((unit) => (typeof unit === 'string' ? { text: unit } : unit));
	/** @type {string[]} */
	const parts = [];
	/** @type {string[]} */
	let lines = [];
	let length = 0;
	/** @type {Unit | undefined} */
	let last;
	/** @type {(next?: Unit) => void} */
	const flush = (next) => {
		if (lines.length > 0) {
			if (last?.group && next?.group === last.group) {
				lines.push(last.group.close);
			}
			parts.push(lines.join('\n'));
		}
		lines = [];
		length = 0;
		last = void undefined;
	};

	all.forEach((unit, i) => {
		const { text, group } = unit;
		const continuing = group && all[i - 1]?.group === group;
		const close = group ? group.close.length + 1 : 0;
		// what a part of its own would hold: a group's `open` is only needed partway through it
		if ((continuing ? group.open.length + 1 : 0) + text.length + close > budget) {
			flush(unit);
			parts.push(...pieces(text, budget));
			return;
		}
		if (lines.length > 0 && length + 1 + text.length + close > budget) {
			flush(unit);
		}
		if (lines.length === 0 && continuing) {
			({ length } = group.open);
			lines.push(group.open);
		}
		length += (lines.length > 0 ? 1 : 0) + text.length;
		lines.push(text);
		last = unit;
	});
	flush();

	const trimmed = parts.map((part) => part.replace(/^\n+|\n+$/g, '')).filter(Boolean);
	return trimmed.length > 0 ? trimmed.map((part, i) => [
		...i > 0 ? [`${prefix}_continued (${i + 1}/${trimmed.length})_`, ''] : [],
		part,
		...i < trimmed.length - 1 ? ['', `_continued below (${i + 2}/${trimmed.length})_`] : [],
	].join('\n')) : [''];
}
