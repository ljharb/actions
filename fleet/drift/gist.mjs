/** @typedef {ReturnType<typeof import('@actions/github').getOctokit>} Octokit */
/** @typedef {{ name: string, raw_url: string }} GistFile */
/** @typedef {{ html_url: string, files: GistFile[] }} Gist */

// a gist only ever holds the report's files, so one that holds anything else isn't the report's
const reportFile = /^workflow-drift(?:-\d+)?\.md$/;

/** @type {(count: number) => string[]} */
export function fileNames(count) {
	return count === 1
		? ['workflow-drift.md']
		// zero-padded, so they sort in order
		: Array.from({ length: count }, (_, i) => `workflow-drift-${String(i + 1).padStart(3, '0')}.md`);
}

/**
 * The report's secret gist, among the token's user's gists: its description is exactly `description`, and it holds only the report's files.
 * A public gist, or one with any other description or files, is never written to.
 * @type {(octokit: Octokit, description: string) => Promise<{ id: string, files: string[] } | undefined>}
 */
async function find(octokit, description) {
	const gists = await octokit.paginate(octokit.rest.gists.list, { per_page: 100 }); // eslint-disable-line camelcase
	return gists
		.filter((g) => !g.public && g.description === description)
		.map((g) => ({ id: g.id, files: Object.keys(g.files ?? {}) }))
		.find(({ files }) => files.length > 0 && files.every((name) => reportFile.test(name)));
}

/**
 * Writes `parts` to the secret gist described by `description` (see `find`), one file each, creating it if there's none, and removing any files a previous run left that are no longer needed.
 * Each file is written in a request of its own, so no one request is bigger than one file.
 * @type {(octokit: Octokit, description: string, parts: string[]) => Promise<Gist>}
 */
export async function upsertGist(octokit, description, parts) {
	const names = fileNames(parts.length);
	const existing = await find(octokit, description);
	const first = { [names[0]]: { content: parts[0] } };
	const { data } = existing
		? await octokit.rest.gists.update({
			gist_id: existing.id, description, files: first, // eslint-disable-line camelcase
		})
		: await octokit.rest.gists.create({
			description, public: false, files: first,
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
			gist_id: id, files: { [names[i]]: { content: parts[i] } }, // eslint-disable-line camelcase
		});
		files.push(fileOf(names[i], written));
	}
	const stale = (existing?.files ?? []).filter((name) => !names.includes(name));
	if (stale.length > 0) {
		await octokit.rest.gists.update({
			gist_id: id, // eslint-disable-line camelcase
			// a file set to `null` is deleted
			files: /** @type {Record<string, { content: string }>} */ (/** @type {unknown} */ (Object.fromEntries(stale.map((name) => [name, null])))), // eslint-disable-line no-extra-parens
		});
	}
	return { html_url: htmlURL, files }; // eslint-disable-line camelcase
}
