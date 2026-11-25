import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { exec } from '../lib/exec.mjs';
import { planFixes, workflowPath } from './fix.mjs';
import {
	keepInputs,
	stripKnownInputs,
	uncapped,
} from './inputs.mjs';
import {
	expectedShards,
	isShard,
	nodeEngines,
	nodeType,
} from './shards.mjs';
import {
	compile,
	guessValues,
	loadTemplate,
	normalize,
	render,
	standard,
} from './template.mjs';

/** @import { RepoState } from '../lib/app.mjs' */
/** @import { Expectation } from './template.mjs' */
/** @typedef {{ name: string, diff: string }} Drift */
/** @typedef {{ repository: string, missing: string[], unexpected: string[], drifted: Drift[], unreadable: string[], error: string | null }} Result */

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

	/** @type {{ name: string, template: string, actual: string, comparable: string }[]} */
	const drifting = [];
	names.forEach((name) => {
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
				// a call that passes an input that needs to write the cache can't be capped at `read`, as the template caps it
				const matched = uncapped(template, actual);
				// the inputs a repository passes that the reusable workflow declares, but the template doesn't pass, are its own choices
				const comparable = stripKnownInputs(actual, matched);
				if (!compile(matched).test(comparable)) {
					drifting.push({
						name,
						template,
						actual,
						comparable,
					});
				}
			} else {
				result.unreadable.push(name);
			}
		}
	});

	if (drifting.length > 0) {
		// the diff shows exactly what fixing it would change: what `/fix`, unfiltered, would write, from the same state
		const { writes } = await planFixes(state, {
			missing: result.missing,
			unexpected: result.unexpected,
			drifted: drifting,
		});
		drifting.forEach(({
			name,
			template,
			actual,
			comparable,
		}) => {
			const write = writes.find((w) => w.path === workflowPath(name));
			if (write) {
				result.drifted.push({ name, diff: unifiedDiff(name, actual, write.content) });
			} else {
				// fixing it would skip it, so the diff shows the template, with what values could be recovered, and the inputs it keeps
				const { text: rewritten, why } = keepInputs(render(template, guessValues(template, comparable)), actual, state.config.keep?.[name]);
				result.drifted.push({ name, diff: unifiedDiff(name, actual, rewritten) });
				// fixing it would refuse to, rather than drop what it keeps
				result.error = [result.error, why && `${name}: ${why}`].filter(Boolean).join('; ') || null;
			}
		});
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
