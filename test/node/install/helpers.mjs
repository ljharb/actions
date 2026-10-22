import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
export const nockSetup = path.join(import.meta.dirname, 'nock-setup.mjs');

/** @type {(t: import('tape').Test, prefix: string) => string} */
export function tmpDir(t, prefix) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `node-install-test-${prefix}-`)));
	t.teardown(() => fs.rmSync(dir, { force: true, recursive: true }));
	return dir;
}

/** @type {(dir: string, name: string, source: string) => string} */
export function fakeBin(dir, name, source) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

// Records its argv, cwd, and selected env vars to `$FAKE_BASH_LOG` (one JSON object per line), then exits per `$FAKE_BASH_EXIT`.
const fakeBashSource = `
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_BASH_LOG, JSON.stringify({
	argv: process.argv.slice(2),
	cwd: process.cwd(),
	NVM_DIR: process.env.NVM_DIR,
}) + '\\n');
const exit = process.env.FAKE_BASH_EXIT || '0';
if (exit === 'signal') {
	process.kill(process.pid, 'SIGKILL');
} else {
	process.exit(Number(exit));
}
`;

// Writes a fake archive for \`-cf <file>\` (relative to cwd), and logs every invocation to \`$FAKE_TAR_LOG\`.
const fakeTarSource = `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_TAR_LOG, JSON.stringify(args) + '\\n');
const idx = args.indexOf('-cf');
if (idx >= 0) {
	fs.writeFileSync(args[idx + 1], 'fake tarball contents');
}
`;

/** @type {(dir: string) => string} */
export function makeFakeBins(dir) {
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	fakeBin(bin, 'bash', fakeBashSource);
	fakeBin(bin, 'tar', fakeTarSource);
	// a `zstd` that prints nothing forces gzip compression, so that results don't depend on the host
	fakeBin(bin, 'zstd', 'process.exit(1);');
	return bin;
}

/**
 * @template T
 * @param {string} file
 * @returns {T[]}
 */
export function readJSONLines(file) {
	if (!fs.existsSync(file)) {
		return [];
	}
	return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * @typedef {{
 *   pending: string[],
 *   requests: { method: string, url: string, body: string }[],
 *   unmatched: string[],
 * }} NockReport
 */

/**
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   report: NockReport,
 *   bashCalls: { argv: string[], cwd: string, NVM_DIR: string }[],
 *   tarCalls: string[][],
 *   githubEnv: string,
 *   githubOutput: string,
 *   dir: string,
 *   cwd: string,
 * }} RunResult
 */

/**
 * @type {(t: import('tape').Test, script: string, options?: {
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 *   dir?: string,
 * }) => RunResult}
 */
export function runScript(t, script, options = {}) {
	const dir = options.dir || tmpDir(t, 'run');
	const bin = fs.existsSync(path.join(dir, 'bin')) ? path.join(dir, 'bin') : makeFakeBins(dir);
	const cwd = options.cwd || dir;
	const reportFile = path.join(dir, 'nock-report.json');
	const bashLog = path.join(dir, 'bash.log');
	const tarLog = path.join(dir, 'tar.log');
	const githubEnv = path.join(dir, 'github-env');
	const githubOutput = path.join(dir, 'github-output');
	fs.writeFileSync(githubEnv, '');
	fs.writeFileSync(githubOutput, '');

	/** @type {Record<string, string>} */
	const env = {
		PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
		HOME: dir,
		GITHUB_ENV: githubEnv,
		GITHUB_OUTPUT: githubOutput,
		NOCK_SETUP_REPORT: reportFile,
		FAKE_BASH_LOG: bashLog,
		FAKE_TAR_LOG: tarLog,
		RUNNER_TEMP: dir,
	};
	if (process.env.NODE_V8_COVERAGE) {
		env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
	}
	Object.entries(options.env || {}).forEach(([key, value]) => {
		if (typeof value === 'undefined') {
			delete env[key];
		} else {
			env[key] = value;
		}
	});

	const result = spawnSync(process.execPath, ['--import', nockSetup, script], {
		cwd,
		env,
		encoding: 'utf8',
	});

	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
		report: fs.existsSync(reportFile)
			? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
			: { pending: [], requests: [], unmatched: [] },
		bashCalls: readJSONLines(bashLog),
		tarCalls: readJSONLines(tarLog),
		githubEnv: fs.readFileSync(githubEnv, 'utf8'),
		githubOutput: fs.readFileSync(githubOutput, 'utf8'),
		dir,
		cwd,
	};
}

/** @type {(file: string, name: string) => string | undefined} */
export function readCommandFile(file, name) {
	// @actions/core writes `name<<delimiter\nvalue\ndelimiter` entries
	const match = file.match(new RegExp(`^${name}<<(.+)\\n([\\s\\S]*?)\\n\\1$`, 'm'));
	return match ? match[2] : undefined;
}
