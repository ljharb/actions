import {
	botBranches,
	fixBranch,
	readmeBranch,
	relockBranch,
} from '../lib/branches.mjs';
import { code } from '../lib/markdown.mjs';
import { categories as readmeCategories } from '../readme/readme.mjs';

/** @import { Category } from '../drift/fix.mjs' */
/** @import { Category as ReadmeCategory } from '../readme/readme.mjs' */
/**
 * Which report a command is on: the workflow drift report, or the README drift report.
 * @typedef {'workflows' | 'readme'} Report
 */
/** @typedef {{ repositories: Set<string>, accounts: Set<string>, files: Set<string>, categories: Set<Category | ReadmeCategory> }} Filters */
/** @typedef {'fix' | 'merge'} Verb */
/** @typedef {{ dryRun: boolean, line: string, filters: Filters }} Invocation */
/** @typedef {{ type: 'none' } | { type: 'error', message: string } | Invocation & { type: 'fix' } | Invocation & { type: 'merge' }} Command */

/** @type {readonly Category[]} */
export const workflowCategories = Object.freeze([
	'missing', 'drifted', 'unexpected',
]);

/**
 * What's particular to each report's commands: the kinds of discrepancy its filters take, whether they take file names, and the branches of the App's that its `/fix` opens PRs from and its `/merge` merges PRs from.
 * @type {Record<Report, { categories: readonly (Category | ReadmeCategory)[], files: boolean, fixBranch: string, mergeBranches: readonly string[] }>}
 */
export const reports = {
	workflows: {
		categories: workflowCategories,
		files: true,
		fixBranch,
		mergeBranches: Object.freeze([fixBranch, relockBranch]),
	},
	readme: {
		categories: readmeCategories,
		files: false,
		fixBranch: readmeBranch,
		mergeBranches: Object.freeze([readmeBranch]),
	},
};
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
export function isWorkflowCategory(token) {
	return workflowCategories.some((category) => category === token);
}

/**
 * The branches of the report whose `/merge` merges PRs from `branch` (see `reports`): what that report counts as the App's PRs; every one of the App's branches, for one no report's `/merge` merges.
 * @type {(branch: string) => readonly string[]}
 */
export function reportBranches(branch) {
	return Object.values(reports).find((r) => r.mergeBranches.includes(branch))?.mergeBranches ?? botBranches;
}

/**
 * The filters each report's commands take; `any` is every report's at once, for reading a command on an issue without knowing which report it's on (their kinds of discrepancy never overlap), which is only ever for telling which repositories it's about, and which command it is (see `identify` in `./replies.mjs`, which doesn't tell a filter's kind apart).
 * @type {Record<Report | 'any', { categories: readonly (Category | ReadmeCategory)[], files: boolean }>}
 */
const grammars = {
	...reports,
	any: {
		categories: [...workflowCategories, ...readmeCategories],
		files: true,
	},
};

/** @type {(grammar: Report | 'any', token: string) => token is Category | ReadmeCategory} */
function isCategory(grammar, token) {
	return grammars[grammar].categories.some((category) => category === token);
}

/** @type {(word: string | undefined) => word is Verb} */
export function isVerb(word) {
	return word === 'fix' || word === 'merge';
}

/** @type {(options?: { heading?: boolean, report?: Report }) => string} */
export function legend({ heading = true, report = 'workflows' } = {}) {
	if (report === 'readme') {
		return [
			...heading ? ['### Commands', ''] : [],
			'Comment on the README drift report issue with one of these as the first line of the comment:',
			'',
			`- \`/fix <filters>\`: in each repository this report covers that matches, open (or update) a PR, from its \`${readmeBranch}\` branch, that renames its README to \`README.md\` when npm reads it under another name (in a commit of its own), and makes its heading, the badges under it, and the link definitions they use match the fleet’s.`,
			'- `/dry-run fix <filters>`: reply with what `/fix` would do, without changing anything.',
			`- \`/merge <filters>\`: in each repository the App is installed on that matches, fast-forward the default branch to each open PR the App’s bot opened from its \`${readmeBranch}\` branch, once every check on it has passed (or been skipped); one whose checks haven’t finished yet is queued, and merged once they pass.`,
			'- `/dry-run merge <filters>`: reply with what `/merge` would do, without changing or queueing anything.',
			'',
			'At least one filter is required. Each is, case-insensitively, a repository (`owner/name`), an account (`owner`), or a kind of discrepancy (`filename`, `heading`, `badges`, or `links`); `/merge` takes only repositories and accounts. Only the kinds of discrepancy given (any one of them) are fixed, in the repositories that match. For example:',
			'',
			'- `/dry-run fix owner`: what fixing everything in `owner`’s repositories would do',
			'- `/fix owner/name links`: fix only the link definitions, in only `owner/name`',
			'- `/fix owner other-owner badges links`: fix the badges, and the definitions they use, in `owner`’s and `other-owner`’s repositories',
			'- `/merge owner/name other-owner`: merge the bot’s README PRs in `owner/name` and in `other-owner`’s repositories',
			'',
			'Only people with write access to this repository can run them.',
		].join('\n');
	}
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
 * @type {(body: string, grammar?: Report | 'any') => Command}
 */
export function parseCommand(body, grammar = 'workflows') {
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
	/** @type {string[]} */
	const elsewhere = [];
	tokens.forEach((raw) => {
		const token = raw.toLowerCase();
		// a category can't also be an account, since accounts named like one can still be matched by their repositories
		if (isCategory(grammar, token)) {
			filters.categories.add(token);
		} else if (grammars[grammar].files && workflowPattern.test(token)) {
			filters.files.add(token);
		} else if (repositoryPattern.test(token)) {
			filters.repositories.add(token);
		} else if (isCategory('any', token) || workflowPattern.test(token)) {
			// another report's filter, which never means an account here, as it doesn't there
			elsewhere.push(raw);
		} else if (accountPattern.test(token)) {
			filters.accounts.add(token);
		} else {
			unknown.push(raw);
		}
	});
	if (unknown.length > 0) {
		return { type: 'error', message: `Unknown ${unknown.length === 1 ? 'filter' : 'filters'}: ${unknown.map(quote).join(', ')}.` };
	}
	if (elsewhere.length > 0) {
		return { type: 'error', message: `${elsewhere.map(quote).join(', ')} ${elsewhere.length === 1 ? 'is a filter' : 'are filters'} only on the other fleet report’s issue, not this one.` };
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
