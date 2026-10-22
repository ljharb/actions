import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const preloadURL = pathToFileURL(path.join(import.meta.dirname, 'preload.mjs')).href;

export const CACHE_URL = 'http://cache.test/';

/** @type {string[]} */
const roots = [];
process.on('exit', () => {
	roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

/**
 * A recording fake for an executable. Each call appends a block to `<logDir>/<name>.log`:
 * `---`, then `cwd:`, `NVM_DIR:`, `restored:` lines, then one `arg:` line per argument.
 * Behavior is controlled by `FAKE_<NAME>_STDOUT` (printed), `FAKE_<NAME>_STATUS` (exit code),
 * and `FAKE_<NAME>_SIGNAL` (self-kill).
 * @type {(name: string) => string}
 */
const fakeScript = (name) => {
	const upper = name.toUpperCase();
	return `#!/bin/sh
{
	echo '---'
	printf 'cwd:%s\\n' "$(pwd -P)"
	printf 'NVM_DIR:%s\\n' "\${NVM_DIR-<unset>}"
	if [ -f node_modules/marker.txt ]; then printf 'restored:%s\\n' "$(cat node_modules/marker.txt)"; else echo 'restored:'; fi
	for a in "$@"; do printf 'arg:%s\\n' "$a"; done
} >> "$FAKE_LOG_DIR/${name}.log"
if [ -n "\${FAKE_${upper}_STDOUT-}" ]; then printf '%s\\n' "$FAKE_${upper}_STDOUT"; fi
if [ -n "\${FAKE_${upper}_SIGNAL-}" ]; then kill -9 $$; fi
exit "\${FAKE_${upper}_STATUS:-0}"
`;
};

/** @typedef {{ cwd: string, nvmDir: string, restored: string, args: string[] }} FakeCall */

/** @type {(logFile: string) => FakeCall[]} */
function readCalls(logFile) {
	if (!fs.existsSync(logFile)) {
		return [];
	}
	return fs.readFileSync(logFile, 'utf8').split('---\n').slice(1).map((block) => {
		/** @type {FakeCall} */
		const call = {
			cwd: '',
			nvmDir: '',
			restored: '',
			args: [],
		};
		block.split('\n').filter(Boolean).forEach((line) => {
			const idx = line.indexOf(':');
			const key = line.slice(0, idx);
			const value = line.slice(idx + 1);
			if (key === 'arg') {
				call.args.push(value);
			} else if (key === 'cwd') {
				call.cwd = value;
			} else if (key === 'NVM_DIR') {
				call.nvmDir = value;
			} else if (key === 'restored') {
				call.restored = value;
			}
		});
		return call;
	});
}

/** @type {(file: string) => Record<string, string>} */
function parseOutputFile(file) {
	const content = fs.readFileSync(file, 'utf8');
	/** @type {Record<string, string>} */
	const outputs = {};
	const re = /^(?<name>[^\n<]+)<<(?<delimiter>ghadelimiter_[^\n]+)\n(?<value>[\s\S]*?)\n\k<delimiter>$/gm;
	for (const { groups } of content.matchAll(re)) {
		// eslint-disable-next-line no-extra-parens
		const { name, value } = /** @type {Record<string, string>} */ (groups);
		outputs[name] = value;
	}
	return outputs;
}

/** @typedef {{ method: string, url: string, body: string }} RecordedRequest */
/** @typedef {{ requests: RecordedRequest[], unmatched: string[], pending: string[] }} Report */

/**
 * @typedef {{
 *   inputs?: Record<string, string>,
 *   env?: Record<string, string>,
 *   fakes?: string[],
 *   nvmVersion?: string,
 *   cache?: { mode: 'hit' | 'miss', key?: string, cacheId?: number },
 *   setup?: (dirs: { cwd: string }) => void,
 * }} RunOptions
 */

/**
 * @typedef {{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   outputs: Record<string, string>,
 *   report: Report,
 *   calls: (name: string) => FakeCall[],
 *   cwd: string,
 *   nvmDir: string,
 *   envPATH: string,
 * }} RunResult
 */

/** @type {(root: string, marker: string) => string} */
function makeArchive(root, marker) {
	const src = path.join(root, 'archive-src');
	fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
	fs.writeFileSync(path.join(src, 'node_modules', 'marker.txt'), marker);
	const archive = path.join(root, 'cache.tgz');
	execFileSync('tar', ['-czf', archive, '-C', src, 'node_modules']);
	return archive;
}

/** @type {(script: string, options?: RunOptions) => RunResult} */
export function runAction(script, options = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ljharb-actions-node-test-')));
	roots.push(root);
	const binDir = path.join(root, 'bin');
	const logDir = path.join(root, 'logs');
	const cwd = path.join(root, 'cwd');
	const nvmDir = path.join(root, 'nvm');
	const runnerTemp = path.join(root, 'runner-temp');
	[binDir, logDir, cwd, runnerTemp].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

	(options.fakes || []).forEach((name) => {
		const file = path.join(binDir, name);
		fs.writeFileSync(file, fakeScript(name));
		fs.chmodSync(file, 0o755);
	});

	const outputFile = path.join(root, 'github-output');
	fs.writeFileSync(outputFile, '');
	const reportFile = path.join(root, 'report.json');

	/** @type {Record<string, string>} */
	const env = {};
	Object.entries(process.env).forEach(([key, value]) => {
		if (typeof value === 'string' && !(/^(?:INPUT_|ACTIONS_|GITHUB_|RUNNER_|NVM_|FAKE_|TEST_PRELOAD)/).test(key)) {
			env[key] = value;
		}
	});
	const envPATH = `${binDir}${path.delimiter}${process.env.PATH}`;
	Object.assign(env, {
		PATH: envPATH,
		GITHUB_OUTPUT: outputFile,
		RUNNER_TEMP: runnerTemp,
		NVM_DIR: nvmDir,
		FAKE_LOG_DIR: logDir,
	});

	/** @type {import('./preload.mjs').PreloadConfig} */
	const preloadConfig = { report: reportFile };
	if (options.nvmVersion) {
		preloadConfig.nvmVersion = options.nvmVersion;
	}
	if (options.cache) {
		env.ACTIONS_CACHE_URL = CACHE_URL;
		env.ACTIONS_RUNTIME_TOKEN = 'fake-token';
		preloadConfig.cache = {
			url: CACHE_URL,
			...options.cache,
			...options.cache.mode === 'hit' && { archive: makeArchive(root, `from cache ${options.cache.key}`) },
		};
	}
	env.TEST_PRELOAD_CONFIG = JSON.stringify(preloadConfig);

	Object.entries(options.inputs || {}).forEach(([name, value]) => {
		env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
	});
	Object.assign(env, options.env);

	if (options.setup) {
		options.setup({ cwd });
	}

	const result = spawnSync(process.execPath, ['--import', preloadURL, path.join(repoRoot, script)], {
		cwd,
		env,
		encoding: 'utf8',
	});

	/** @type {Report} */
	const report = fs.existsSync(reportFile)
		? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
		: {
			requests: [],
			unmatched: [],
			pending: [],
		};

	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
		outputs: parseOutputFile(outputFile),
		report,
		calls: (name) => readCalls(path.join(logDir, `${name}.log`)),
		cwd,
		nvmDir,
		envPATH,
	};
}
