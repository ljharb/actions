import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import semver from 'semver';

import { exec } from '../lib/exec.mjs';
import { expectedShards, isShard } from './shards.mjs';

/** @typedef {import('../lib/app.mjs').RepoState} RepoState */
/** @typedef {{ name: string, diff: string }} Drift */
/** @typedef {{ repository: string, missing: string[], unexpected: string[], drifted: Drift[], unreadable: string[], error: string | null }} Result */
/** @typedef {{ template: string, required: boolean | null }} Expectation */

const templateDir = path.join(import.meta.dirname, 'templates');

/** @type {Record<string, Expectation>} */
const standard = {
	'rebase.yml': { template: 'rebase.yml', required: true },
	'node-pretest.yml': { template: 'node-pretest.yml', required: true },
	'require-allow-edits.yml': { template: 'require-allow-edits.yml', required: true },
};

const placeholder = /\{\{(?<name>\w+)\}\}/g;
const hasPlaceholder = /\{\{\w+\}\}/;

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
function compile(text, flags = '') {
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
function render(text, values) {
	return text.replace(placeholder, (match, name) => (Object.hasOwn(values, name) ? values[name] : match));
}

// for the diff of a file that doesn't match, recover what values we can, one template line at a time
/** @type {(text: string, actual: string) => Record<string, string>} */
function guessValues(text, actual) {
	/** @type {Record<string, string>} */
	const values = {};
	for (const line of text.split('\n').filter((l) => hasPlaceholder.test(l))) {
		const match = actual.match(compile(line, 'm'));
		Object.entries(match?.groups ?? {}).forEach(([name, value]) => {
			values[name] ??= value;
		});
	}
	return values;
}

/** @type {(name: string, actual: string, expected: string) => string} */
function unifiedDiff(name, actual, expected) {
	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'drift-'));
	const a = path.join(dir, 'actual');
	const b = path.join(dir, 'expected');
	writeFileSync(a, actual);
	writeFileSync(b, expected);
	return exec('diff', [
		'-u', '--label', `${name} (actual)`, '--label', `${name} (expected)`, a, b,
	], { allowFailure: true }).stdout;
}

/** @type {Map<string, string>} */
const templates = new Map();

/** @type {(name: string) => string} */
function loadTemplate(name) {
	let text = templates.get(name);
	if (typeof text !== 'string') {
		text = normalize(readFileSync(path.join(templateDir, name), 'utf8'));
		templates.set(name, text);
	}
	return text;
}

/** @type {(packageJson: string | null) => { range: string | null, error: string | null }} */
function nodeEngines(packageJson) {
	if (typeof packageJson !== 'string') {
		return { range: null, error: null };
	}
	let range;
	try {
		range = JSON.parse(packageJson)?.engines?.node;
	} catch (e) {
		return { range: null, error: `\`package.json\` is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (typeof range !== 'string') {
		return { range: null, error: null };
	}
	return semver.validRange(range)
		? { range, error: null }
		: { range: null, error: `\`engines.node\` in \`package.json\` is not a valid semver range: ${range}` };
}

// the matrix type decides how many jobs, so how many files, a range needs
/** @type {(files: Map<string, string | null>) => import('./shards.mjs').Type} */
function nodeType(files) {
	const types = [...files]
		.filter(([name, text]) => isShard(name) && typeof text === 'string')
		.map(([, text]) => text?.match(/^\s+type:\s*['"]?(?<type>majors|minors)\b/m)?.groups?.type);
	return types.length > 0 && types.every((t) => t === 'majors') ? 'majors' : 'minors';
}

// without `engines.node`, which node test files a repo needs is unknown, so they're only compared when present
/** @type {(files: Map<string, string | null>, range: string | null) => Promise<Record<string, Expectation>>} */
async function expectations(files, range) {
	const expected = range ? await expectedShards(range, nodeType(files)) : [];
	const shards = [...new Set([...[...files.keys()].filter(isShard), ...expected])];
	return {
		...standard,
		...Object.fromEntries(shards.map((name) => [name, { template: 'node.yml', required: range ? expected.includes(name) : null }])),
	};
}

/** @type {(state: RepoState) => Promise<Result | null>} */
export async function checkRepo(state) {
	// unknown state, so unknown config: report it rather than calling every file missing
	if (state.stateError) {
		return {
			repository: state.repository, missing: [], unexpected: [], drifted: [], unreadable: [], error: state.stateError,
		};
	}
	if (state.archived || state.config.workflows === false) {
		return null;
	}
	const engines = nodeEngines(state.packageJson);
	/** @type {Result} */
	const result = {
		repository: state.repository,
		missing: [],
		unexpected: [],
		drifted: [],
		unreadable: [],
		error: [state.configError, engines.error].filter(Boolean).join('; ') || null,
	};
	const files = new Map((state.workflows ?? []).map((f) => [f.name, f.text]));
	const expected = await expectations(files, engines.range);
	const overrides = state.config.workflows;
	const names = [...new Set([...Object.keys(expected), ...Object.keys(overrides)])].sort();

	for (const name of names) {
		const entry = Object.hasOwn(expected, name) ? expected[name] : null;
		const required = Object.hasOwn(overrides, name) ? overrides[name] : entry?.required ?? null;
		const checked = !Object.hasOwn(overrides, name) || overrides[name];
		if (!files.has(name)) {
			if (required) {
				result.missing.push(name);
			}
		} else if (required === false && checked) {
			result.unexpected.push(name);
		} else if (checked && entry) {
			const text = files.get(name);
			if (typeof text === 'string') {
				const actual = normalize(text);
				const template = loadTemplate(entry.template);
				if (!compile(template).test(actual)) {
					result.drifted.push({ name, diff: unifiedDiff(name, actual, render(template, guessValues(template, actual))) });
				}
			} else {
				result.unreadable.push(name);
			}
		}
	}

	return result.missing.length > 0
		|| result.unexpected.length > 0
		|| result.drifted.length > 0
		|| result.unreadable.length > 0
		|| result.error
		? result
		: null;
}

/**
 * `checkRepo`, but a failure is only that repository's error, rather than the whole run's: an error can quote what it was checking (eg, `package.json`'s contents), and a private repository's is never shown, so its message is withheld.
 * @type {(state: RepoState) => Promise<Result | null>}
 */
export async function checkSafely(state) {
	try {
		return await checkRepo(state);
	} catch (error) {
		return {
			repository: state.repository,
			missing: [],
			unexpected: [],
			drifted: [],
			unreadable: [],
			error: state.private ? 'could not be checked' : `could not be checked: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
