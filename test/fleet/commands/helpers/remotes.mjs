import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, symlinkSync } from 'fs';
import path from 'path';

import {
	git,
	gitIsolation,
	tempDir,
	writeFiles,
} from '../../lib/helpers/git.mjs';

/** @typedef {import('../../lib/helpers/git.mjs').Person} Person */

/**
 * @typedef {{
 *   serverURL: string,
 *   commit: (repository: string, branch: string, files: Record<string, string | null>, options?: { who?: Person, from?: string, links?: Record<string, string> }) => string,
 *   tip: (repository: string, ref: string) => string,
 *   show: (repository: string, ref: string, file: string) => string | null,
 *   log: (repository: string, range: string) => string[],
 * }} Remotes
 */

/**
 * A local "server" with one bare repository per key of `repos`, each cloned as `${serverURL}/${repository}.git`, whose `main` has those files.
 * @type {(t: import('tape').Test, repos: Record<string, Record<string, string>>) => Remotes}
 */
export function makeRemotes(t, repos) {
	const root = tempDir(t, 'fleet-commands-server');
	const serverURL = path.join(root, 'remotes');
	/** @type {(repository: string) => string} */
	const remote = (repository) => path.join(serverURL, `${repository}.git`);
	/** @type {(repository: string) => string} */
	const work = (repository) => path.join(root, 'work', repository);

	for (const [repository, files] of Object.entries(repos)) {
		mkdirSync(remote(repository), { recursive: true });
		git(remote(repository), ['init', '--quiet', '--bare', '--initial-branch=main']);
		mkdirSync(work(repository), { recursive: true });
		git(work(repository), ['init', '--quiet', '--initial-branch=main']);
		git(work(repository), ['remote', 'add', 'origin', remote(repository)]);
		writeFiles(work(repository), { 'README.md': `${repository}\n`, ...files });
		git(work(repository), ['add', '--all']);
		git(work(repository), ['commit', '--quiet', '--message', 'initial']);
		git(work(repository), ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
	}

	return {
		serverURL,
		commit(repository, branch, files, { who, from = branch, links = {} } = {}) {
			const dir = work(repository);
			git(dir, ['fetch', '--quiet', 'origin']);
			git(dir, ['switch', '--quiet', '--force-create', branch, `origin/${from}`]);
			writeFiles(dir, files);
			// each a symbolic link, to its value
			for (const [link, to] of Object.entries(links)) {
				rmSync(path.join(dir, link), { recursive: true, force: true });
				mkdirSync(path.dirname(path.join(dir, link)), { recursive: true });
				symlinkSync(to, path.join(dir, link));
			}
			git(dir, ['add', '--all']);
			git(dir, ['commit', '--quiet', '--message', 'change'], who);
			git(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
			return git(dir, ['rev-parse', 'HEAD']);
		},
		tip(repository, ref) {
			return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
				cwd: remote(repository), encoding: 'utf8', env: { ...process.env, ...gitIsolation },
			}).stdout.trim();
		},
		show(repository, ref, file) {
			const result = spawnSync('git', ['show', `${ref}:${file}`], {
				cwd: remote(repository), encoding: 'utf8', env: { ...process.env, ...gitIsolation },
			});
			return result.status === 0 ? result.stdout : null;
		},
		log(repository, range) {
			return git(remote(repository), ['log', '--format=%an <%ae>|%cn <%ce>|%s', range]).split('\n').filter(Boolean);
		},
	};
}
