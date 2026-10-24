import { spawnSync } from 'child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

/** @typedef {import('./preload.mjs').ChildScenario} ChildScenario */
/** @typedef {import('../../lib/helpers/github.mjs').Recorded} Recorded */

export const root = path.join(import.meta.dirname, '..', '..', '..', '..');

const preload = pathToFileURL(path.join(import.meta.dirname, 'preload.mjs')).href;

/** @type {(relative: string) => string} */
export function moduleURL(relative) {
	return pathToFileURL(path.join(root, relative)).href;
}

// the child's environment: nothing from the GitHub Actions environment leaks in, except what c8 needs to collect coverage
/** @type {() => Record<string, string>} */
function baseEnv() {
	/** @type {Record<string, string>} */
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === 'string' && !(/^(?:GITHUB_|INPUT_|RUNNER_|ACTIONS_)/).test(k)) {
			env[k] = v;
		}
	}
	return env;
}

/**
 * @typedef {{
 *   status: number | null,
 *   stdout: string,
 *   stderr: string,
 *   requests: Recorded[],
 *   output: unknown,
 *   summary: string,
 * }} ChildResult
 */

// `preload` is the URL of the module that sets up the scenario in the child: by default, this directory's
/** @type {(args: string[], options: { scenario: ChildScenario, env?: Record<string, string>, preload?: string }) => ChildResult} */
export function runChild(args, { scenario, env = {}, preload: preloadURL = preload }) {
	const dir = mkdtempSync(path.join(tmpdir(), 'fleet-drift-test-'));
	const log = path.join(dir, 'requests.jsonl');
	const out = path.join(dir, 'out.json');
	const scenarioFile = path.join(dir, 'scenario.json');
	writeFileSync(scenarioFile, JSON.stringify({ ...scenario, log }));
	writeFileSync(log, '');
	const summary = path.join(dir, 'summary.md');
	writeFileSync(summary, '');

	const result = spawnSync(process.execPath, ['--import', preloadURL, ...args], {
		cwd: root,
		env: {
			...baseEnv(),
			FLEET_TEST_SCENARIO: scenarioFile,
			FLEET_TEST_OUT: out,
			GITHUB_STEP_SUMMARY: summary,
			// keeps production's temp files (eg, drift diffs) inside `dir`, so they are removed with it
			RUNNER_TEMP: dir,
			...env,
		},
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	});
	try {
		if (result.error) {
			throw result.error;
		}

		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			requests: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
			output: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined,
			summary: readFileSync(summary, 'utf8'),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// evaluates `source` as an ES module in a child process, which writes its result to `process.env.FLEET_TEST_OUT` as JSON
/** @type {(source: string, scenario: ChildScenario, env?: Record<string, string>) => ChildResult} */
export function evalModule(source, scenario, env) {
	return runChild(['--input-type=module', '-e', source], { scenario, env });
}
