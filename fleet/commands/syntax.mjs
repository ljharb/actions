import { fixBranch, relockBranch } from '../lib/branches.mjs';
import { code } from '../lib/markdown.mjs';

/** @import { Category } from '../drift/fix.mjs' */
/** @typedef {{ repositories: Set<string>, accounts: Set<string>, files: Set<string>, categories: Set<Category> }} Filters */
/** @typedef {'fix' | 'merge'} Verb */
/** @typedef {{ dryRun: boolean, line: string, filters: Filters }} Invocation */
/** @typedef {{ type: 'none' } | { type: 'error', message: string } | Invocation & { type: 'fix' } | Invocation & { type: 'merge' }} Command */

/** @type {Category[]} */
const categories = [
	'missing', 'drifted', 'unexpected',
];
// GitHub's rules for a login: alphanumerics and single hyphens, neither leading nor trailing, at most 39 characters
const login = '[a-z\\d](?:[a-z\\d]|-(?=[a-z\\d])){0,38}';
const accountPattern = new RegExp(`^${login}$`, 'i');
const repositoryPattern = new RegExp(`^${login}/[\\w.-]+$`, 'i');
const workflowPattern = /^[\w.-]+\.ya?ml$/i;

/**
 * Some of the comment's own text, whole, as inert Markdown; a reply too long for one comment is split across several.
 * @type {(text: string) => string}
 */
export function quote(text) {
	return code(text);
}

/** @type {(token: string) => token is Category} */
function isCategory(token) {
	return categories.includes(/** @type {Category} */ (token)); // eslint-disable-line no-extra-parens
}

/** @type {(word: string | undefined) => word is Verb} */
function isVerb(word) {
	return word === 'fix' || word === 'merge';
}

/** @type {(options?: { heading?: boolean }) => string} */
export function legend({ heading = true } = {}) {
	return [
		...heading ? ['### Commands', ''] : [],
		'Comment on the workflow drift report issue with one of these as the first line of the comment:',
		'',
		'- `/fix <filters>`: in each repository this report covers that matches, open (or update) a PR, from its `fleet/workflows` branch, that makes its workflow files match the templates.',
		'- `/dry-run fix <filters>`: reply with what `/fix` would do, without changing anything.',
		`- \`/merge <filters>\`: in each repository this report covers that matches, fast-forward the default branch to each open PR the App’s bot opened from its \`${fixBranch}\` or \`${relockBranch}\` branch, once every check on it has passed (or been skipped); one whose checks haven’t finished yet is queued, and merged once they pass.`,
		'- `/dry-run merge <filters>`: reply with what `/merge` would do, without changing or queueing anything.',
		'',
		'At least one filter is required. Each is, case-insensitively, a repository (`owner/name`), an account (`owner`), a workflow file name (`*.yml` or `*.yaml`), or a kind of discrepancy (`missing`, `drifted`, or `unexpected`); `/merge` takes only repositories and accounts. Only files that match every kind of filter given (any one filter of each kind) are fixed. For example:',
		'',
		'- `/dry-run fix owner`: what fixing everything in `owner`’s repositories would do',
		'- `/fix owner/name rebase.yml`: fix only `rebase.yml`, in only `owner/name`',
		'- `/fix owner other-owner missing`: add the missing files to `owner`’s and `other-owner`’s repositories',
		'- `/merge owner/name other-owner`: merge the bot’s PRs in `owner/name` and in `other-owner`’s repositories',
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
	const first = words[0].toLowerCase();
	const dryRun = first === '/dry-run';
	const verb = dryRun ? words[1]?.toLowerCase() : first.slice(1);
	if (!isVerb(verb)) {
		return { type: 'error', message: `Unknown command: ${quote(line)}.` };
	}
	const name = dryRun ? `/dry-run ${verb}` : `/${verb}`;
	const tokens = words.slice(dryRun ? 2 : 1).filter(Boolean);
	if (tokens.length === 0) {
		return { type: 'error', message: `${code(name)} needs at least one filter: every repository at once is too broad.` };
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
		return { type: 'error', message: `Unknown ${unknown.length === 1 ? 'filter' : 'filters'}: ${unknown.map(quote).join(', ')}.` };
	}
	// a PR is merged whole, so there's nothing for a file or a kind of discrepancy to narrow
	const unsupported = verb === 'merge' ? [...filters.files, ...filters.categories] : [];
	if (unsupported.length > 0) {
		return { type: 'error', message: `${code(name)} takes only repository (\`owner/name\`) and account (\`owner\`) filters, not ${unsupported.map(quote).join(', ')}.` };
	}
	return {
		type: verb, dryRun, line, filters,
	};
}
