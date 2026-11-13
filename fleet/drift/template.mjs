import { readFileSync } from 'fs';
import path from 'path';

import { isShard } from './shards.mjs';

// the templates, and their placeholders, which both checking a file and fixing it need: they're apart from `./check.mjs` since checking a file uses `./fix.mjs` (to diff it against what fixing it would write), which uses them

/** @typedef {{ template: string, required: boolean | null }} Expectation */

const templateDir = path.join(import.meta.dirname, 'templates');

/** @type {Record<string, Expectation>} */
export const standard = {
	'rebase.yml': { template: 'rebase.yml', required: true },
	'node-pretest.yml': { template: 'node-pretest.yml', required: true },
	'require-allow-edits.yml': { template: 'require-allow-edits.yml', required: true },
};

/** @type {(name: string) => string | null} */
export function templateFor(name) {
	if (Object.hasOwn(standard, name)) {
		return standard[name].template;
	}
	return isShard(name) ? 'node.yml' : null;
}

const placeholder = /\{\{(?<name>\w+)\}\}/g;
const hasPlaceholder = /\{\{\w+\}\}/;

/** @type {(text: string) => string[]} */
export function placeholders(text) {
	return Array.from(new Set(text.matchAll(placeholder).map((m) => m[1])));
}

/** @type {(text: string) => string} */
export function normalize(text) {
	return `${text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '')}\n`;
}

/** @type {(s: string) => string} */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// a placeholder matches anything on one line; a repeated placeholder must match the same text each time
/** @type {(text: string, flags?: string) => RegExp} */
export function compile(text, flags = '') {
	const seen = new Set();
	const source = text.split(placeholder).map((part, i) => {
		if (i % 2 === 0) {
			return escapeRegExp(part);
		}
		if (seen.has(part)) {
			return `\\k<${part}>`;
		}
		seen.add(part);
		return `(?<${part}>[^\\n]*?)`;
	}).join('');
	return new RegExp(`^${source}$`, flags);
}

/** @type {(text: string, values: Record<string, string>) => string} */
export function render(text, values) {
	return text.replace(placeholder, (match, name) => (Object.hasOwn(values, name) ? values[name] : match));
}

// for the diff of a file that doesn't match, recover what values we can, one template line at a time
/** @type {(text: string, actual: string) => Record<string, string>} */
export function guessValues(text, actual) {
	/** @type {Record<string, string>} */
	const values = {};
	text.split('\n').filter((l) => hasPlaceholder.test(l)).forEach((line) => {
		const match = actual.match(compile(line, 'm'));
		Object.entries(match?.groups ?? {}).forEach(([name, value]) => {
			values[name] ??= value;
		});
	});
	return values;
}

/** @type {Map<string, string>} */
const templates = new Map();

/** @type {(name: string) => string} */
export function loadTemplate(name) {
	let text = templates.get(name);
	if (typeof text !== 'string') {
		text = normalize(readFileSync(path.join(templateDir, name), 'utf8'));
		templates.set(name, text);
	}
	return text;
}
