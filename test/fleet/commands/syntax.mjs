import test from 'tape';

import { legend, parseCommand } from '../../../fleet/commands/syntax.mjs';

/** @type {(filters: Partial<Record<'repositories' | 'accounts' | 'files' | 'categories', string[]>>) => import('../../../fleet/commands/syntax.mjs').Filters} */
function filters({
	repositories = [], accounts = [], files = [], categories = [],
}) {
	return /** @type {import('../../../fleet/commands/syntax.mjs').Filters} */ ({ // eslint-disable-line no-extra-parens
		repositories: new Set(repositories),
		accounts: new Set(accounts),
		files: new Set(files),
		categories: new Set(categories),
	});
}

test('parseCommand: not a command', (t) => {
	t.deepEqual(parseCommand(''), { type: 'none' }, 'an empty comment');
	t.deepEqual(parseCommand('thanks!\n/fix ljharb'), { type: 'none' }, 'only the first line counts');
	t.deepEqual(parseCommand('  please /fix ljharb'), { type: 'none' }, 'a command must start the line');
	t.end();
});

test('parseCommand: commands', (t) => {
	t.deepEqual(parseCommand('/fix ljharb'), {
		type: 'fix', dryRun: false, line: '/fix ljharb', filters: filters({ accounts: ['ljharb'] }),
	}, '`/fix`, with an account');
	t.deepEqual(parseCommand('  /dry-run fix ljharb  \r\nmore text'), {
		type: 'fix', dryRun: true, line: '/dry-run fix ljharb', filters: filters({ accounts: ['ljharb'] }),
	}, '`/dry-run fix`, on the trimmed first line');
	t.deepEqual(parseCommand('/FIX LJHarb/QS, Rebase.YML node-twenties.yaml\tMissing drifted UNEXPECTED es-shims a-b-c'), {
		type: 'fix',
		dryRun: false,
		line: '/FIX LJHarb/QS, Rebase.YML node-twenties.yaml\tMissing drifted UNEXPECTED es-shims a-b-c',
		filters: filters({
			repositories: ['ljharb/qs'],
			accounts: ['es-shims', 'a-b-c'],
			files: ['rebase.yml', 'node-twenties.yaml'],
			categories: ['missing', 'drifted', 'unexpected'],
		}),
	}, 'case-insensitive, separated by whitespace or commas, with every kind of filter, each lowercased');
	t.deepEqual(parseCommand('/Dry-Run FIX ljharb ljharb'), {
		type: 'fix', dryRun: true, line: '/Dry-Run FIX ljharb ljharb', filters: filters({ accounts: ['ljharb'] }),
	}, 'a case-insensitive dry run; a repeated filter is one filter');
	t.end();
});

test('parseCommand: errors', (t) => {
	t.deepEqual(parseCommand('/frobnicate the `thing`'), { type: 'error', message: 'Unknown command: `` /frobnicate the `thing` ``.' }, 'an unknown command, quoted inertly');
	t.deepEqual(parseCommand('/dry-run'), { type: 'error', message: 'Unknown command: `/dry-run`.' }, 'a dry run of nothing');
	t.deepEqual(parseCommand('/dry-run ljharb'), { type: 'error', message: 'Unknown command: `/dry-run ljharb`.' }, 'a dry run of something other than `fix`');
	t.deepEqual(parseCommand('/fix'), { type: 'error', message: '`/fix` needs at least one filter: every repository at once is too broad.' }, '`/fix` without filters');
	t.deepEqual(parseCommand('/dry-run fix ,'), { type: 'error', message: '`/dry-run fix` needs at least one filter: every repository at once is too broad.' }, '`/dry-run fix` without filters');
	t.deepEqual(parseCommand('/fix ljharb -leading trailing- a--b @someone <b>x</b> a/b/c x.json'), {
		type: 'error',
		message: 'Unknown filters: `-leading`, `trailing-`, `a--b`, `@someone`, `<b>x</b>`, `a/b/c`, `x.json`.',
	}, 'every unknown filter, quoted inertly, as typed');
	t.deepEqual(parseCommand(`/fix ${'a'.repeat(40)}`), { type: 'error', message: `Unknown filter: \`${'a'.repeat(40)}\`.` }, 'one unknown filter: an account name too long for a login');
	t.deepEqual(parseCommand(`/fix ${'a'.repeat(39)}`).type, 'fix', 'the longest login is an account');
	t.deepEqual(parseCommand(`/frob${'x'.repeat(300)}`), { type: 'error', message: `Unknown command: \`/frob${'x'.repeat(300)}\`.` }, 'a long command is quoted whole');
	t.deepEqual(parseCommand(`/fix ${'a'.repeat(250)}.json`), { type: 'error', message: `Unknown filter: \`${'a'.repeat(250)}.json\`.` }, 'as is a long filter');
	t.deepEqual(parseCommand(`/fix ${Array.from({ length: 12 }, (_, i) => `@u${i}`).join(' ')}`), {
		type: 'error',
		message: `Unknown filters: ${Array.from({ length: 12 }, (_, i) => `\`@u${i}\``).join(', ')}.`,
	}, 'and every one of many unknown filters is listed');
	t.end();
});

test('legend', (t) => {
	const text = legend();
	t.ok(text.startsWith('### Commands\n'), 'a section of its own');
	for (const example of ['`/fix <filters>`', '`/dry-run fix <filters>`', '`fleet/workflows`', '`missing`', '`drifted`', '`unexpected`', 'write access']) {
		t.ok(text.includes(example), `mentions ${example}`);
	}
	const examples = text.match(/^- `\/(?:dry-run )?fix [^`<]+`/gm) ?? [];
	t.equal(examples.length, 3, 'with three examples');
	for (const example of examples) {
		t.equal(parseCommand(example.slice(3, -1)).type, 'fix', `${example.slice(2)} is a valid command`);
	}
	t.end();
});

test('parseCommand: `/merge`', (t) => {
	t.deepEqual(parseCommand('/merge ljharb/qs es-shims'), {
		type: 'merge', dryRun: false, line: '/merge ljharb/qs es-shims', filters: filters({ repositories: ['ljharb/qs'], accounts: ['es-shims'] }),
	}, '`/merge`, with a repository and an account');
	t.deepEqual(parseCommand('/Dry-Run MERGE LJHarb'), {
		type: 'merge', dryRun: true, line: '/Dry-Run MERGE LJHarb', filters: filters({ accounts: ['ljharb'] }),
	}, '`/dry-run merge`, case-insensitively');
	t.deepEqual(parseCommand('/merge'), { type: 'error', message: '`/merge` needs at least one filter: every repository at once is too broad.' }, '`/merge` without filters');
	t.deepEqual(parseCommand('/dry-run merge'), { type: 'error', message: '`/dry-run merge` needs at least one filter: every repository at once is too broad.' }, '`/dry-run merge` without filters');
	t.deepEqual(parseCommand('/merge ljharb Rebase.yml missing'), {
		type: 'error',
		message: '`/merge` takes only repository (`owner/name`) and account (`owner`) filters, not `rebase.yml`, `missing`.',
	}, 'a workflow file or a kind of discrepancy is rejected');
	t.deepEqual(parseCommand('/dry-run merge drifted'), {
		type: 'error',
		message: '`/dry-run merge` takes only repository (`owner/name`) and account (`owner`) filters, not `drifted`.',
	}, 'by a dry run too');
	t.deepEqual(parseCommand('/merge ljharb @someone rebase.yml'), { type: 'error', message: 'Unknown filter: `@someone`.' }, 'an unknown filter is rejected as for `/fix`');
	t.deepEqual(parseCommand('/merged ljharb'), { type: 'error', message: 'Unknown command: `/merged ljharb`.' }, 'anything else is still an unknown command');
	t.deepEqual(parseCommand('/dry-run'), { type: 'error', message: 'Unknown command: `/dry-run`.' }, 'as is a dry run of nothing');
	t.end();
});

test('legend: `/merge`', (t) => {
	const text = legend();
	for (const example of ['`/merge <filters>`', '`/dry-run merge <filters>`', '`actions-lock/relock`', 'queued']) {
		t.ok(text.includes(example), `mentions ${example}`);
	}
	const examples = text.match(/^- `\/(?:dry-run )?merge [^`<]+`/gm) ?? [];
	t.equal(examples.length, 1, 'with an example');
	for (const example of examples) {
		t.equal(parseCommand(example.slice(3, -1)).type, 'merge', `${example.slice(2)} is a valid command`);
	}
	t.end();
});
