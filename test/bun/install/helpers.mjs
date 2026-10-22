import { spawnSync } from 'child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const actionDir = path.join(repoRoot, 'bun', 'install');

const childSetupURL = new URL('child-setup.mjs', import.meta.url).href;

/** @param {import('tape').Test} t */
export function makeTmp(t) {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bun-install-test-')));
	t.teardown(() => rmSync(dir, { force: true, recursive: true }));
	return dir;
}

/** @param {string} file @param {string} contents */
export function writeExecutable(file, contents) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, contents);
	chmodSync(file, 0o755);
}

/** @param {string} file */
export function readJSONLines(file) {
	if (!existsSync(file)) {
		return [];
	}
	return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** an env without any ambient GitHub Actions inputs or files, so the parent environment cannot leak in */
export function baseEnv() {
	/** @type {Record<string, string | undefined>} */
	const env = { ...process.env };
	Object.keys(env).forEach((key) => {
		if ((/^(?:INPUT_|GITHUB_|RUNNER_|ACTIONS_|FAKE_)/).test(key) || key === 'NVM_DIR') {
			delete env[key];
		}
	});
	env.GIT_CEILING_DIRECTORIES = os.tmpdir();
	return env;
}

/**
 * @param {string} script
 * @param {{ cwd: string, env: Record<string, string | undefined>, fakeCache?: boolean }} options
 */
export function runNode(script, { cwd, env, fakeCache = false }) {
	const preload = `data:text/javascript,import{setup}from${JSON.stringify(childSetupURL)};await setup({fakeCache:${fakeCache}});`;
	const { status, signal, stdout, stderr } = spawnSync(
		process.execPath,
		['--import', preload, script],
		{ cwd, env, encoding: 'utf8' },
	);
	return { status, signal, stdout, stderr };
}
