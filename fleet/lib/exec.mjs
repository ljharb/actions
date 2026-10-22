import { spawnSync } from 'child_process';

/** @typedef {{ cwd?: string, env?: Record<string, string | undefined>, input?: string, allowFailure?: boolean }} ExecOptions */
/** @typedef {{ status: number | null, stdout: string, stderr: string }} ExecResult */

/** @type {(command: string, args: string[], options?: ExecOptions) => ExecResult} */
export function exec(command, args, {
	cwd, env, input, allowFailure = false,
} = {}) {
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		input,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0 && !allowFailure) {
		throw new Error(`\`${command} ${args.join(' ')}\` failed (exit ${result.status}):\n${result.stderr || result.stdout}`.trim());
	}
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}
