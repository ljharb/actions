import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

import nock from 'nock';
import test from 'tape';

import getLatestNVM from '../../../node/helpers/getLatestNVM.mjs';

const modulePath = path.join(import.meta.dirname, '..', '..', '..', 'node', 'helpers', 'getLatestNVM.mjs');

test('getLatestNVM', async (t) => {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	t.test('resolves to the tag of the latest release redirect', async (st) => {
		const scope = nock('https://github.com')
			.get('/nvm-sh/nvm/releases/latest')
			.reply(302, '', { location: 'https://github.com/nvm-sh/nvm/releases/tag/v0.40.3' });

		st.equal(await getLatestNVM(), 'v0.40.3', 'returns the last path segment');
		st.ok(scope.isDone(), 'the latest release is requested');
	});

	t.test('handles a relative location', async (st) => {
		nock('https://github.com')
			.get('/nvm-sh/nvm/releases/latest')
			.reply(302, '', { location: '/nvm-sh/nvm/releases/tag/v1.2.3' });

		st.equal(await getLatestNVM(), 'v1.2.3', 'returns the last path segment');
	});

	t.test('a non-redirect response throws asynchronously', (st) => {
		// the throw happens inside the response callback, so it is an uncaught exception; run it in a child process
		const source = `
import nock from 'nock';
nock.disableNetConnect();
nock('https://github.com').get('/nvm-sh/nvm/releases/latest').reply(200, 'ok');
const { default: getLatestNVM } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
process.on('uncaughtException', (e) => {
	console.log(JSON.stringify({ statusCode: e.statusCode, isError: e instanceof Error }));
	process.exit(5);
});
getLatestNVM().then(() => console.log('resolved'));
`;
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
			cwd: import.meta.dirname,
			encoding: 'utf8',
		});

		st.equal(result.status, 5, 'an uncaught exception occurs');
		st.deepEqual(JSON.parse(result.stdout), { statusCode: 200, isError: false }, 'the response itself is thrown');
		st.end();
	});
});
