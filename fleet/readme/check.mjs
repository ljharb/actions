import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { exec } from '../lib/exec.mjs';
import {
	drift,
	fixedReadme,
	readmePath,
} from './readme.mjs';

/** @import { RepoState } from '../lib/app.mjs' */
/** @import { Category, Identity } from './readme.mjs' */
// `readme` is the README's file name, when it isn't `README.md` (see `npmReadme`)
/** @typedef {{ repository: string, readme?: string, drifted: Category[], diff: string, error: string | null }} Result */

// the actual side is labelled with the file it's in, which may not be `README.md` (see `npmReadme`)
/** @type {(name: string, actual: string, expected: string) => string} */
function unifiedDiff(name, actual, expected) {
	const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'readme-drift-'));
	const a = path.join(dir, 'actual');
	const b = path.join(dir, 'expected');
	writeFileSync(a, actual);
	writeFileSync(b, expected);
	return exec('diff', [
		'-u', '--label', `${name} (actual)`, '--label', `${readmePath} (expected)`, a, b,
	], { allowFailure: true }).stdout;
}

/**
 * The npm package a repository publishes, from its `package.json`: its name, or `null` when it has none, or is `private` (which isn't published, so has no npm badges to show); an error, when it can't be told.
 * @type {(packageJson: string | null) => { name: string | null, error: string | null }}
 */
export function packageName(packageJson) {
	if (packageJson === null) {
		return { name: null, error: null };
	}
	let pkg;
	try {
		pkg = JSON.parse(packageJson);
	} catch {
		// `JSON.parse`'s message quotes the file, which may be private, and these errors are published
		return { name: null, error: '`package.json` is not valid JSON' };
	}
	if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.private === true) {
		return { name: null, error: null };
	}
	return typeof pkg.name === 'string' && (/^(?:@[\w.-]+\/)?[\w.-]+$/).test(pkg.name)
		? { name: pkg.name, error: null }
		: { name: null, error: '`package.json` has no valid `name`' };
}

/**
 * Whether the README drift report covers a repository at all: one that isn't archived nor opted out (`readme: false`), and publishes a package (see `packageName`), or whose state, or `package.json`, couldn't be read (which is reported).
 * @type {(state: RepoState) => boolean}
 */
export function isCovered(state) {
	if (state.stateError) {
		return true;
	}
	if (state.archived || state.config.readme === false) {
		return false;
	}
	const { name, error } = packageName(state.packageJson);
	return name !== null || error !== null;
}

/**
 * What `state`'s README should match: its package's name, the repository, and its default branch (where its CI and coverage badges look); or why that can't be told.
 * @type {(state: RepoState) => { identity: Identity } | { error: string }}
 */
export function identityOf(state) {
	const { name, error } = packageName(state.packageJson);
	if (error || name === null) {
		return { error: error ?? 'it doesn’t publish a package' };
	}
	if (!state.defaultBranch) {
		return { error: 'the repository has no default branch' };
	}
	return {
		identity: {
			name,
			repository: state.repository,
			branch: state.defaultBranch,
		},
	};
}

/**
 * Why `state`'s README can't be checked (or fixed) at all, if it can't.
 * @type {(state: RepoState) => string | null}
 */
export function unreadable({
	readme,
	readmeName,
	readmeAmbiguous,
	readmeRegular,
}) {
	if (readmeAmbiguous.length > 0) {
		return `several files npm could take as its README: ${readmeAmbiguous.map((name) => `\`${name}\``).join(', ')}`;
	}
	const name = readmeName ?? readmePath;
	if (readme === null) {
		return readmeRegular ? `\`${name}\` could not be read in full` : `there is no \`${name}\``;
	}
	// a symbolic link's text is its target, and an executable file would stop being one
	return readmeRegular ? null : `\`${name}\` is not a regular file`;
}

/**
 * How `state`'s README differs from what it should be (see `drift`), with the diff of what fixing it would change; `null` when it doesn't, or the report doesn't cover it (see `isCovered`).
 * @type {(state: RepoState) => Result | null}
 */
export function checkReadme(state) {
	const empty = {
		repository: state.repository,
		drifted: [],
		diff: '',
	};
	if (state.stateError) {
		return { ...empty, error: state.stateError };
	}
	if (!isCovered(state)) {
		return null;
	}
	const known = identityOf(state);
	if ('error' in known) {
		return { ...empty, error: [state.configError, known.error].filter(Boolean).join('; ') };
	}
	const why = unreadable(state);
	if (why !== null || state.readme === null || state.readmeName === null) {
		return { ...empty, error: [state.configError, why].filter(Boolean).join('; ') };
	}
	const drifted = drift(state.readme, known.identity, state.readmeName);
	const error = state.configError;
	if (drifted.length === 0) {
		return error ? { ...empty, error } : null;
	}
	return {
		repository: state.repository,
		...state.readmeName === readmePath ? {} : { readme: state.readmeName },
		drifted,
		// against what an unfiltered `/fix` writes, which fixes exactly what drifted
		diff: unifiedDiff(state.readmeName, state.readme, fixedReadme(state.readme, known.identity, drifted).text),
		error,
	};
}

/**
 * `checkReadme`, but a failure is only that repository's error, rather than the whole run's; a private repository's message is withheld (see `checkSafely` in `../drift/check.mjs`).
 * @type {(state: RepoState) => Result | null}
 */
export function checkReadmeSafely(state) {
	try {
		return checkReadme(state);
	} catch (error) {
		return {
			repository: state.repository,
			drifted: [],
			diff: '',
			error: state.private ? 'could not be checked' : `could not be checked: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
