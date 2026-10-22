import fs from 'fs';
import os from 'os';
import path from 'path';

import nock from 'nock';
import test from 'tape';

import downloadFile from '../../../node/helpers/downloadFile.mjs';

test('downloadFile', async (t) => {
	nock.disableNetConnect();
	t.teardown(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloadFile-test-'));
	t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	t.test('writes the response body to the destination', async (st) => {
		const scope = nock('https://files.example.test')
			.get('/some/file.sh')
			.reply(200, 'file contents\nline 2\n');
		const dest = path.join(dir, 'file.sh');

		const result = await downloadFile('https://files.example.test/some/file.sh', dest);

		st.equal(result, undefined, 'resolves with undefined');
		st.ok(scope.isDone(), 'the file is requested');
		st.equal(fs.readFileSync(dest, 'utf8'), 'file contents\nline 2\n', 'the body is written to dest');
	});

	t.test('overwrites an existing destination', async (st) => {
		const dest = path.join(dir, 'existing.txt');
		fs.writeFileSync(dest, 'old contents that are longer than the new ones');
		nock('https://files.example.test')
			.get('/new.txt')
			.reply(200, 'new');

		await downloadFile('https://files.example.test/new.txt', dest);

		st.equal(fs.readFileSync(dest, 'utf8'), 'new', 'dest is replaced');
	});

	t.test('writes an empty body', async (st) => {
		const dest = path.join(dir, 'empty.txt');
		nock('https://files.example.test')
			.get('/empty')
			.reply(200, '');

		await downloadFile('https://files.example.test/empty', dest);

		st.equal(fs.readFileSync(dest, 'utf8'), '', 'dest is empty');
	});

	t.test('does not check the status code', async (st) => {
		const dest = path.join(dir, 'missing.txt');
		nock('https://files.example.test')
			.get('/missing')
			.reply(404, 'Not Found');

		await downloadFile('https://files.example.test/missing', dest);

		st.equal(fs.readFileSync(dest, 'utf8'), 'Not Found', 'the error body is written to dest');
	});
});
