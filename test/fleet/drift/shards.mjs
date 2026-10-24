import test from 'tape';

import { isShard, shardDecade } from '../../../fleet/drift/shards.mjs';
import { evalModule, moduleURL } from './helpers/child.mjs';
import { versionFixture } from './helpers/versions.mjs';

test('isShard', (t) => {
	for (const name of [
		'node.yml',
		'node-aught.yml',
		'node-tens.yml',
		'node-twenties.yml',
		'node-nineties.yml',
		'node-100s.yml',
		'node-250s.yml',
	]) {
		t.ok(isShard(name), `${name} is a node test shard`);
	}
	for (const name of [
		'node.yaml',
		'node-pretest.yml',
		'node-tests.yml',
		'node-5s.yml',
		'node-twenty.yml',
		'xnode.yml',
		'node.yml.bak',
		'rebase.yml',
	]) {
		t.notOk(isShard(name), `${name} is not a node test shard`);
	}

	t.end();
});

test('shardDecade', (t) => {
	t.equal(shardDecade('node.yml'), null, '`node.yml` covers every decade');
	t.equal(shardDecade('rebase.yml'), null, 'not a shard');
	t.equal(shardDecade('node-aught.yml'), 0, 'aught');
	t.equal(shardDecade('node-tens.yml'), 1, 'tens');
	t.equal(shardDecade('node-nineties.yml'), 9, 'nineties');
	t.equal(shardDecade('node-100s.yml'), 10, 'past nineties');
	t.equal(shardDecade('node-250s.yml'), 25, 'further past nineties');

	t.end();
});

// `allVersions` is cached for the life of a process, so the version index is mocked in a child process of its own
test('expectedShards', (t) => {
	const cases = /** @type {const} */ ([ // eslint-disable-line no-extra-parens
		['no matching versions', '>= 1000', 'minors'],
		['fits in one file', '^20', 'minors'],
		['a majors matrix needs far fewer jobs', '>= 4', 'majors'],
		['split until the rest fits', '>= 4 < 30', 'minors'],
		['split to the last decade, which still doesn’t fit, named past `nineties`', '>= 4', 'minors'],
		['the last decade alone doesn’t fit', '>= 100', 'minors'],
		['a `||` range, including io.js', '^1 || ^2 || ^3 || >= 4 < 30', 'minors'],
		['a `||` range that skips a decade', '>= 4 < 10 || >= 20 < 30', 'minors'],
	]);
	const { status, stderr, output, requests } = evalModule(`
		import { writeFileSync } from 'fs';
		import { expectedShards } from ${JSON.stringify(moduleURL('fleet/drift/shards.mjs'))};

		const cases = ${JSON.stringify(cases)};
		const results = await Promise.all(cases.map(([, range, type]) => expectedShards(range, type)));
		const a = expectedShards('^20', 'minors');
		const b = expectedShards('^20', 'minors');
		const c = expectedShards('^20', 'majors');
		writeFileSync(process.env.FLEET_TEST_OUT, JSON.stringify({ results, cached: a === b, keyedByType: a !== c }));
	`, { versions: versionFixture() });

	t.equal(status, 0, 'the child succeeds');
	t.equal(stderr, '', 'with nothing on stderr');
	t.deepEqual(requests, [], 'no GitHub API requests');

	const { results, cached, keyedByType } = /** @type {{ results: string[][], cached: boolean, keyedByType: boolean }} */ (output); // eslint-disable-line no-extra-parens
	const expected = [
		[],
		['node.yml'],
		['node.yml'],
		['node-aught.yml', 'node-tens.yml', 'node-twenties.yml'],
		['node-aught.yml', 'node-tens.yml', 'node-twenties.yml', 'node-thirties.yml', 'node-100s.yml'],
		['node-100s.yml'],
		['node-aught.yml', 'node-tens.yml', 'node-twenties.yml'],
		['node-aught.yml', 'node-twenties.yml'],
	];
	cases.forEach(([label, range, type], i) => {
		t.deepEqual(results[i], expected[i], `${label}: \`${range}\` (${type})`);
	});
	t.equal(cached, true, 'the same range and type returns the same cached promise');
	t.equal(keyedByType, true, 'the cache is keyed by type too');

	t.end();
});

// `getPreset` reads `0.x` as the name of a preset that rejects `type`, which once failed the whole run, publishing a repository's `engines.node`
test('expectedShards: `0.x` is a range, not a preset', (t) => {
	const { status, stderr, output } = evalModule(`
		import { writeFileSync } from 'fs';
		import { expectedShards } from ${JSON.stringify(moduleURL('fleet/drift/shards.mjs'))};

		writeFileSync(process.env.FLEET_TEST_OUT, JSON.stringify(await Promise.all([expectedShards('0.x', 'minors'), expectedShards('0.x', 'majors')])));
	`, { versions: versionFixture() });

	t.equal(status, 0, 'the child succeeds');
	t.equal(stderr, '', 'with nothing on stderr');
	t.deepEqual(output, [['node.yml'], ['node.yml']], 'one `node.yml`, of either type');
	t.end();
});
