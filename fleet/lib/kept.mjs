import { parseConfig } from './config.mjs';

/** @typedef {import('./pr.mjs').Git} Git */

// a repository's own config, whose `keep` names the inputs `/fix` keeps
export const configFile = '.github/ljharb-actions.json';

/** @type {(git: Git, rev: string) => string | null} */
function show(git, rev) {
	const shown = git(['show', rev], { allowFailure: true });
	return shown.status === 0 ? shown.stdout : null;
}

/** @type {(value: unknown) => value is Record<string, unknown>} */
function isObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `.github/ljharb-actions.json` at `rev`, with `kept` added to its `keep` (as 2-space JSON); `null` if it isn't a JSON object (or its `keep` isn't one), which can't be added to.
 * @type {(git: Git, rev: string, kept: Map<string, string[]>) => string | null}
 */
export function keptConfig(git, rev, kept) {
	const text = show(git, `${rev}:${configFile}`);
	/** @type {unknown} */
	let config;
	try {
		config = text === null ? {} : JSON.parse(text);
	} catch {
		return null;
	}
	const keep = isObject(config) ? config.keep ?? {} : null;
	if (!isObject(config) || !isObject(keep)) {
		return null;
	}
	for (const [file, inputs] of kept) {
		keep[file] = [...new Set([...Array.isArray(keep[file]) ? keep[file] : [], ...inputs])];
	}
	return `${JSON.stringify({ ...config, keep }, null, 2)}\n`;
}

/** @type {(git: Git, rev: string) => Record<string, string[]>} */
function keepAt(git, rev) {
	return parseConfig(show(git, `${rev}:${configFile}`), configFile).config.keep ?? {};
}

/**
 * The inputs the App's branch, at `tip`, keeps that its base didn't when the branch was made (where they diverged): those it added (see `restore` in `fleet/merge/maintain.mjs`), by workflow file name. Only those `keep` can have (see `parseConfig`).
 * @type {(git: Git, at: { base: string, tip: string }) => Map<string, string[]>}
 */
export function keptOnBranch(git, { base, tip }) {
	const before = keepAt(git, git([
		'merge-base', `origin/${base}`, tip,
	]).stdout.trim());
	return new Map(Object.entries(keepAt(git, tip)).flatMap(([file, inputs]) => {
		const added = inputs.filter((input) => !before[file]?.includes(input));
		return added.length > 0 ? [[file, added]] : [];
	}));
}

/**
 * `keep`, with `kept` added to it.
 * @type {(keep: Record<string, string[]>, kept: Map<string, string[]>) => Record<string, string[]>}
 */
export function withKept(keep, kept) {
	/** @type {Record<string, string[]>} */
	const merged = Object.assign(Object.create(null), keep);
	for (const [file, inputs] of kept) {
		merged[file] = [...new Set([...merged[file] ?? [], ...inputs])];
	}
	return merged;
}
