import {
	LineCounter,
	YAMLMap,
	isAlias,
	isMap,
	isScalar,
	parseDocument,
} from 'yaml';

/**
 * The calls a workflow file makes (in its jobs) of this repo's reusable workflows, as YAML's parser finds them.
 * Workflow files are parsed as YAML, and what's read from them is only ever what the parser says is there: a file the parser finds any error or warning in (eg, a key passed twice, a tab in indentation, a tag it can't resolve, an alias of an anchor that isn't there), or that has a character YAML 1.1 (but not 1.2) breaks lines at, isn't understood at all, and has no calls.
 * A job's `with:` is understood when it's empty, or a block mapping (with no anchor or tag) whose every key is a string, with no anchor or tag, alone on its line before its `:` (not an explicit `? ` key): anything else (eg, a flow-style `with: { … }`, or an alias) is left as it is.
 * A comment on a line of its own in a `with:` belongs to the input after it (or, after the last one, and indented more than the `with:`, to that one): so an input's lines include the comments that explain it, wherever they are. Whatever the parser says is part of an input's value (eg, a `#` line within a block scalar, or a quoted scalar) is part of it.
 * Line endings are only ever `\n`: a `\r\n` (or a lone `\r`) is read as one, and what's written from a file keeps its line endings when every one of them was `\r\n` (and has `\n`s, otherwise).
 */

/** @typedef {{ start: number, end: number, scalar: boolean }} Span */
/** @typedef {{ line: number, understood: boolean, indent: number, end: number, inputs: Map<string, Span>, comments: number[] }} With */
/** @typedef {{ job: string, file: string, indent: number, after: number, with: With | null }} Call */
/** @typedef {{ doc: import('yaml').Document.Parsed, lines: string[], calls: Call[] }} Parsed */

const usesValue = /^ljharb\/actions\/\.github\/workflows\/(?<file>[\w.-]+\.ya?ml)@[^\s'"#]+$/;

// a line break to YAML 1.1 (but not 1.2), which a parser might split a line at
const oldBreak = /[\x85\u2028\u2029]/;

// YAML's indentation is spaces, and nothing else
/** @type {(line: string) => number} */
export function indentOf(line) {
	return line.length - line.replace(/^ +/, '').length;
}

/** @type {(text: string) => string} */
export function toLF(text) {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * `text` (with only `\n`s), with the line endings of `like`: `\r\n`, when every one of its line endings is, and `\n`, otherwise.
 * @type {(text: string, like: string) => string}
 */
export function endingsOf(text, like) {
	return (/\r\n/).test(like) && !(/\r(?!\n)|(?<!\r)\n/).test(like) ? text.replace(/\n/g, '\r\n') : text;
}

/** @type {(line: string) => boolean} */
export function isBlank(line) {
	return (/^[ \t]*(?:#.*)?$/).test(line);
}

/** @type {(line: string) => boolean} */
export function isComment(line) {
	return (/^[ \t]*#/).test(line);
}

/** @type {(node: unknown) => node is import('yaml').Scalar<string>} */
export function isString(node) {
	return isScalar(node) && typeof node.value === 'string';
}

/** @typedef {(offset: number) => { line: number, col: number }} LineOf */

/**
 * Whether `value`, an input's, is a scalar (or empty, or an alias of one): only such an input can be a repository's own choice that isn't drift; a mapping or a sequence might be anything.
 * @type {(value: unknown, doc: import('yaml').Document.Parsed) => boolean}
 */
function isScalarValue(value, doc) {
	return value === null || isScalar(value) || (isAlias(value) && isScalar(value.resolve(doc)));
}

/**
 * The inputs of `map`, a `with:`'s block mapping (whose key is on line `line` of `lines`), as the parser found them: each one's lines, from the comments on lines of their own before it (if any) to the end of its value (and its trailing comment); every comment on a line of its own before the last one; the last one's last line; and how indented they are. `null` if any of its keys isn't a string, with no anchor or tag, alone on its line before its `:`; or if a line between them (or before the first) isn't blank or a comment (eg, an anchor on a line of its own).
 * @type {(map: import('yaml').YAMLMap, lines: string[], at: { line: number, lineOf: LineOf, doc: import('yaml').Document.Parsed }) => { inputs: Map<string, Span>, comments: number[], last: number, indent: number | null } | null}
 */
function entries(map, lines, {
	line, lineOf, doc,
}) {
	/** @type {{ inputs: Map<string, Span>, comments: number[], last: number, indent: number | null }} */
	const found = {
		inputs: new Map(), comments: [], last: line, indent: null,
	};
	for (const { key, value } of map.items) {
		const at = isString(key) && !key.anchor && !key.tag ? lineOf(Number(key.range?.[0])) : null;
		const from = found.last + 1;
		const between = lines.slice(from, at?.line);
		if (!at || !isString(key) || !(/^ *$/).test(lines[at.line].slice(0, at.col)) || !between.every(isBlank)) {
			return null;
		}
		const comments = between.map((_, i) => from + i).filter((j) => isComment(lines[j]));
		found.last = lineOf(Math.max(Number(key.range?.[1]), Number(/** @type {import('yaml').Node} */ (value).range?.[1])) - 1).line; // eslint-disable-line no-extra-parens
		found.inputs.set(key.value, {
			start: comments[0] ?? at.line, end: found.last + 1, scalar: isScalarValue(value, doc),
		});
		found.comments.push(...comments);
		found.indent = at.col;
	}
	return found;
}

/**
 * `pair`, a job's `with:` (whose job's keys are indented `indent`), as the parser found it in `lines`; `lineOf` is the line (and column) an offset in them is on.
 * It's understood when its key is alone on its line, and it's empty, or a block mapping (with no anchor or tag) whose inputs are (see `entries`).
 * After its last input, the comments on lines of their own indented more than the `with:` are its last input's; any after one that isn't are about what follows it.
 * @type {(pair: { key: import('yaml').Scalar, value: unknown }, lines: string[], at: { indent: number, lineOf: LineOf, doc: import('yaml').Document.Parsed }) => With}
 */
function withBlock({ key, value }, lines, {
	indent, lineOf, doc,
}) {
	const { line, col } = lineOf(Number(key.range?.[0]));
	const keyEnd = lineOf(Number(key.range?.[1]));
	/** @type {With} */
	const block = {
		line, understood: false, indent: indent + 2, end: line + 1, inputs: new Map(), comments: [],
	};
	const empty = isScalar(value) && value.value === null && value.source === '';
	const alone = keyEnd.line === line && (/^ *$/).test(lines[line].slice(0, col)) && (/^[ \t]*:[ \t]*(?:#.*)?$/).test(lines[line].slice(keyEnd.col));
	const found = alone && (empty || (isMap(value) && !value.flow && !value.anchor && !value.tag)) ? entries(isMap(value) ? value : new YAMLMap(), lines, {
		line, lineOf, doc,
	}) : null;
	if (!found) {
		return block;
	}
	Object.assign(block, {
		understood: true, indent: found.indent ?? block.indent, end: found.last + 1, inputs: found.inputs, comments: found.comments,
	});
	for (let j = found.last + 1; j < lines.length && isBlank(lines[j]) && !(isComment(lines[j]) && indentOf(lines[j]) <= col); j += 1) {
		if (isComment(lines[j])) {
			block.comments.push(j);
			block.end = j + 1;
		}
	}
	const lastInput = [...block.inputs.values()].at(-1);
	if (lastInput) {
		lastInput.end = block.end;
	}
	return block;
}

/**
 * Every job in `text` (with its line endings as `\n`s) that calls a reusable workflow of this repo's, with its `with:`, if it has one, and its lines, and the document: `null` when it isn't YAML that's understood (see above).
 * @type {(text: string) => Parsed | null}
 */
export function read(original) {
	const text = toLF(original);
	const lineCounter = new LineCounter();
	const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
	if (doc.errors.length > 0 || doc.warnings.length > 0 || oldBreak.test(text)) {
		return null;
	}
	try {
		// an alias of an anchor that isn't there (or too many of them) is only found when what the file says is read; a key that's a collection (eg, a template's `{{placeholder}}`) is kept as it is
		doc.toJS({ mapAsMap: true });
	} catch {
		return null;
	}
	const lines = text.split('\n');
	/** @type {LineOf} */
	const lineOf = (offset) => {
		const { line, col } = lineCounter.linePos(offset);
		return { line: line - 1, col: col - 1 };
	};
	const jobs = doc.get('jobs', true);
	/** @type {Call[]} */
	const calls = [];
	for (const { key, value: job } of isMap(jobs) ? jobs.items : []) {
		const uses = isMap(job) ? job.items.find((pair) => isString(pair.key) && pair.key.value === 'uses') : null;
		const file = isString(uses?.value) ? uses.value.value.match(usesValue)?.groups?.file : null;
		if (isScalar(key) && uses && isString(uses.value) && file) {
			const indent = lineOf(Number(/** @type {import('yaml').Scalar} */ (uses.key).range?.[0])).col; // eslint-disable-line no-extra-parens
			const pair = /** @type {{ key: import('yaml').Scalar, value: unknown } | undefined} */ (/** @type {import('yaml').YAMLMap} */ (job).items.find((p) => isString(p.key) && p.key.value === 'with')); // eslint-disable-line no-extra-parens
			calls.push({
				job: String(key.value),
				file,
				indent,
				after: lineOf(Number(uses.value.range?.[1]) - 1).line + 1,
				with: pair ? withBlock(pair, lines, {
					indent, lineOf, doc,
				}) : null,
			});
		}
	}
	return {
		doc, lines, calls,
	};
}
