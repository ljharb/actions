import { loadTemplate, templateFor } from '../drift/check.mjs';
import { calledWorkflows, declaredInputs } from '../drift/inputs.mjs';
import { code } from './markdown.mjs';

/**
 * @typedef {{
 *   workflows: false | Record<string, boolean>,
 *   keep: Record<string, string[]>,
 * }} Config
 */

/** @type {{ [K in keyof Config]: Exclude<Config[K], false> }} */
const defaults = {
	workflows: {},
	keep: {},
};

const workflowName = /^[\w.-]+\.ya?ml$/;
const inputName = /^[\w-]+$/;

/** @type {(value: unknown) => value is Record<string, string[]>} */
function isKeep(value) {
	return !!value
		&& typeof value === 'object'
		&& !Array.isArray(value)
		&& Object.entries(value).every(([k, v]) => workflowName.test(k) && Array.isArray(v) && v.every((input) => typeof input === 'string' && inputName.test(input)));
}

/**
 * Of `keep` (already a valid shape), what `/fix` can keep: for each workflow file, the inputs that a reusable workflow of this repo's that its template calls declares, which are all `/fix` ever writes into it; and what it can't, as config errors.
 * @type {(keep: Record<string, string[]>) => { keep: Record<string, string[]>, errors: string[] }}
 */
function keepable(keep) {
	/** @type {Record<string, string[]>} */
	const valid = Object.create(null);
	/** @type {string[]} */
	const errors = [];
	Object.entries(keep).forEach(([name, inputs]) => {
		const template = templateFor(name);
		const called = template === null ? [] : [...calledWorkflows(loadTemplate(template))];
		if (called.length === 0) {
			errors.push(`\`keep\` names ${code(name)}, but \`/fix\` never writes a file of that name that calls one of this repo’s reusable workflows, so it has no inputs to keep`);
		} else {
			const declared = new Set(called.flatMap((file) => [...declaredInputs(file)]));
			const undeclared = inputs.filter((input) => !declared.has(input));
			if (undeclared.length > 0) {
				errors.push(`\`keep\`’s ${code(name)} names ${undeclared.map(code).join(', ')}, which ${called.map(code).join(' or ')} doesn’t declare as ${undeclared.length === 1 ? 'an input' : 'inputs'}`);
			}
			valid[name] = inputs.filter((input) => declared.has(input));
		}
	});
	return { keep: valid, errors };
}

/** @type {(keep: unknown, account: boolean) => { keep?: Record<string, string[]>, errors: string[] }} */
function parseKeep(keep, account) {
	if (account) {
		return { errors: ['`keep` only applies to one repository, so it can only be set in its own `.github/ljharb-actions.json`'] };
	}
	if (!isKeep(keep)) {
		return { errors: ['`keep` must be an object mapping workflow file names (`*.yml` or `*.yaml`) to arrays of input names'] };
	}
	// what can't be kept is an error, not silently dropped, but what can still is
	return keepable(keep);
}

/**
 * Only the keys a file actually sets, so that a repository's own file can be merged over its account's defaults.
 * With `account`, it's an account's defaults, which can't set what only applies to one repository (`keep`).
 * @type {(text: string | null | undefined, file: string, options?: { account?: boolean }) => { config: Partial<Config>, error: string | null }}
 */
export function parseConfig(text, file, { account = false } = {}) {
	if (typeof text !== 'string') {
		return { config: {}, error: null };
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		// `JSON.parse`'s message quotes the file, which may be private, and these errors are published
		return { config: {}, error: `${file} is not valid JSON` };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { config: {}, error: `${file} must contain a JSON object` };
	}

	/** @type {Partial<Config>} */
	const config = {};
	const errors = [];

	if ('workflows' in raw) {
		if (raw.workflows === false) {
			config.workflows = false;
		} else if (raw.workflows === true) {
			config.workflows = {};
		} else if (
			raw.workflows
			&& typeof raw.workflows === 'object'
			&& !Array.isArray(raw.workflows)
			&& Object.entries(raw.workflows).every(([k, v]) => workflowName.test(k) && typeof v === 'boolean')
		) {
			config.workflows = { __proto__: null, ...raw.workflows };
		} else {
			errors.push('`workflows` must be a boolean, or an object mapping workflow file names (`*.yml` or `*.yaml`) to booleans');
		}
	}

	if ('keep' in raw) {
		const kept = parseKeep(raw.keep, account);
		if (kept.keep) {
			config.keep = kept.keep;
		}
		errors.push(...kept.errors);
	}

	return { config, error: errors.length > 0 ? `${file}: ${errors.join('; ')}` : null };
}

// a repository's own setting wins; when both are objects, they're merged, with the repository's entries winning
/**
 * @template {object} T
 * @param {false | T | undefined} account
 * @param {false | T | undefined} own
 * @param {T} fallback
 * @returns {false | T}
 */
function mergeKey(account, own, fallback) {
	if (own === false || (own === undefined && account === false)) {
		return false;
	}
	return {
		__proto__: null,
		...fallback,
		...account || {},
		...own,
	};
}

/** @type {(account: Partial<Config>, own: Partial<Config>) => Config} */
export function mergeConfig(account, own) {
	return {
		workflows: mergeKey(account.workflows, own.workflows, defaults.workflows),
		// only ever a repository's own
		keep: Object.assign(Object.create(null), defaults.keep, own.keep),
	};
}
