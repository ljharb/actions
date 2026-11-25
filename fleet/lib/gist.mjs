/** @import { getOctokit } from '@actions/github' */
/** @typedef {ReturnType<typeof getOctokit>} Octokit */
/** @typedef {{ name: string, html_url: string }} GistFile */
/** @typedef {{ html_url: string, pages: number, files: GistFile[] }} Gist */
/** @typedef {{ history?: { version?: string }[] | null }} Reply */

/*
 * GitHub shows (and its API gives) only a gist's first 900 KiB, however many files that's in: what's past that, in a file, or in the files after it, is cut, or missing
 * but it shows each revision of a gist as that revision has it: so a report is on as many pages as it takes, each a revision holding as many of its files, in order, as fit in this many bytes
 */
export const maxGistBytes = 900 * 1024;

// what's kept, on each page, for the link to the next (see `nextPage`)
const linkBytes = 1024;

/** @type {(url: string) => string} */
function nextPage(url) {
	return `\n\n---\n\n**[This report continues on its next page](${url})**, an earlier revision of this gist, since GitHub shows only a gist’s first 900 KiB.\n`;
}

// a gist only ever holds a report's files (see `fileNames`), so one that holds anything else isn't that report's
/** @type {(name: string, base: string) => boolean} */
function isReportFile(name, base) {
	return name.startsWith(base) && (/^(?:-\d+)?\.md$/).test(name.slice(base.length));
}

/**
 * The names of a report's `count` files, each named for `base` (eg, `workflow-drift`).
 * @type {(count: number, base: string) => string[]}
 */
export function fileNames(count, base) {
	return count === 1
		? [`${base}.md`]
		// zero-padded, so they sort in order
		: Array.from({ length: count }, (_, i) => `${base}-${String(i + 1).padStart(3, '0')}.md`);
}

/**
 * A report's secret gist, among the token's user's gists: its description is exactly `description`, and it holds only the report's files (see `fileNames`).
 * A public gist, or one with any other description or files, is never written to.
 * @type {(octokit: Octokit, description: string, base: string) => Promise<{ id: string, files: string[] } | undefined>}
 */
async function find(octokit, description, base) {
	const gists = await octokit.paginate(octokit.rest.gists.list, { per_page: 100 }); // eslint-disable-line camelcase
	return gists
		.filter((g) => !g.public && g.description === description)
		.map((g) => ({ id: g.id, files: Object.keys(g.files ?? {}) }))
		.find(({ files }) => files.length > 0 && files.every((name) => isReportFile(name, base)));
}

/**
 * `files`, in order, on as few pages as they fit on (see `maxGistBytes`), with room on each for the link to the next: each file on the one it starts on, so a file that alone is bigger than that is on a page of its own.
 * @type {(files: [string, string][]) => [string, string][][]}
 */
function paged(files) {
	/** @type {{ bytes: number, files: [string, string][] }[]} */
	const pages = [];
	files.forEach((file) => {
		const bytes = Buffer.byteLength(file[1]);
		const last = pages.at(-1);
		if (last && last.bytes + bytes <= maxGistBytes - linkBytes) {
			last.bytes += bytes;
			last.files.push(file);
		} else {
			pages.push({ bytes, files: [file] });
		}
	});
	return pages.map((p) => p.files);
}

/**
 * The revision of a gist that writing it made, from what GitHub replied.
 * @type {(reply: Reply) => string}
 */
function revisionOf({ history }) {
	const version = history?.[0]?.version;
	if (!version) {
		throw new Error('GitHub didn’t say which revision of the gist it made, so the page before it can’t link to it');
	}
	return version;
}

/**
 * Writes `parts` to the secret gist described by `description` (see `find`), one file each (named for `base`: see `fileNames`), creating it if there's none, each in a request of its own, so that no one request is bigger than one file.
 * When they don't all fit on one page (see `paged`), each page is a revision of its own, holding only its files, written last page first, so that each can link to the revision after it (see `nextPage`); the first, written last, is what the gist then holds.
 * Files a previous run left that a page doesn't have are removed in its first request.
 * @type {(octokit: Octokit, gist: { description: string, base: string }, parts: string[]) => Promise<Gist>}
 */
export async function upsertGist(octokit, { description, base }, parts) {
	const names = fileNames(parts.length, base);
	const existing = await find(octokit, description, base);
	const pages = paged(names.map((name, i) => [name, parts[i]]));

	/** @type {(id: string | undefined, files: Record<string, { content: string } | null>) => Promise<{ id: string, url: string, reply: Reply }>} */
	const send = async (id, files) => {
		// a file set to `null` is deleted
		const written = /** @type {Record<string, { content: string }>} */ (/** @type {unknown} */ (files));
		const { data } = id
			? await octokit.rest.gists.update({
				gist_id: id, // eslint-disable-line camelcase
				description,
				files: written,
			})
			: await octokit.rest.gists.create({
				description,
				public: false,
				files: written,
				request: { retries: 0 }, // never retried, so never made twice (see `retry` in `app.mjs`)
			});
		return {
			id: String(data.id),
			url: String(data.html_url),
			reply: data,
		};
	};

	/** @type {string[]} */
	const noURLs = [];
	// one page at a time, last first, and each one's files one at a time, in order
	const { gist: htmlURL, urls } = await pages.reduceRight(
		async (previous, files, page) => {
			const {
				id,
				present,
				next,
				urls: after,
			} = await previous;
			const pageNames = files.map(([name]) => name);
			const contents = files.map(([name, content], i) => [name, next && i === files.length - 1 ? content + nextPage(next) : content]);
			/** @type {[string, { content: string } | null][]} */
			const stale = present.filter((name) => !pageNames.includes(name)).map((name) => [name, null]);
			const first = await send(id, Object.fromEntries(stale.concat([[contents[0][0], { content: contents[0][1] }]])));
			const last = await contents.slice(1).reduce(
				async (previousWrite, [name, content]) => {
					await previousWrite;
					return send(first.id, { [name]: { content } });
				},
				Promise.resolve(first),
			);
			// the first page is what the gist holds; every other is a revision of it
			const url = page === 0 ? first.url : `${first.url}/${revisionOf(last.reply)}`;
			return {
				id: first.id,
				gist: first.url,
				present: pageNames,
				next: url,
				urls: [url].concat(after),
			};
		},
		Promise.resolve({
			id: existing?.id,
			gist: '',
			present: existing?.files ?? [],
			next: '',
			urls: noURLs,
		}),
	);
	return {
		html_url: htmlURL, // eslint-disable-line camelcase
		pages: pages.length,
		// where GitHub shows each
		files: pages.flatMap((files, page) => files.map(([name]) => ({
			name,
			html_url: `${urls[page]}#file-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, // eslint-disable-line camelcase
		}))),
	};
}
