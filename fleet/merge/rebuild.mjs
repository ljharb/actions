/** @import { Git } from '../lib/pr.mjs' */

/**
 * One commit on `parent` with `tree`, with the message of `from` (the App's commit it replaces, whose message says what it's for).
 * @type {(git: Git, commit: { parent: string, tree: string, from: string }) => string}
 */
function commitOn(
	git,
	{
		parent,
		tree,
		from,
	},
) {
	return git(
		[
			'commit-tree',
			tree,
			'-p',
			parent,
			'-F',
			'-',
		],
		{
			input: git([
				'log',
				'-1',
				'--format=%B',
				from,
			]).stdout,
		},
	).stdout.trim();
}

/**
 * One commit on `parent` whose tree is `tree`'s, with `writes`, and the message of `from`.
 * @type {(git: Git, commit: { parent: string, tree: string, from: string }, writes: Map<string, string>) => string}
 */
export function rewrite(
	git,
	{
		parent,
		tree,
		from,
	},
	writes,
) {
	git(['read-tree', tree]);
	writes.forEach((content, file) => {
		const blob = git(
			[
				'hash-object',
				'-w',
				'--stdin',
			],
			{ input: content },
		).stdout.trim();
		git([
			'update-index',
			'--add',
			'--cacheinfo',
			`100644,${blob},${file}`,
		]);
	});
	return commitOn(git, {
		parent,
		tree: git(['write-tree']).stdout.trim(),
		from,
	});
}

/**
 * `commits`, oldest first, replayed one by one onto `parent` (see `replay`).
 * @type {(git: Git, parent: string, commits: string[]) => string | null}
 */
function replayOnto(git, parent, commits) {
	if (commits.length === 0) {
		return parent;
	}
	const [commit] = commits;
	const merged = git(
		[
			'merge-tree',
			'--write-tree',
			`--merge-base=${commit}^`,
			parent,
			commit,
		],
		{ allowFailure: true },
	);
	if (merged.status !== 0) {
		return null;
	}
	const tree = merged.stdout.split('\n')[0];
	const next = tree === git(['rev-parse', `${parent}^{tree}`]).stdout.trim() ? parent : commitOn(git, {
		parent,
		tree,
		from: commit,
	});
	return replayOnto(git, next, commits.slice(1));
}

/**
 * The PR's commits (at `tip`), oldest first, replayed one by one onto `base`'s tip, as `git rebase` would: each one's change from its first parent, applied to the one replayed before it, with its message, by the App's bot; but for merge commits, and any commit whose change what it's replayed onto already has, which are dropped. Returns what was replayed last (the base's tip, if nothing was), or `null` when any of them conflicts, after which none is replayed.
 * @type {(git: Git, at: { base: string, tip: string }) => string | null}
 */
export function replay(git, { base, tip }) {
	return replayOnto(git, git(['rev-parse', `origin/${base}`]).stdout.trim(), git([
		'rev-list',
		'--reverse',
		'--topo-order',
		'--no-merges',
		tip,
		'--not',
		`origin/${base}`,
	]).stdout.split('\n').filter(Boolean));
}
