/**
 * @typedef {{
 *   workflows: false | Record<string, boolean>,
 * }} Config
 */

/** @type {{ [K in keyof Config]: Exclude<Config[K], false> }} */
const defaults = {
	workflows: {},
};

const workflowName = /^[\w.-]+\.ya?ml$/;

// only the keys a file actually sets, so that a repository's own file can be merged over its account's defaults
/** @type {(text: string | null | undefined, file: string) => { config: Partial<Config>, error: string | null }} */
export function parseConfig(text, file) {
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
	};
}
