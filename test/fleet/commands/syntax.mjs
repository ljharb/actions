import test from 'tape';

import {
	legend,
	parseCommand,
	reportBranches,
	reports,
} from '../../../fleet/commands/syntax.mjs';
import {
	botBranches,
	fixBranch,
	readmeBranch,
	relockBranch,
} from '../../../fleet/lib/branches.mjs';

/** @import { Filters } from '../../../fleet/commands/syntax.mjs' */
/** @import { Category } from '../../../fleet/drift/fix.mjs' */
/** @import { Category as ReadmeCategory } from '../../../fleet/readme/readme.mjs' */

/** @type {(filters: Partial<Record<'repositories' | 'accounts' | 'files', string[]> & { categories?: Category[] }>) => Filters} */
function filters({
	repositories = [], accounts = [], files = [], categories = [],
}) {
	return {
		repositories: new Set(repositories),
		accounts: new Set(accounts),
		files: new Set(files),
		categories: new Set(categories),
	};
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
	['`/fix <filters>`', '`/dry-run fix <filters>`', '`fleet/workflows`', '`missing`', '`drifted`', '`unexpected`', 'write access'].forEach((example) => {
		t.ok(text.includes(example), `mentions ${example}`);
	});
	const examples = text.match(/^- `\/(?:dry-run )?fix [^`<]+`/gm) ?? [];
	t.equal(examples.length, 3, 'with three examples');
	examples.forEach((example) => {
		t.equal(parseCommand(example.slice(3, -1)).type, 'fix', `${example.slice(2)} is a valid command`);
	});
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
	['`/merge <filters>`', '`/dry-run merge <filters>`', '`actions-lock/relock`', 'queued'].forEach((example) => {
		t.ok(text.includes(example), `mentions ${example}`);
	});
	const examples = text.match(/^- `\/(?:dry-run )?merge [^`<]+`/gm) ?? [];
	t.equal(examples.length, 1, 'with an example');
	examples.forEach((example) => {
		t.equal(parseCommand(example.slice(3, -1)).type, 'merge', `${example.slice(2)} is a valid command`);
	});
	t.end();
});

/** @type {(filters: Partial<Record<'repositories' | 'accounts' | 'files', string[]> & { categories?: (Category | ReadmeCategory)[] }>) => Filters} */
function anyFilters({
	repositories = [], accounts = [], files = [], categories = [],
}) {
	return {
		repositories: new Set(repositories),
		accounts: new Set(accounts),
		files: new Set(files),
		categories: new Set(categories),
	};
}

test('parseCommand: on the README drift report', (t) => {
	t.deepEqual(parseCommand('/fix LJHarb/QS, Heading BADGES\tlinks es-shims', 'readme'), {
		type: 'fix',
		dryRun: false,
		line: '/fix LJHarb/QS, Heading BADGES\tlinks es-shims',
		filters: anyFilters({
			repositories: ['ljharb/qs'],
			accounts: ['es-shims'],
			categories: ['heading', 'badges', 'links'],
		}),
	}, 'its kinds of discrepancy, case-insensitively, alongside repositories and accounts');
	t.deepEqual(parseCommand('/dry-run fix ljharb links', 'readme'), {
		type: 'fix', dryRun: true, line: '/dry-run fix ljharb links', filters: anyFilters({ accounts: ['ljharb'], categories: ['links'] }),
	}, '`/dry-run fix`, with a kind of discrepancy');
	t.deepEqual(parseCommand('/fix ljharb rebase.yml Node.YAML', 'readme'), {
		type: 'error', message: '`rebase.yml`, `Node.YAML` are filters only on the other fleet report’s issue, not this one.',
	}, 'workflow file names are the other report’s filters there, as typed, since this report has no files');
	t.deepEqual(parseCommand('/fix ljharb rebase.yml', 'readme'), {
		type: 'error', message: '`rebase.yml` is a filter only on the other fleet report’s issue, not this one.',
	}, 'as is one');
	// a word that's a kind of discrepancy only on the workflow drift report is a valid login, but never means an account on either report
	t.deepEqual(parseCommand('/fix Missing drifted unexpected', 'readme'), {
		type: 'error', message: '`Missing`, `drifted`, `unexpected` are filters only on the other fleet report’s issue, not this one.',
	}, 'the workflow drift report’s kinds of discrepancy are the other report’s filters there, not accounts');
	t.deepEqual(parseCommand('/fix ljharb missing', 'readme'), {
		type: 'error', message: '`missing` is a filter only on the other fleet report’s issue, not this one.',
	}, 'even alongside a filter of its own');
	t.deepEqual(parseCommand('/fix Heading links'), {
		type: 'error', message: '`Heading`, `links` are filters only on the other fleet report’s issue, not this one.',
	}, 'and, on the workflow drift report, the README drift report’s are too');
	t.deepEqual(parseCommand('/fix ljharb badges', 'workflows'), {
		type: 'error', message: '`badges` is a filter only on the other fleet report’s issue, not this one.',
	}, 'as is one');
	t.deepEqual(parseCommand('/fix ljharb/qs links/x heading-1'), {
		type: 'fix', dryRun: false, line: '/fix ljharb/qs links/x heading-1', filters: anyFilters({ repositories: ['ljharb/qs', 'links/x'], accounts: ['heading-1'] }),
	}, 'an account named like one is still matched by its repositories, and a login that only starts like one is an account');
	t.deepEqual(parseCommand('/fix ljharb @someone links'), {
		type: 'error', message: 'Unknown filter: `@someone`.',
	}, 'an unknown filter is reported first');
	t.end();
});

test('parseCommand: `/merge` on the README drift report', (t) => {
	t.deepEqual(parseCommand('/merge ljharb/qs es-shims', 'readme'), {
		type: 'merge', dryRun: false, line: '/merge ljharb/qs es-shims', filters: anyFilters({ repositories: ['ljharb/qs'], accounts: ['es-shims'] }),
	}, 'with a repository and an account');
	t.deepEqual(parseCommand('/merge ljharb badges Links', 'readme'), {
		type: 'error',
		message: '`/merge` takes only repository (`owner/name`) and account (`owner`) filters, not `badges`, `links`.',
	}, 'a kind of discrepancy is rejected');
	t.deepEqual(parseCommand('/dry-run merge heading', 'readme'), {
		type: 'error',
		message: '`/dry-run merge` takes only repository (`owner/name`) and account (`owner`) filters, not `heading`.',
	}, 'by a dry run too');
	t.deepEqual(parseCommand('/merge ljharb rebase.yml', 'readme'), {
		type: 'error', message: '`rebase.yml` is a filter only on the other fleet report’s issue, not this one.',
	}, 'a workflow file name is the other report’s filter, not one `/merge` rejects');
	t.deepEqual(parseCommand('/dry-run merge ljharb missing', 'readme'), {
		type: 'error', message: '`missing` is a filter only on the other fleet report’s issue, not this one.',
	}, 'as is the workflow drift report’s kind of discrepancy');
	t.deepEqual(parseCommand('/merge ljharb heading', 'workflows'), {
		type: 'error', message: '`heading` is a filter only on the other fleet report’s issue, not this one.',
	}, 'and, on the workflow drift report, the README drift report’s');
	t.end();
});

test('parseCommand: on either report', (t) => {
	t.deepEqual(parseCommand('/fix ljharb/qs Rebase.YML missing heading BADGES', 'any'), {
		type: 'fix',
		dryRun: false,
		line: '/fix ljharb/qs Rebase.YML missing heading BADGES',
		filters: anyFilters({
			repositories: ['ljharb/qs'],
			files: ['rebase.yml'],
			categories: ['missing', 'heading', 'badges'],
		}),
	}, 'both reports’ kinds of discrepancy, and file names');
	t.deepEqual(parseCommand('/fix owner/name links', 'any'), {
		type: 'fix', dryRun: false, line: '/fix owner/name links', filters: anyFilters({ repositories: ['owner/name'], categories: ['links'] }),
	}, 'a README drift report command');
	t.deepEqual(parseCommand('/merge ljharb links', 'any'), {
		type: 'error',
		message: '`/merge` takes only repository (`owner/name`) and account (`owner`) filters, not `links`.',
	}, '`/merge` still rejects either report’s kinds of discrepancy');
	t.deepEqual(parseCommand('/fix ljharb @someone', 'any'), { type: 'error', message: 'Unknown filter: `@someone`.' }, 'anything else is still an unknown filter');
	t.deepEqual(parseCommand('/fix missing drifted unexpected heading badges links', 'any'), {
		type: 'fix',
		dryRun: false,
		line: '/fix missing drifted unexpected heading badges links',
		filters: anyFilters({ categories: ['missing', 'drifted', 'unexpected', 'heading', 'badges', 'links'] }),
	}, 'every kind of discrepancy of either report, none of which is ever the other report’s');
	t.end();
});

test('legend: the README drift report', (t) => {
	const text = legend({ report: 'readme' });
	t.ok(text.startsWith('### Commands\n'), 'a section of its own');
	t.notOk(legend({ heading: false, report: 'readme' }).startsWith('### Commands'), 'or not, without a heading');
	['README drift report', '`/fix <filters>`', '`/dry-run fix <filters>`', '`/merge <filters>`', '`/dry-run merge <filters>`', '`fleet/readme`', '`heading`', '`badges`', '`links`', 'write access'].forEach((example) => {
		t.ok(text.includes(example), `mentions ${example}`);
	});
	['`fleet/workflows`', '`actions-lock/relock`', '`missing`', '`drifted`', '`unexpected`', '.yml'].forEach((other) => {
		t.notOk(text.includes(other), `doesn’t mention the workflow drift report’s ${other}`);
	});
	const fixes = text.match(/^- `\/(?:dry-run )?fix [^`<]+`/gm) ?? [];
	t.equal(fixes.length, 3, 'with three `/fix` examples');
	fixes.forEach((example) => {
		t.equal(parseCommand(example.slice(3, -1), 'readme').type, 'fix', `${example.slice(2)} is a valid command there`);
	});
	const merges = text.match(/^- `\/(?:dry-run )?merge [^`<]+`/gm) ?? [];
	t.equal(merges.length, 1, 'and a `/merge` example');
	merges.forEach((example) => {
		t.equal(parseCommand(example.slice(3, -1), 'readme').type, 'merge', `${example.slice(2)} is a valid command there`);
	});

	t.equal(legend(), legend({ report: 'workflows' }), 'by default, the workflow drift report’s');
	t.ok(legend().includes('workflow drift report issue'), 'which is about that issue');
	t.notOk(legend().includes('`fleet/readme`'), 'and not the README drift report’s branch');
	t.end();
});

test('reportBranches', (t) => {
	t.deepEqual(reportBranches(fixBranch), [fixBranch, relockBranch], 'a `fleet/workflows` PR’s report’s branches: the workflow drift report’s');
	t.deepEqual(reportBranches(relockBranch), [fixBranch, relockBranch], 'as are an `actions-lock/relock` PR’s');
	t.deepEqual(reportBranches(readmeBranch), [readmeBranch], 'a `fleet/readme` PR’s are only the README drift report’s');
	t.equal(reportBranches(fixBranch), reports.workflows.mergeBranches, 'each being that report’s `/merge` branches');
	t.equal(reportBranches(readmeBranch), reports.readme.mergeBranches, 'whichever report it is');
	t.equal(reportBranches('some-other-branch'), botBranches, 'any other branch’s are every one of the App’s branches');
	t.equal(reportBranches(fixBranch.toUpperCase()), botBranches, 'matching a branch exactly, as git does');
	t.end();
});
