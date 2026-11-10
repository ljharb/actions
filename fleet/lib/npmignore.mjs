import { JSONData } from 'json-file-plus';

import { configFile } from './kept.mjs';

/** @import { Git } from './pr.mjs' */

export const packageJson = 'package.json';

const workflows = '.github/workflows';

// what, in `publishConfig.ignore`, ignores the config file: its directory, or itself
const covering = new Set(['.github', configFile]);

/**
 * `pattern`, without a leading `/`, which only anchors it (as each of these already is), nor a trailing one after a directory (`.github`, or `.github/workflows`), which only makes it match a directory (as it is); but with one after the config file, which then matches only a directory of that name, not the file.
 * @type {(pattern: string) => string}
 */
function normalize(pattern) {
	const unanchored = pattern.replace(/^\//, '');
	return unanchored === `${configFile}/` ? unanchored : unanchored.replace(/\/$/, '');
}

// `npmignore` run as a command, in a script: on its own, or via `npx`, at a version or not (but not, eg, `.npmignore`)
const invokesNpmignore = /(?:^|[\s;&|('"])npmignore(?:@[^\s;&|)'"]*)?(?=$|[\s;&|)'"])/;

/** @type {(value: unknown) => value is Record<string, unknown>} */
function isObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a package uses `npmignore`, which writes `.npmignore` from its `publishConfig.ignore`: it's a dependency or dev dependency, or a script runs it.
 * @type {(pkg: Record<string, unknown>) => boolean}
 */
export function usesNpmignore(pkg) {
	const { scripts } = pkg;
	return ['dependencies', 'devDependencies'].some((key) => {
		const deps = pkg[key];
		return isObject(deps) && Object.hasOwn(deps, 'npmignore');
	}) || (isObject(scripts) && Object.values(scripts).some((script) => typeof script === 'string' && invokesNpmignore.test(script)));
}

/**
 * Where in `ignore` to add the config file, or `-1` when it shouldn't be.
 * Each entry is read in order, as a `.gitignore`'s lines are, and only these are understood (each with or without a leading `/`, and a directory with or without a trailing one; see `normalize`): `.github` or the config file ignore it, and either one after a `!` re-includes it, until a later one ignores it again. Nothing else of `.gitignore`'s syntax is (eg, a glob is just another entry), and an entry that isn't a string is skipped.
 * It's not added when it's already ignored, nor when `!` re-includes the file itself, which says it's meant to be published. Otherwise, it goes right after the first `.github/workflows` entry, unless a `!` that re-includes `.github` comes after that (which would re-include it there too), else at the end.
 * @type {(ignore: unknown[]) => number}
 */
function position(ignore) {
	let ignored = false;
	let published = false;
	let after = 0;
	let workflowsAt = -1;
	ignore.forEach((entry, i) => {
		if (typeof entry !== 'string') {
			return;
		}
		const negated = entry.startsWith('!');
		const pattern = normalize(entry.slice(negated ? 1 : 0));
		if (covering.has(pattern)) {
			ignored = !negated;
			if (negated) {
				published ||= pattern === configFile;
				after = i + 1;
			}
		} else if (!negated && pattern === workflows && workflowsAt < 0) {
			workflowsAt = i + 1;
		}
	});
	if (ignored || published) {
		return -1;
	}
	return workflowsAt >= after ? workflowsAt : ignore.length;
}

/** @type {(entry: unknown) => boolean} */
function isConfigEntry(entry) {
	return typeof entry === 'string' && normalize(entry) === configFile;
}

/**
 * `text` (a `package.json`), with the config file's entry in its `publishConfig.ignore` matching whether the config file will be in what's committed (`exists`), and why it changed; otherwise (including when it's absent, or isn't JSON), `null`.
 * Its package must use `npmignore` (see `usesNpmignore`), and that must be an array. When `exists`, the config file is added, when that doesn't already ignore it (see `position`); otherwise, every entry that's exactly the config file (with or without a leading `/`; not `.github`, which ignores more than it, nor one with a trailing `/`, which matches only a directory, nor a `!` that re-includes it) is removed.
 * It's re-serialized by `json-file-plus`, as `JSON.stringify` with the indentation it finds, keeping its keys' order, its line endings (`\r\n` throughout, when those outnumber lone `\n`s; otherwise, `\n`), and whether it ends with a blank line: so it's only edited when that writes `text` exactly as it is (eg, not one that's minified, has an array on one line, has no final newline, or mixes `\r\n` and `\n` line endings), so that the added or removed entries are the only lines that change.
 * @type {(text: string | null, exists: boolean) => Promise<{ content: string, reason: 'ignored' | 'unignored' } | null>}
 */
export async function syncConfigIgnore(text, exists) {
	if (text === null) {
		return null;
	}
	/** @type {JSONData<string, any>} */
	let json;
	try {
		json = new JSONData(text);
	} catch {
		return null;
	}
	if (!isObject(json.data) || json.stringify() !== text) {
		return null;
	}
	const pkg = json.data;
	const { publishConfig } = pkg;
	if (!usesNpmignore(pkg) || !isObject(publishConfig) || !Array.isArray(publishConfig.ignore)) {
		return null;
	}
	const { ignore } = publishConfig;
	if (!exists) {
		const kept = ignore.filter((entry) => !isConfigEntry(entry));
		if (kept.length === ignore.length) {
			return null;
		}
		publishConfig.ignore = kept;
		return { content: json.stringify(), reason: 'unignored' };
	}
	const at = position(ignore);
	if (at < 0) {
		return null;
	}
	// not with `json.set`, whose deep merge would merge the entries after it, index by index, into the ones they'd move onto
	ignore.splice(at, 0, configFile);
	return { content: json.stringify(), reason: 'ignored' };
}

/**
 * `package.json` at `rev`, when it's a regular file (not, eg, a symbolic link, whose text is where it points, nor executable, which writing it would change); otherwise, `null`.
 * @type {(git: Git, rev: string) => string | null}
 */
export function packageJsonAt(git, rev) {
	const [info] = git([
		'ls-tree',
		'-z',
		rev,
		'--',
		packageJson,
	]).stdout.split('\t');
	if (info.split(' ')[0] !== '100644') {
		return null;
	}
	return git(['show', `${rev}:${packageJson}`]).stdout;
}

/** @type {(git: Git, rev: string) => boolean} */
export function hasConfig(git, rev) {
	return git([
		'cat-file',
		'-e',
		`${rev}:${configFile}`,
	], { allowFailure: true }).status === 0;
}
