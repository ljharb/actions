import fs from 'fs';
import os from 'os';
import path from 'path';

import nock from 'nock';
import test from 'tape';

import installNVM from '../../../node/helpers/installNVM.mjs';

/** @type {(tag: string) => nock.Scope[]} */
function mockNVM(tag) {
	return [
		nock('https://github.com')
			.get('/nvm-sh/nvm/releases/latest')
			.reply(302, '', { location: `https://github.com/nvm-sh/nvm/releases/tag/${tag}` }),
		nock('https://raw.githubusercontent.com')
			.get(`/nvm-sh/nvm/${tag}/nvm.sh`)
			.reply(200, `nvm.sh@${tag}`)
			.get(`/nvm-sh/nvm/${tag}/nvm-exec`)
			.reply(200, `nvm-exec@${tag}`),
	];
}

/** @type {(t: import('tape').Test, name: string, value: string | undefined) => void} */
function setEnv(t, name, value) {
	const original = process.env[name];
	const restore = () => {
		if (typeof original === 'undefined') {
			delete process.env[name];
		} else {
			process.env[name] = original;
		}
	};
	t.teardown(restore);
	if (typeof value === 'undefined') {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

test('installNVM', async (t) => {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installNVM-test-'));
	t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	t.test('installs the latest nvm into NVM_DIR, creating it', async (st) => {
		const nvmDir = path.join(dir, 'deeply', 'nested', 'nvm');
		setEnv(st, 'NVM_DIR', nvmDir);
		const scopes = mockNVM('v0.40.3');

		st.equal(await installNVM(), nvmDir, 'returns NVM_DIR');
		st.ok(scopes.every((scope) => scope.isDone()), 'the latest tag, nvm.sh, and nvm-exec are requested');
		st.equal(fs.readFileSync(path.join(nvmDir, 'nvm.sh'), 'utf8'), 'nvm.sh@v0.40.3', 'nvm.sh is downloaded from the latest tag');
		st.equal(fs.readFileSync(path.join(nvmDir, 'nvm-exec'), 'utf8'), 'nvm-exec@v0.40.3', 'nvm-exec is downloaded from the latest tag');
	});

	t.test('defaults to ~/.nvm when NVM_DIR is unset', async (st) => {
		const home = path.join(dir, 'home');
		setEnv(st, 'NVM_DIR', undefined);
		setEnv(st, 'HOME', home);
		st.equal(os.homedir(), home, 'precondition: HOME controls the home directory');
		mockNVM('v9.9.9');

		const nvmDir = path.join(home, '.nvm');
		st.equal(await installNVM(), nvmDir, 'returns ~/.nvm');
		st.equal(fs.readFileSync(path.join(nvmDir, 'nvm.sh'), 'utf8'), 'nvm.sh@v9.9.9', 'nvm.sh is downloaded');
		st.equal(fs.readFileSync(path.join(nvmDir, 'nvm-exec'), 'utf8'), 'nvm-exec@v9.9.9', 'nvm-exec is downloaded');
	});

	t.test('defaults to ~/.nvm when NVM_DIR is empty, and tolerates an existing dir', async (st) => {
		const home = path.join(dir, 'home2');
		const nvmDir = path.join(home, '.nvm');
		fs.mkdirSync(nvmDir, { recursive: true });
		fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), 'stale');
		setEnv(st, 'NVM_DIR', '');
		setEnv(st, 'HOME', home);
		mockNVM('v1.0.0');

		st.equal(await installNVM(), nvmDir, 'returns ~/.nvm');
		st.equal(fs.readFileSync(path.join(nvmDir, 'nvm.sh'), 'utf8'), 'nvm.sh@v1.0.0', 'a stale nvm.sh is replaced');
	});
});
