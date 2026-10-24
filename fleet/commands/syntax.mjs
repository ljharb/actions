import { code } from '../lib/markdown.mjs';

/** @typedef {import('../drift/fix.mjs').Category} Category */
/** @typedef {{ repositories: Set<string>, accounts: Set<string>, files: Set<string>, categories: Set<Category> }} Filters */
/** @typedef {{ type: 'none' } | { type: 'error', message: string } | { type: 'fix', dryRun: boolean, line: string, filters: Filters }} Command */

/** @type {Category[]} */
const categories = [
	'missing', 'drifted', 'unexpected',
];
// GitHub's rules for a login: alphanumerics and single hyphens, neither leading nor trailing, at most 39 characters
const login = '[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}';
const accountPattern = new RegExp(`^${login}$`, 'i');
const repositoryPattern = new RegExp(`^${login}/[\\w.-]+$`, 'i');
const workflowPattern = /^[\w.-]+\.ya?ml$/i;
// a reply quotes the comment's own text, and must still fit in a comment however long that text is
const maxQuoted = 200;
const maxUnknown = 10;

/**
 * Some of the comment's own text, cut short when it's long, as inert Markdown.
 * @type {(text: string) => string}
 */
export function quote(text) {
	return code(text.length > maxQuoted ? `${text.slice(0, maxQuoted)}…` : text);
}

/** @type {(token: string) => token is Category} */
function isCategory(token) {
	return categories.includes(/** @type {Category} */ (token)); // eslint-disable-line no-extra-parens
}

/** @type {() => string} */
export function legend() {
	return [
		'### Commands',
		'',
		'Comment on the workflow drift report issue with one of these as the first line of the comment:',
		'',
		'- `/fix <filters>`: in each repository this report covers that matches, open (or update) a PR, from its `fleet/workflows` branch, that makes its workflow files match the templates.',
		'- `/dry-run fix <filters>`: reply with what `/fix` would do, without changing anything.',
		'',
		'At least one filter is required. Each is, case-insensitively, a repository (`owner/name`), an account (`owner`), a workflow file name (`*.yml` or `*.yaml`), or a kind of discrepancy (`missing`, `drifted`, or `unexpected`). Only files that match every kind of filter given (any one filter of each kind) are fixed. For example:',
		'',
		'- `/dry-run fix owner`: what fixing everything in `owner`’s repositories would do',
		'- `/fix owner/name rebase.yml`: fix only `rebase.yml`, in only `owner/name`',
		'- `/fix owner other-owner missing`: add the missing files to `owner`’s and `other-owner`’s repositories',
		'',
		'Only people with write access to this repository can run them.',
	].join('\n');
}

/**
 * The command on the first line of a comment, if it's one.
 * An `error`'s message is Markdown, with any of the comment's own text in it kept inert.
 * @type {(body: string) => Command}
 */
export function parseCommand(body) {
	const line = body.split(/\r?\n/, 1)[0].trim();
	if (!line.startsWith('/')) {
		return { type: 'none' };
	}
	const words = line.split(/[\s,]+/);
	const fix = words[0].toLowerCase() === '/fix';
	const dryRun = words[0].toLowerCase() === '/dry-run' && words[1]?.toLowerCase() === 'fix';
	if (!fix && !dryRun) {
		return { type: 'error', message: `Unknown command: ${quote(line)}.` };
	}
	const tokens = words.slice(dryRun ? 2 : 1).filter(Boolean);
	if (tokens.length === 0) {
		return { type: 'error', message: `${code(dryRun ? '/dry-run fix' : '/fix')} needs at least one filter: every repository at once is too broad.` };
	}

	/** @type {Filters} */
	const filters = {
		repositories: new Set(),
		accounts: new Set(),
		files: new Set(),
		categories: new Set(),
	};
	/** @type {string[]} */
	const unknown = [];
	for (const raw of tokens) {
		const token = raw.toLowerCase();
		// a category can't also be an account, since accounts named like one can still be matched by their repositories
		if (isCategory(token)) {
			filters.categories.add(token);
		} else if (workflowPattern.test(token)) {
			filters.files.add(token);
		} else if (repositoryPattern.test(token)) {
			filters.repositories.add(token);
		} else if (accountPattern.test(token)) {
			filters.accounts.add(token);
		} else {
			unknown.push(raw);
		}
	}
	if (unknown.length > 0) {
		const more = unknown.length > maxUnknown ? [`and ${unknown.length - maxUnknown} more`] : [];
		return { type: 'error', message: `Unknown ${unknown.length === 1 ? 'filter' : 'filters'}: ${[...unknown.slice(0, maxUnknown).map(quote), ...more].join(', ')}.` };
	}
	return {
		type: 'fix', dryRun, line, filters,
	};
}
