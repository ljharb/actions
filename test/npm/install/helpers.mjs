// Shared helpers for the `npm/install` and `vlt/install` action tests. No top-level side effects.

import { spawnSync } from 'child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';

export const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

const preload = path.join(import.meta.dirname, 'nock-preload.mjs');

const fakeBash = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG_DIR/bash.args"
printf '%s\\n' "$#" > "$FAKE_LOG_DIR/bash.argc"
printf '%s' "$NVM_DIR" > "$FAKE_LOG_DIR/bash.nvm-dir"
pwd > "$FAKE_LOG_DIR/bash.cwd"
echo bash >> "$FAKE_LOG_DIR/order"
if [ -n "$FAKE_BASH_SIGNAL" ]; then
	kill -9 $$
fi
exit "\${FAKE_BASH_STATUS:-0}"
`;

const fakeGit = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIR/git.log"
pwd > "$FAKE_LOG_DIR/git.cwd"
echo git >> "$FAKE_LOG_DIR/order"
exit "\${FAKE_GIT_STATUS:-0}"
`;

const fakeTar = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG_DIR/tar.log"
prev=
for a in "$@"; do
	if [ "$prev" = '-cf' ]; then
		printf '%s' 'new archive contents' > "$a"
	fi
	if [ "$prev" = '-xf' ]; then
		cp "$a" "$FAKE_LOG_DIR/extracted"
	fi
	prev="$a"
done
echo "tar:$1" >> "$FAKE_LOG_DIR/order"
exit 0
`;

// no output, so `@actions/cache` picks gzip regardless of whether the host has zstd
const fakeZstd = `#!/bin/sh
exit 1
`;

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} contents
 */
function writeExecutable(dir, name, contents) {
	const file = path.join(dir, name);
	writeFileSync(file, contents);
	chmodSync(file, 0o755);
}

/**
 * @typedef {{
 *   root: string,
 *   bin: string,
 *   logs: string,
 *   cwd: string,
 *   tmp: string,
 *   outputFile: string,
 *   reportFile: string,
 *   cleanup: () => void,
 * }} Sandbox
 */

/** @param {{ fakeBash?: boolean }} [options] */
export function makeSandbox(options = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'install-action-test-'));
	const bin = path.join(root, 'bin');
	const logs = path.join(root, 'logs');
	const cwd = path.join(root, 'workspace');
	const tmp = path.join(root, 'tmp');
	mkdirSync(bin);
	mkdirSync(logs);
	mkdirSync(cwd);
	mkdirSync(tmp);

	if (options.fakeBash !== false) {
		writeExecutable(bin, 'bash', fakeBash);
	}
	writeExecutable(bin, 'git', fakeGit);
	writeExecutable(bin, 'tar', fakeTar);
	writeExecutable(bin, 'zstd', fakeZstd);

	const outputFile = path.join(root, 'github-output');
	writeFileSync(outputFile, '');

	return {
		root,
		bin,
		logs,
		cwd,
		tmp,
		outputFile,
		reportFile: path.join(root, 'nock-report.json'),
		cleanup() {
			rmSync(root, { force: true, recursive: true });
		},
	};
}

/**
 * @param {Sandbox} sandbox
 * @param {string} name
 */
export function readLog(sandbox, name) {
	const file = path.join(sandbox.logs, name);
	return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** @param {Sandbox} sandbox */
export function readBashArgs(sandbox) {
	const argc = readLog(sandbox, 'bash.argc');
	const args = readLog(sandbox, 'bash.args');
	if (argc === null || args === null) {
		return null;
	}
	const list = args.split('\n').slice(0, Number(argc));
	return list;
}

/**
 * @param {Sandbox} sandbox
 * @returns {{ pending: string[], requests: { method: string, path: string, body: string, authorization: string | null }[] }}
 */
export function readNockReport(sandbox) {
	return JSON.parse(readFileSync(sandbox.reportFile, 'utf8'));
}

/**
 * @param {Sandbox} sandbox
 * @returns {Record<string, string>}
 */
export function readOutputs(sandbox) {
	const contents = readFileSync(sandbox.outputFile, 'utf8');
	/** @type {Record<string, string>} */
	const outputs = {};
	const re = /^(?<name>[^\n<]+)<<(?<delimiter>ghadelimiter_[^\n]+)\n(?<value>[\s\S]*?)\n\k<delimiter>$/gm;
	for (const { groups } of contents.matchAll(re)) {
		if (groups) {
			outputs[groups.name] = groups.value;
		}
	}
	return outputs;
}

/**
 * @param {string} script path relative to the repo root
 * @param {Sandbox} sandbox
 * @param {Record<string, string | undefined>} env
 */
export function runAction(script, sandbox, env = {}) {
	const PATH = `${sandbox.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
	/** @type {Record<string, string>} */
	const childEnv = {
		HOME: sandbox.root,
		PATH,
		RUNNER_TEMP: sandbox.tmp,
		TMPDIR: sandbox.tmp,
		GITHUB_OUTPUT: sandbox.outputFile,
		GITHUB_WORKSPACE: sandbox.cwd,
		FAKE_LOG_DIR: sandbox.logs,
		TEST_NOCK_REPORT: sandbox.reportFile,
	};
	if (process.env.NODE_V8_COVERAGE) {
		childEnv.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
	}
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === 'string') {
			childEnv[key] = value;
		}
	}

	const result = spawnSync(
		process.execPath,
		[
			'--import',
			preload,
			path.join(repoRoot, script),
		],
		{
			cwd: sandbox.cwd,
			encoding: 'utf8',
			env: childEnv,
		},
	);

	return {
		PATH,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}
