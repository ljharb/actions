import { spawnSync } from 'child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/** @typedef {{ status: number | null, stdout: string, stderr: string, outputs: Record<string, string> }} RunResult */

/** @type {(contents: string) => Record<string, string>} */
export function parseOutputFile(contents) {
	/** @type {Record<string, string>} */
	const outputs = {};
	const lines = contents.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const match = (/^(?<name>[^<]+)<<(?<delimiter>.+)$/).exec(lines[i]);
		if (match) {
			const [, name, delimiter] = match;
			/** @type {string[]} */
			const value = [];
			i += 1;
			while (i < lines.length && lines[i] !== delimiter) {
				value.push(lines[i]);
				i += 1;
			}
			outputs[name] = value.join('\n');
		}
	}
	return outputs;
}

/**
 * @param {string} script absolute path of the entry point to run
 * @param {{
 *   inputs?: Record<string, string>,
 *   env?: Record<string, string>,
 *   imports?: string[],
 *   eventPayload?: unknown,
 *   prependPath?: string,
 * }} [options]
 * @returns {RunResult}
 */
export function runAction(script, {
	inputs = {},
	env = {},
	imports = [],
	eventPayload,
	prependPath,
} = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), 'ljharb-actions-test-'));
	try {
		const outputFile = path.join(dir, 'output.txt');
		writeFileSync(outputFile, '');

		/** @type {Record<string, string | undefined>} */
		const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INPUT_') && !k.startsWith('GITHUB_') && k !== 'RUNNER_DEBUG'));
		childEnv.GITHUB_OUTPUT = outputFile;
		if (typeof eventPayload !== 'undefined') {
			const eventFile = path.join(dir, 'event.json');
			writeFileSync(eventFile, JSON.stringify(eventPayload));
			childEnv.GITHUB_EVENT_PATH = eventFile;
		}
		if (prependPath) {
			childEnv.PATH = `${prependPath}${path.delimiter}${childEnv.PATH}`;
		}
		Object.entries(inputs).forEach(([name, value]) => {
			childEnv[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
		});
		Object.assign(childEnv, env);

		const result = spawnSync(
			process.execPath,
			[
				...imports.flatMap((x) => ['--import', x]),
				script,
			],
			{
				cwd: dir,
				encoding: 'utf8',
				env: childEnv,
			},
		);

		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			outputs: parseOutputFile(readFileSync(outputFile, 'utf8')),
		};
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}
