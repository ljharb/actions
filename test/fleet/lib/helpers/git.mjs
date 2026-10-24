import { spawnSync } from 'child_process';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/** @typedef {{ name: string, email: string }} Person */

// git, isolated from the user's global and system config (eg commit signing, hooks)
/** @type {Record<string, string>} */
export const gitIsolation = {
	GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
};

export const bot = {
	name: 'fleet-bot[bot]',
	email: '42+fleet-bot[bot]@users.noreply.github.com',
};

export const mallory = {
	name: 'Mallory',
	email: 'mallory@example.com',
};

const fixture = { name: 'Fixture', email: 'fixture@example.com' };

/** @type {(t: import('tape').Test, prefix: string) => string} */
export function tempDir(t, prefix) {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `${prefix}-`)));
	t.teardown(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// the code under test runs git with the process's environment, so isolate that too, for the duration of a test
/** @type {(t: import('tape').Test) => void} */
export function isolateProcessGit(t) {
	/** @type {Record<string, string | undefined>} */
	const saved = {};
	for (const [key, value] of Object.entries(gitIsolation)) {
		saved[key] = process.env[key];
		process.env[key] = value;
	}
	t.teardown(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (typeof value === 'undefined') {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});
}

/** @type {(cwd: string, args: string[], who?: Person) => string} */
export function git(cwd, args, who = fixture) {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			...gitIsolation,
			GIT_AUTHOR_NAME: who.name,
			GIT_AUTHOR_EMAIL: who.email,
			GIT_COMMITTER_NAME: who.name,
			GIT_COMMITTER_EMAIL: who.email,
		},
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** @type {(dir: string, files: Record<string, string | null>) => void} */
export function writeFiles(dir, files) {
	for (const [file, content] of Object.entries(files)) {
		if (content === null) {
			rmSync(path.join(dir, file), { force: true });
		} else {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), content);
		}
	}
}

/**
 * @typedef {{
 *   serverURL: string,
 *   remote: string,
 *   commit: (branch: string, files: Record<string, string | null>, options?: { who?: Person, from?: string, message?: string }) => string,
 *   merge: (branch: string, from: string, who?: Person) => string,
 *   tip: (ref: string) => string,
 *   setRef: (ref: string, sha: string) => void,
 *   deleteRef: (ref: string) => void,
 *   show: (ref: string, file: string) => string,
 *   log: (range: string) => string[],
 * }} Server
 */

/**
 * A local "server": `<root>/remotes/<repository>.git`, a bare repository cloned as `${serverURL}/${repository}.git`, whose `main` has `files`.
 * `null` in `files` deletes that file.
 * @type {(t: import('tape').Test, repository: string, files: Record<string, string>) => Server}
 */
export function makeServer(t, repository, files) {
	const root = tempDir(t, 'fleet-pr-server');
	const serverURL = path.join(root, 'remotes');
	const remote = path.join(serverURL, `${repository}.git`);
	mkdirSync(remote, { recursive: true });
	git(remote, ['init', '--quiet', '--bare', '--initial-branch=main']);

	const work = path.join(root, 'work');
	mkdirSync(work);
	git(work, ['init', '--quiet', '--initial-branch=main']);
	git(work, ['remote', 'add', 'origin', remote]);
	writeFiles(work, files);
	git(work, ['add', '--all']);
	git(work, ['commit', '--quiet', '--message', 'initial']);
	git(work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);

	return {
		serverURL,
		remote,
		commit(branch, contents, { who = fixture, from = branch, message = 'change' } = {}) {
			git(work, ['fetch', '--quiet', 'origin']);
			git(work, ['switch', '--quiet', '--force-create', branch, `origin/${from}`]);
			writeFiles(work, contents);
			git(work, ['add', '--all']);
			git(work, ['commit', '--quiet', '--message', message], who);
			git(work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
			return git(work, ['rev-parse', 'HEAD']);
		},
		merge(branch, from, who = fixture) {
			git(work, ['fetch', '--quiet', 'origin']);
			git(work, ['switch', '--quiet', '--force-create', branch, `origin/${branch}`]);
			git(work, ['merge', '--quiet', '--no-ff', '--no-edit', `origin/${from}`], who);
			git(work, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
			return git(work, ['rev-parse', 'HEAD']);
		},
		tip(ref) {
			const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: remote, encoding: 'utf8', env: { ...process.env, ...gitIsolation } });
			return result.stdout.trim();
		},
		setRef(ref, sha) {
			git(remote, ['update-ref', ref, sha]);
		},
		deleteRef(ref) {
			git(remote, ['update-ref', '-d', ref]);
		},
		show(ref, file) {
			return git(remote, ['show', `${ref}:${file}`]);
		},
		log(range) {
			return git(remote, ['log', '--format=%an <%ae>|%cn <%ce>|%s|%P', range]).split('\n').filter(Boolean);
		},
	};
}
