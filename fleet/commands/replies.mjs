import { createHash } from 'crypto';

import * as core from '@actions/core';

import { failureDetails } from '../lib/app.mjs';
import { legacyAuthor } from '../lib/issues.mjs';
import { candidatePRs } from '../lib/merge.mjs';
import { hideable, minimizeEach } from '../lib/said.mjs';
import { isVerb, parseCommand } from './syntax.mjs';

/** @import { Octokit } from '../lib/app.mjs' */
/** @import { Sweeping } from '../lib/report.mjs' */
/** @import { Classifier } from '../lib/said.mjs' */
/** @import { Invocation, Verb } from './syntax.mjs' */
/** @typedef {Invocation & { type: Verb }} Run */
/**
 * Which command a reply is to, as its parser understands it: its verb, whether it's a dry run, and a digest of its filters (see `identify`).
 * @typedef {{ verb: Verb, dryRun: boolean, digest: string }} Identity
 */
/** @typedef {{ id: number, node_id?: string, body?: string | null, user?: { login?: string } | null }} IssueComment */

const markerPattern = /^<!-- fleet:reply:(?:(?<dryRun>dry-run):)?(?<verb>fix|merge):(?<digest>[0-9a-f]{64}) -->\n/;

/**
 * Which command `command` is: its filters (each already lowercased) are sorted, so that the same filters, in any order or case, are the same command; and digested, so that a marker is short however many filters there are, and never names one.
 * @type {(command: Run) => Identity}
 */
export function identify({
	type,
	dryRun,
	filters,
}) {
	const tokens = Array.from(filters.repositories).concat(
		Array.from(filters.accounts),
		Array.from(filters.files),
		Array.from(filters.categories),
	).sort();
	return {
		verb: type,
		dryRun,
		digest: createHash('sha256').update(tokens.join(' ')).digest('hex'),
	};
}

/**
 * The marker hidden at the start of each part of a reply to `command`, so that a later reply to the same command can find every part of it.
 * @type {(command: Run) => string}
 */
export function replyMarker(command) {
	const {
		verb,
		dryRun,
		digest,
	} = identify(command);
	return `<!-- fleet:reply:${dryRun ? 'dry-run:' : ''}${verb}:${digest} -->`;
}

/**
 * A reply's part without its marker, if it has one: as it's shown in the run summary, where nothing needs to find it.
 * @type {(body: string) => string}
 */
export function unmarked(body) {
	return body.replace(markerPattern, '');
}

/**
 * Which command a part of one of the App's replies is a reply to, if it's one: by its marker (see `replyMarker`), or, for a reply from before replies had one, by the command it quotes at the start of its first part.
 * An unmarked reply's later parts (`_continued (2/3)_`) quote nothing, so they're found in `earlierReplies`.
 * @type {(body: string) => Identity & { marked: boolean } | null}
 */
export function repliedTo(body) {
	const marked = markerPattern.exec(body)?.groups;
	// the marker's pattern only matches a verb
	if (marked && isVerb(marked.verb)) {
		return {
			verb: marked.verb,
			dryRun: !!marked.dryRun,
			digest: marked.digest,
			marked: true,
		};
	}
	// a quoted command is never padded, and has no backticks or pipes to escape, since none is valid in one
	const quoted = (/^`(?<line>\/[^`\n]+)` \((?:a dry run, |from each repository’s )/).exec(body)?.groups;
	const command = quoted ? parseCommand(quoted.line) : null;
	return command?.type === 'fix' || command?.type === 'merge' ? { ...identify(command), marked: false } : null;
}

/**
 * Whether a reply to `later` makes an earlier reply to `earlier` outdated: they're the same command (by verb and filters), and the earlier one was a dry run, or the later one wasn't (what a real run did stays shown until another real run).
 * @type {(later: Identity, earlier: Identity) => boolean}
 */
export function supersedes(later, earlier) {
	return later.verb === earlier.verb
		&& later.digest === earlier.digest
		&& (earlier.dryRun || !later.dryRun);
}

/**
 * `author`'s comments, among `comments` (in the order they were posted), each with the parts that carry it on: those of `author`'s comments right after one that ends saying it's continued below (with none of `author`'s in between) that say which part they are, in order.
 * A marked reply's later parts start with its marker (see `replyMarker`), so each is found on its own.
 * @template {IssueComment} T
 * @param {T[]} comments
 * @param {string} author
 * @returns {T[][]}
 */
function replyParts(comments, author) {
	/** @type {T[][]} */
	const replies = [];
	/** @type {{ next: number, total: number } | null} */
	let pending = null;
	comments.filter((c) => c.user?.login?.toLowerCase() === author.toLowerCase()).forEach((c) => {
		const body = c.body ?? '';
		const continued = (/^_continued \((?<part>\d+)\/(?<total>\d+)\)_\n/).exec(body)?.groups;
		if (pending && continued && Number(continued.part) === pending.next && Number(continued.total) === pending.total) {
			replies[replies.length - 1].push(c);
			pending = pending.next < pending.total ? { ...pending, next: pending.next + 1 } : null;
		} else {
			replies.push([c]);
			const more = (/\n_continued below \(2\/(?<total>\d+)\)_$/).exec(body)?.groups;
			pending = more ? { next: 2, total: Number(more.total) } : null;
		}
	});
	return replies;
}

/** @type {(parts: IssueComment[]) => string[]} */
function nodeIds(parts) {
	return parts.flatMap((c) => (c.node_id ? [c.node_id] : []));
}

/**
 * The node IDs of the parts of `author`'s replies, among `comments` (in the order they were posted), to a command that `matches` (see `replyParts`).
 * @type {(comments: IssueComment[], author: string, matches: (earlier: Identity) => boolean) => string[]}
 */
function repliesMatching(comments, author, matches) {
	return replyParts(comments, author).flatMap((parts) => {
		const earlier = repliedTo(parts[0].body ?? '');
		// a marked reply's every part is marked, so it's never carried on by an unmarked one
		const reply = earlier?.marked ? parts.slice(0, 1) : parts;
		return earlier && matches(earlier) ? nodeIds(reply) : [];
	});
}

/**
 * Which repository (`owner/name`, lowercased) a reply of the merge queue's is only about, as every row of its table, across all its `parts`, names it; or `null`, for any other comment, or one about more than one repository.
 * @type {(parts: IssueComment[]) => string | null}
 */
export function queueReplyAbout(parts) {
	if (!(parts[0].body ?? '').startsWith('The merge queue, as of [this run](')) {
		return null;
	}
	const repositories = new Set(parts.flatMap((c) => Array.from(String(c.body).matchAll(/^\| `(?<repository>[^`|]+)` \|/gm), (m) => m[1].toLowerCase())));
	return repositories.size === 1 ? Array.from(repositories)[0] : null;
}

/**
 * The node IDs of the parts of `author`'s replies, among `comments` (in the order they were posted), that a reply to `command` makes outdated (see `supersedes`).
 * @type {(comments: IssueComment[], author: string, command: Run) => string[]}
 */
export function earlierReplies(comments, author, command) {
	const later = identify(command);
	return repliesMatching(comments, author, (earlier) => supersedes(later, earlier));
}

/**
 * Whether `command` is only about `repository` (`owner/name`, lowercased): its filters name only that repository (and, if any, its account), so that whatever else they narrow it by, it selects nothing else.
 * @type {(command: Run, repository: string) => boolean}
 */
export function onlyAbout({ filters: { repositories, accounts } }, repository) {
	return repositories.size === 1
		&& repositories.has(repository)
		&& (accounts.size === 0 || (accounts.size === 1 && accounts.has(repository.split('/')[0])));
}

/**
 * The node IDs of the comments, among `comments` (in the order they were posted), that are only about one of `repositories` (each `owner/name`, lowercased): the commands only about one of them (see `onlyAbout`), by anyone; every part of `author`'s replies to those; and every part of the merge queue's replies (by `author`) only about one of them (see `queueReplyAbout`).
 * @type {(comments: IssueComment[], author: string, repositories: Set<string>) => string[]}
 */
export function aboutOnly(comments, author, repositories) {
	/** @type {Identity[]} */
	const commands = [];
	/** @type {string[]} */
	const ids = [];
	comments.forEach((c) => {
		const command = parseCommand(c.body ?? '');
		if ((command.type === 'fix' || command.type === 'merge') && Array.from(repositories).some((r) => onlyAbout(command, r))) {
			commands.push(identify(command));
			if (c.node_id) {
				ids.push(c.node_id);
			}
		}
	});
	const queued = replyParts(comments, author).flatMap((parts) => {
		const about = queueReplyAbout(parts);
		return about && repositories.has(about) ? nodeIds(parts) : [];
	});
	const hide = new Set(ids.concat(
		repliesMatching(comments, author, (earlier) => commands.some((c) => c.verb === earlier.verb
			&& c.dryRun === earlier.dryRun
			&& c.digest === earlier.digest)),
		queued,
	));
	return comments.flatMap((c) => (c.node_id && hide.has(c.node_id) ? [c.node_id] : []));
}

/**
 * Warns that `what` failed, with only what of `error` is safe to say publicly (see `failureDetails`).
 * @type {(what: string, error: unknown) => void}
 */
function warnFailed(what, error) {
	const details = failureDetails(error);
	core.warning(`${what}${details.length > 0 ? ` (${details.join(', ')})` : ''}`);
}

/**
 * Once the App's bot has posted the comments `ours` on issue `number` (as GitHub created them, which says who the bot is), hides those of the comments before them that `pick` picks (by node ID), as `classifier`.
 * Only comments posted before `ours` are looked at, so that a later one's (eg, a reply to a run that finished sooner) is never hidden; nor are those already hidden (or since deleted).
 * Returns how many it hid. Hiding is never worth failing anything over, so a failure only warns (`unread`, when they couldn't be read, and `unhidden`, with how many couldn't be hidden), without saying which comments; `hid` is what's logged, with how many were hidden, when any were.
 * @type {(options: {
 *   octokit: Octokit,
 *   owner: string,
 *   repo: string,
 *   number: number,
 *   ours: { id: number, author?: string }[],
 *   pick: (earlier: IssueComment[], author: string) => string[],
 *   classifier: Classifier,
 *   unread: string,
 *   unhidden: (count: number) => string,
 *   hid: (count: number) => string,
 * }) => Promise<number>}
 */
async function hideBefore({
	octokit,
	owner,
	repo,
	number,
	ours,
	pick,
	classifier,
	unread,
	unhidden,
	hid,
}) {
	const author = ours[0]?.author;
	if (!author) {
		return 0;
	}
	const own = new Set(ours.map((c) => c.id));
	/** @type {string[]} */
	let ids;
	try {
		const comments = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: number, // eslint-disable-line camelcase
			per_page: 100, // eslint-disable-line camelcase
		});
		const first = comments.findIndex((c) => own.has(c.id));
		const earlier = (first === -1 ? comments : comments.slice(0, first)).filter((c) => !own.has(c.id));
		ids = pick(earlier, author);
		if (ids.length > 0) {
			const left = await hideable(octokit, ids);
			ids = ids.filter((id) => left.has(id));
		}
	} catch (error) {
		warnFailed(unread, error);
		return 0;
	}
	const failures = await minimizeEach(octokit, ids.map((id) => ({ id, classifier })));
	if (failures.length > 0) {
		warnFailed(unhidden(failures.length), failures[0]);
	}
	const hidden = ids.length - failures.length;
	if (hidden > 0) {
		core.info(hid(hidden));
	}
	return hidden;
}

/**
 * Once the App's bot has replied to `command` on issue `number`, in the comments `ours`, hides its earlier replies to the same command that this reply makes outdated (see `supersedes`), as `OUTDATED`; every part of each (see `hideBefore`).
 * Nobody else's comments are touched; a failure only warns, without saying which command (that could name a private repository).
 * @type {(options: { octokit: Octokit, owner: string, repo: string, number: number, command: Run, ours: { id: number, author?: string }[] }) => Promise<number>}
 */
export async function hideEarlierReplies({
	octokit,
	owner,
	repo,
	number,
	command,
	ours,
}) {
	return hideBefore({
		octokit,
		owner,
		repo,
		number,
		ours,
		pick: (earlier, author) => earlierReplies(earlier, author, command),
		classifier: 'OUTDATED',
		unread: 'could not read the App’s earlier replies to this command, to hide them as outdated',
		unhidden: (count) => `could not hide ${count} of the App’s earlier replies to this command as outdated`,
		hid: (count) => `hid ${count} of the App’s earlier replies to this command as outdated`,
	});
}

/**
 * Once the App's bot has posted the comments `ours` on issue `number`, saying that the last of its open PRs in each of `repositories` was merged (or, for the merge queue, found already merged or closed) (each `owner/name`, public), hides every comment before them that's only about one of those (see `aboutOnly`), as `RESOLVED`: there's nothing left there to fix or merge.
 * A failure only warns, never naming a repository.
 * @type {(options: { octokit: Octokit, owner: string, repo: string, number: number, repositories: string[], ours: { id: number, author?: string }[] }) => Promise<number>}
 */
export async function hideResolved({
	octokit,
	owner,
	repo,
	number,
	repositories,
	ours,
}) {
	if (repositories.length === 0) {
		return 0;
	}
	const resolved = new Set(repositories.map((r) => r.toLowerCase()));
	return hideBefore({
		octokit,
		owner,
		repo,
		number,
		ours,
		pick: (earlier, author) => aboutOnly(earlier, author, resolved),
		classifier: 'RESOLVED',
		unread: 'could not read the comments on the report, to hide those about a repository the App has no PRs left open in, as resolved',
		unhidden: (count) => `could not hide ${count} of the comments about a repository the App has no PRs left open in, as resolved`,
		hid: (count) => `hid ${count} ${count === 1 ? 'comment' : 'comments'} about a repository the App has no PRs left open in, as resolved`,
	});
}

/**
 * The marker a part of one of the App's replies starts with (see `replyMarker`), or `''`, when it has none.
 * @type {(comment: IssueComment) => string}
 */
function markerOf(comment) {
	return markerPattern.exec(comment.body ?? '')?.[0] ?? '';
}

/**
 * The replies, among `comments` (in the order they were posted), of each of `authors` (see `replyParts`), in the order they were posted, each as its parts.
 * A marked reply's later parts are found as an unmarked one's are, as each says which part it is after its marker, so that every reply is whole (a later part found on its own is still a reply to its marker's command).
 * A part is only ever one of a reply's whose first part has the same marker (or, like it, none), so that a part of another reply, posted between its parts, is found on its own instead.
 * @type {(comments: IssueComment[], authors: ReadonlySet<string>) => IssueComment[][]}
 */
function appReplies(comments, authors) {
	const unmarkedComments = comments.map((c) => ({
		...c,
		body: unmarked(c.body ?? ''),
		original: c,
	}));
	return authors.values()
		.flatMap((author) => replyParts(unmarkedComments, author))
		.map((parts) => parts.map((c) => c.original))
		.flatMap((parts) => {
			const marker = markerOf(parts[0]);
			return [parts.filter((c) => markerOf(c) === marker)].concat(parts
				.filter((c) => markerOf(c) !== marker)
				.map((c) => [c]));
		})
		.toArray()
		.sort((a, b) => comments.indexOf(a[0]) - comments.indexOf(b[0]));
}

/**
 * The node IDs of every part of each of the replies of `authors`, among `comments` (in the order they were posted), that a later one of theirs makes outdated (see `supersedes`): so the latest reply to each command, and anything else, is never among them.
 * A later part of a reply found on its own (eg, between another reply's parts) can be outdated, but never makes another reply so, since it isn't a reply on its own.
 * @type {(comments: IssueComment[], authors: ReadonlySet<string>) => string[]}
 */
export function outdatedReplies(comments, authors) {
	const replies = appReplies(comments, authors).map((parts) => ({
		parts,
		replied: repliedTo(parts[0].body ?? ''),
		whole: !(/^_continued \(\d+\/\d+\)_\n/).test(unmarked(parts[0].body ?? '')),
	}));
	return replies.flatMap(({ parts, replied }, i) => (
		replied && replies.slice(i + 1).some((later) => later.whole && later.replied && supersedes(later.replied, replied))
			? nodeIds(parts)
			: []
	));
}

/**
 * The numbers of the PRs of `repository` (`owner/name`, lowercased) that `body` links to, on `server`.
 * @type {(body: string, server: string, repository: string) => number[]}
 */
function linkedPRs(body, server, repository) {
	return body.matchAll(/(?<origin>https?:\/\/[^\s/()<>[\]`|]+)\/(?<owner>[\w.-]+)\/(?<name>[\w.-]+)\/pull\/(?<number>\d+)/g)
		.filter(({
			1: origin,
			2: owner,
			3: name,
		}) => origin.toLowerCase() === server.toLowerCase() && `${owner}/${name}`.toLowerCase() === repository)
		.map(({ 4: number }) => Number(number))
		.toArray();
}

/**
 * Each repository (`owner/name`, lowercased) that some of `comments` (in the order they were posted) are only about: a command only about it (see `onlyAbout`), by anyone, or a merge queue reply of one of `authors` (see `queueReplyAbout`).
 * For each, the node IDs of every comment only about it (see `aboutOnly`), and the numbers of its PRs that those of `authors` link to (on `server`), in order.
 * @type {(comments: IssueComment[], authors: ReadonlySet<string>, server: string) => Map<string, { ids: string[], prs: number[] }>}
 */
export function aboutEach(comments, authors, server) {
	/** @type {Set<string>} */
	const repositories = new Set();
	comments.forEach((c) => {
		const command = parseCommand(c.body ?? '');
		if (command.type === 'fix' || command.type === 'merge') {
			const [repository] = command.filters.repositories;
			if (repository && onlyAbout(command, repository)) {
				repositories.add(repository);
			}
		}
	});
	appReplies(comments, authors).forEach((parts) => {
		const about = queueReplyAbout(parts);
		if (about) {
			repositories.add(about);
		}
	});
	const own = new Set(authors.values().map((a) => a.toLowerCase()));
	return new Map(repositories.values().map((repository) => {
		const only = new Set(authors.values().flatMap((author) => aboutOnly(comments, author, new Set([repository]))));
		const about = comments.filter((c) => c.node_id && only.has(c.node_id));
		const prs = new Set(about
			.filter((c) => own.has(c.user?.login?.toLowerCase() ?? ''))
			.flatMap((c) => linkedPRs(String(c.body), server, repository)));
		return [
			repository,
			{
				ids: nodeIds(about),
				prs: prs.values().toArray().sort((a, b) => a - b),
			},
		];
	}));
}

/**
 * Whether every one of `prs`, in `repository` (`owner/name`), is closed (or merged), and the App's bot (`bot`) has no open PRs left there (see `candidatePRs`).
 * @type {(octokit: Octokit, about: { repository: string, prs: number[] }, bot: string) => Promise<boolean>}
 */
async function allClosed(octokit, { repository, prs }, bot) {
	const [owner, name] = repository.split('/');
	const states = await Promise.all(prs.map(async (number) => {
		const { data } = await octokit.rest.pulls.get({
			owner,
			repo: name,
			pull_number: number, // eslint-disable-line camelcase
		});
		return data.state;
	}));
	if (states.some((state) => state !== 'closed')) {
		return false;
	}
	const open = await candidatePRs(
		octokit,
		{
			owner,
			name,
			repository,
		},
		bot,
	);
	return open.length === 0;
}

/**
 * The node IDs of the comments, among `comments` (in the order they were posted), only about a repository (see `aboutEach`) whose PRs that the replies of `authors` link to are all closed or merged, when there's at least one, and where the App's bot (`bot`) has no open PRs left (see `allClosed`).
 * A repository that can't be checked is left as it is, and only warned about, never saying which.
 * @type {(octokit: Octokit, comments: IssueComment[], app: { authors: ReadonlySet<string>, bot: string }) => Promise<Set<string>>}
 */
async function resolvedOn(octokit, comments, { authors, bot }) {
	/** @type {Set<string>} */
	const resolved = new Set();
	/** @type {unknown[]} */
	const unchecked = [];
	// one repository at a time, so as not to burst GitHub's API
	await aboutEach(comments, authors, process.env.GITHUB_SERVER_URL || 'https://github.com').entries().reduce(
		async (previous, [repository, { ids, prs }]) => {
			await previous;
			if (prs.length > 0) {
				try {
					if (await allClosed(octokit, { repository, prs }, bot)) {
						ids.forEach((id) => resolved.add(id));
					}
				} catch (error) {
					unchecked.push(error);
				}
			}
		},
		Promise.resolve(),
	);
	if (unchecked.length > 0) {
		warnFailed(`could not tell whether the App has any PRs still open in ${unchecked.length} of the repositories that comments on the report are only about, so nothing only about those is hidden as resolved`, unchecked[0]);
	}
	return resolved;
}

/**
 * Logs how many comments on the report were `hidden` as each (`done` saying what was done with them), when any were.
 * @type {(hidden: { outdated: number, resolved: number }, done: string) => void}
 */
function logHidden({ outdated, resolved }, done) {
	if (outdated > 0) {
		core.info(`${done} ${outdated} of the App’s replies on the report that later replies make outdated, as outdated`);
	}
	if (resolved > 0) {
		core.info(`${done} ${resolved} ${resolved === 1 ? 'comment' : 'comments'} on the report about a repository whose PRs the App has all closed or merged, as resolved`);
	}
}

/**
 * Sweeps the report issue (`number`, in `owner/repo`), hiding what's stale on it, whatever posted it, and whenever:
 * - as `RESOLVED`, every comment only about a repository (see `aboutEach`) whose PRs the App's replies among those link to are all closed or merged, when there's at least one, and the App's bot (`bot`) has no open PRs left there (see `allClosed`)
 * - as `OUTDATED`, every part of each of the App's replies that a later one makes outdated (see `outdatedReplies`), but those hidden as resolved
 * The App's replies are those of its bot, or of GitHub Actions' bot, which replied before the App did.
 * Those already hidden (or since deleted) are left alone; in a dry run, nothing is hidden, but how many would be is still logged.
 * Returns how many it hid (or would have) as each. Hiding is never worth failing anything over, so a failure only warns, never saying which repository, or which comment; only how many are hidden is logged.
 * @type {(options: Sweeping) => Promise<{ outdated: number, resolved: number }>}
 */
export async function sweepReport({
	octokit,
	owner,
	repo,
	number,
	bot,
	dryRun,
}) {
	const none = { outdated: 0, resolved: 0 };
	const authors = new Set([bot, legacyAuthor].map((a) => a.toLowerCase()));
	const unread = 'could not read the comments on the report, to hide those that are outdated or resolved';
	/** @type {IssueComment[]} */
	let comments;
	try {
		comments = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: number, // eslint-disable-line camelcase
			per_page: 100, // eslint-disable-line camelcase
		});
	} catch (error) {
		warnFailed(unread, error);
		return none;
	}

	const resolved = await resolvedOn(octokit, comments, { authors, bot });
	const outdated = outdatedReplies(comments, authors).filter((id) => !resolved.has(id));

	/** @type {Set<string>} */
	let left;
	try {
		left = resolved.size + outdated.length > 0 ? await hideable(octokit, Array.from(resolved).concat(outdated)) : new Set();
	} catch (error) {
		warnFailed(unread, error);
		return none;
	}
	/** @type {(ids: Iterable<string>, classifier: Classifier) => { id: string, classifier: Classifier }[]} */
	function classified(ids, classifier) {
		return Iterator.from(ids).filter((id) => left.has(id)).map((id) => ({ id, classifier })).toArray();
	}
	const asResolved = classified(resolved, 'RESOLVED');
	const asOutdated = classified(outdated, 'OUTDATED');
	if (dryRun) {
		logHidden({ outdated: asOutdated.length, resolved: asResolved.length }, 'dry run: would have hidden');
		return { outdated: asOutdated.length, resolved: asResolved.length };
	}
	const unresolved = await minimizeEach(octokit, asResolved);
	const unoutdated = await minimizeEach(octokit, asOutdated);
	const failures = unresolved.concat(unoutdated);
	if (failures.length > 0) {
		warnFailed(`could not hide ${failures.length} of the comments on the report that are outdated or resolved`, failures[0]);
	}
	const hidden = {
		outdated: asOutdated.length - unoutdated.length,
		resolved: asResolved.length - unresolved.length,
	};
	logHidden(hidden, 'hid');
	return hidden;
}
