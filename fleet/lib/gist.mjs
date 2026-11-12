/** @import { getOctokit } from '@actions/github' */
/** @typedef {ReturnType<typeof getOctokit>} Octokit */
/** @typedef {{ name: string, raw_url: string }} GistFile */
/** @typedef {{ html_url: string, files: GistFile[] }} Gist */

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
 * Writes `parts` to the secret gist described by `description` (see `find`), one file each (named for `base`: see `fileNames`), creating it if there's none, and removing any files a previous run left that are no longer needed.
 * Each file is written in a request of its own, so no one request is bigger than one file.
 * @type {(octokit: Octokit, gist: { description: string, base: string }, parts: string[]) => Promise<Gist>}
 */
export async function upsertGist(octokit, { description, base }, parts) {
	const names = fileNames(parts.length, base);
	const existing = await find(octokit, description, base);
	const first = { [names[0]]: { content: parts[0] } };
	const { data } = existing
		? await octokit.rest.gists.update({
			gist_id: existing.id, // eslint-disable-line camelcase
			description,
			files: first,
		})
		: await octokit.rest.gists.create({
			description,
			public: false,
			files: first,
			request: { retries: 0 }, // never retried, so never made twice (see `retry` in `app.mjs`)
		});
	const id = String(data.id);
	const htmlURL = String(data.html_url);
	/** @type {(name: string, written: typeof data) => GistFile} */
	// eslint-disable-next-line camelcase
	const fileOf = (name, written) => ({ name, raw_url: written.files?.[name]?.raw_url ?? `${htmlURL}/raw/${name}` });

	/** @type {GistFile[]} */
	const files = [fileOf(names[0], data)];
	// one at a time, in order
	for (let i = 1; i < names.length; i += 1) {
		const { data: written } = await octokit.rest.gists.update({ // eslint-disable-line no-await-in-loop
			gist_id: id, // eslint-disable-line camelcase
			files: { [names[i]]: { content: parts[i] } },
		});
		files.push(fileOf(names[i], written));
	}
	const stale = (existing?.files ?? []).filter((name) => !names.includes(name));
	if (stale.length > 0) {
		await octokit.rest.gists.update({
			gist_id: id, // eslint-disable-line camelcase
			// a file set to `null` is deleted
			files: /** @type {Record<string, { content: string }>} */ (/** @type {unknown} */ (Object.fromEntries(stale.map((name) => [name, null])))),
		});
	}
	return { html_url: htmlURL, files }; // eslint-disable-line camelcase
}
