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

// passed via git's env-based config, so the token never appears in argv or in a `.git/config`
/** @type {(token: string, serverURL?: string) => Record<string, string>} */
export function gitAuthEnv(token, serverURL = 'https://github.com') {
	return {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `http.${serverURL.replace(/\/+$/, '')}/.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
		GIT_TERMINAL_PROMPT: '0',
	};
}
