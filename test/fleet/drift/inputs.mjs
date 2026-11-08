import test from 'tape';

import {
	addInputs,
	calledWorkflows,
	declaredInputs,
	inputsOf,
	keepInputs,
	notPassed,
	removedInputs,
	stripKnownInputs,
	unwritten,
} from '../../../fleet/drift/inputs.mjs';
import { template } from './helpers/states.mjs';

/** @import { Inputs } from '../../../fleet/drift/inputs.mjs' */

const pretestCall = `name: 'Tests: pretest/posttest'

on: [pull_request, push]

permissions:
  contents: read

jobs:
  tests:
    uses: ljharb/actions/.github/workflows/pretest.yml@main
`;

// tape's real `node-pretest.yml`, before the App's PR removed its input
const tapePretest = `${pretestCall}    with:
      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+
`;
const tapeLine = '      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+';
// the same, with its comment on a line of its own, as indented as the `with:`
const tapeCommented = `${pretestCall}    with:
    # bin/tape requires node 8+, but the rest of tape supports 0.4+
      skip-engines: true
`;
const tapeCommentedLines = ['    # bin/tape requires node 8+, but the rest of tape supports 0.4+', '      skip-engines: true'];

/** @type {(job: string, file: string, inputs: [string, string[]][]) => [string, { file: string, inputs: Map<string, string[]> }]} */
function passed(job, file, inputs) {
	return [job, { file, inputs: new Map(inputs) }];
}

test('declaredInputs', (t) => {
	t.deepEqual([...declaredInputs('pretest.yml')], ['skip-engines', 'skip-pack'], 'the inputs `pretest.yml` declares');
	t.deepEqual([...declaredInputs('node.yml')], [
		'range',
		'notable',
		'type',
		'build-command',
		'build-output-dir',
		'command',
		'continue-on-error',
		'skip-ls-check',
		'after_install',
		'timeout-minutes',
		'coverage',
		'subpackage',
		'os',
	], 'every input `node.yml` declares, and none of their own keys');
	t.deepEqual([...declaredInputs('rebase.yml')], [], 'a workflow that declares only secrets has none');
	t.deepEqual([...declaredInputs('no-such-workflow.yml')], [], 'nor does one that doesn’t exist');
	t.equal(declaredInputs('pretest.yml'), declaredInputs('pretest.yml'), 'each is read once');
	t.end();
});

test('calledWorkflows', (t) => {
	t.deepEqual([...calledWorkflows(template('node.yml'))], ['node.yml'], 'the reusable workflows of this repo’s a file calls');
	t.deepEqual([...calledWorkflows(`${tapePretest}  b:\n    uses: ljharb/actions/.github/workflows/node.yml@main\n  c:\n    uses: ljharb/actions/.github/workflows/node.yml@v1\n`)], ['pretest.yml', 'node.yml'], 'each once');
	t.deepEqual([...calledWorkflows('jobs: [')], [], 'none, in a file that isn’t YAML');
	t.end();
});

test('stripKnownInputs', (t) => {
	const pretest = template('node-pretest.yml');
	t.equal(stripKnownInputs(tapePretest, pretest), pretestCall, 'a declared input the template doesn’t pass goes, with its trailing comment, and its emptied `with:`');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      skip-pack: true\n      not-an-input: 1\n`, pretest), `${pretestCall}    with:\n      not-an-input: 1\n`, 'an input the workflow doesn’t declare stays, and so does its `with:`');
	t.equal(stripKnownInputs(`${pretestCall}    with: { skip-engines: true }\n`, pretest), `${pretestCall}    with: { skip-engines: true }\n`, 'a flow-style `with:` is left as it is');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n`, pretest), `${pretestCall}    with:\n`, 'an empty `with:` stays: nothing was removed from it');

	const node = template('node.yml');
	const withExtras = node.replace('      command: {{command}}\n', '      command: {{command}}\n      skip-ls-check: true\n      after_install: |\n        npm run build\n        echo done\n');
	t.equal(stripKnownInputs(withExtras, node), node, 'inputs the template doesn’t pass go, with the lines that continue their values; the ones it does pass stay');

	t.equal(stripKnownInputs('jobs:\n  t:\n    uses: ljharb/actions/.github/workflows/node.yml@main\n    with:\n      os: macos-latest\n', pretest), 'jobs:\n  t:\n    uses: ljharb/actions/.github/workflows/node.yml@main\n', 'a call of a workflow the template doesn’t call passes nothing the template does');

	const other = 'jobs:\n  tests:\n    uses: someone/else/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n';
	t.equal(stripKnownInputs(other, pretest), other, 'only this repo’s reusable workflows count');
	t.equal(stripKnownInputs(tapePretest, 'jobs: ['), pretestCall, 'a template that isn’t YAML passes nothing');
	t.equal(stripKnownInputs(tapeCommented, pretest), pretestCall, 'as does one with its comment on a line of its own, above it');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      skip-engines: true\n      # trailing, about it\n    # about what follows\n    secrets: inherit\n`, pretest), `${pretestCall}    # about what follows\n    secrets: inherit\n`, 'or below it, when it’s indented within the `with:`; one that isn’t is about what follows');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      # the input that stays\n      not-an-input: 1 # and its own\n`, pretest), `${pretestCall}    with:\n      not-an-input: 1 # and its own\n`, 'any other comment on a line of its own in a `with:` is a repository’s own too');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      # skip-engines: true\n`, pretest), pretestCall, 'a `with:` with only comments in it goes, with them');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      # commented out\n    # about what follows\n    secrets: inherit\n`, pretest), `${pretestCall}    # about what follows\n    secrets: inherit\n`, 'but not a comment after it that isn’t indented within it');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      not-an-input: |\n        # part of its value\n        more\n      # a comment\n`, pretest), `${pretestCall}    with:\n      not-an-input: |\n        # part of its value\n        more\n`, 'a `#` line in a block scalar’s value is part of it, not a comment; one as indented as the inputs is a comment');
	t.equal(stripKnownInputs(`${pretestCall}    with:\n      skip-pack: >- # folded\n        # part of its value\n`, pretest), pretestCall, 'and goes with the input it’s part of');
	const quoted = 'jobs:\n  tests:\n    with:\n      skip-engines: true\n\n    uses: "ljharb/actions/.github/workflows/pretest.yml@v1" # pinned\n  other:\n    runs-on: ubuntu-latest\n';
	t.equal(stripKnownInputs(quoted, pretest), 'jobs:\n  tests:\n\n    uses: "ljharb/actions/.github/workflows/pretest.yml@v1" # pinned\n  other:\n    runs-on: ubuntu-latest\n', 'a quoted `uses:` at any ref, with its `with:` before it, ending where the next job starts');
	t.end();
});

test('stripKnownInputs: only what the parser says is a declared input goes; anything else, or anything it doesn’t understand, still drifts', (t) => {
	const pretest = template('node-pretest.yml');
	/** @type {(lines: string) => string} */
	const withLines = (lines) => `${pretestCall}    with:\n${lines}`;
	/** @type {(lines: string, message: string) => void} */
	const unchanged = (lines, message) => {
		t.equal(stripKnownInputs(withLines(lines), pretest), withLines(lines), `${message}: left as it is, so it drifts`);
	};
	/** @type {(lines: string, left: string, message: string) => void} */
	const drifts = (lines, left, message) => {
		t.equal(stripKnownInputs(withLines(lines), pretest), withLines(left), `${message}: it stays, so it drifts`);
	};
	/** @type {(lines: string, message: string) => void} */
	const strips = (lines, message) => {
		t.equal(stripKnownInputs(withLines(lines), pretest), pretestCall, message);
	};

	// quoted keys
	drifts('      skip-engines: true\n      "not-declared": oops\n', '      "not-declared": oops\n', 'a double-quoted key is an input of its own');
	drifts('      skip-engines: true\n      \'evil-input\': 1\n', '      \'evil-input\': 1\n', 'as is a single-quoted one');
	drifts('      skip-pack: |\n        # part of its value\n      "not-declared": 1\n', '      "not-declared": 1\n', 'and one after a block scalar with a `#` line');
	drifts('      "skip-engines ": true\n', '      "skip-engines ": true\n', 'a quoted key is exactly what’s in its quotes');
	strips('      "skip-engines": true\n      \'skip-pack\': true # its own\n', 'a quoted key it declares is still an input it declares');
	strips('      "skip\\x2Dengines": true\n      "skip\\u002dpack": true\n', 'with its escapes');
	unchanged('      skip-engines: true\n      "skip\\qpack": 1\n', 'a double-quoted key with an escape YAML doesn’t have');

	// flow mappings
	unchanged('      { not-declared: 1 }\n', 'a flow mapping on the line after the `with:`');
	t.equal(stripKnownInputs(`${pretestCall}    with: { skip-engines: true, not-declared: 1 }\n`, pretest), `${pretestCall}    with: { skip-engines: true, not-declared: 1 }\n`, 'a flow-style `with:`, with an input it doesn’t declare, is left as it is');
	unchanged('      skip-engines: [never,\n        ends\n', 'a flow collection that never ends');
	drifts('      skip-engines: [a:"b]\n      not-declared: 1\n      skip-pack: true # "]\n', '      skip-engines: [a:"b]\n      not-declared: 1\n', 'a quote in a flow collection’s plain scalar doesn’t start a quoted one: the key after it is a key (and a collection value stays too)');
	drifts('      skip-engines: {a:\'b}\n      not-declared: 1\n      skip-pack: true # \'}\n', '      skip-engines: {a:\'b}\n      not-declared: 1\n', 'nor does a single quote');
	drifts('      skip-pack: [one, "two,\n        three", {four: \'five\'},\n        its] # done\n      skip-engines: !!bool true\n', '      skip-pack: [one, "two,\n        three", {four: \'five\'},\n        its] # done\n', 'every line of a flow collection is its value, which stays, since a declared input’s value that isn’t a scalar might be anything');
	drifts('      skip-engines: [true]\n', '      skip-engines: [true]\n', 'a sequence, even of one scalar');
	strips('      skip-engines: !!bool true\n      skip-pack: !!str a\n', 'a tagged scalar is a scalar');

	// anchors, aliases, and merge keys
	unchanged('      skip-engines: true\n      <<: *defaults\n', 'a merge key with an alias of an anchor that isn’t there');
	drifts('      skip-engines: true\n      <<: { not-declared: 1 }\n', '      <<: { not-declared: 1 }\n', 'a merge key is just a key, which isn’t declared');
	t.equal(stripKnownInputs(`${pretestCall}    with: &defaults\n      skip-engines: true\n`, pretest), `${pretestCall}    with: &defaults\n      skip-engines: true\n`, 'a `with:` with an anchor is left as it is');
	const aliased = `${pretestCall}    env: &defaults\n      skip-engines: true\n    with: *defaults\n`;
	t.equal(stripKnownInputs(aliased, pretest), aliased, 'as is one that’s an alias');
	unchanged('      skip-engines: true\n      &anchor not-declared: 1\n', 'a key with an anchor');
	unchanged('      &anchor skip-engines: true\n', 'even one it declares');
	unchanged('      skip-engines: &alias skip-pack\n      *alias : 1\n', 'an alias as a key');
	strips('      skip-engines: &a true\n      skip-pack: *a\n', 'an anchor or an alias in a value is part of it');
	unchanged('      skip-engines: &a true\n      not-declared: *a\n', 'an alias, left behind, of an anchor in an input that goes');

	// tags
	unchanged('      skip-engines: true\n      !!str not-declared: 1\n', 'a key with a tag');
	unchanged('      !!str skip-engines: true\n', 'even one it declares');
	unchanged('      skip-engines: !custom true\n', 'a tag the parser can’t resolve');

	// whitespace, and line breaks
	unchanged('      skip-engines: |\n        x\n      \tnot-declared: 1\n', 'a line indented with a tab');
	drifts('      skip-engines: |\n        x\n      \u00a0not-declared: 1\n', '      \u00a0not-declared: 1\n', 'a no-break space is part of the key it’s before');
	drifts('      skip-engines: |\n        x\n      \ufeffnot-declared: 1\n', '      \ufeffnot-declared: 1\n', 'as is a byte order mark');
	unchanged('      skip-engines: true\n      \u00a0\n', 'a line of nothing but a no-break space');
	unchanged('      skip-engines: |\n        x\u2028      not-declared: 1\n', 'a line separator, which YAML 1.1 breaks a line at');
	unchanged('      skip-engines: true\n      # \x85      not-declared: 1\n', 'or a next line, in a comment');
	unchanged('      # \u2029      not-declared: 1\n      skip-engines: true\n', 'or a paragraph separator');
	unchanged('      skip-engines: true\n      skip-engines: false\n', 'a key passed twice');
	unchanged('        skip-engines: true\n      not-declared: 1\n', 'a line indented less than the inputs');
	unchanged('      - not-declared\n      skip-engines: true\n', 'a line before the first input that isn’t one');

	// block scalars
	strips('      skip-engines: |\n        x\n      # not-declared: 1\n', 'a `#` line as indented as the keys, after a block scalar, is a comment');
	strips('      skip-pack: >- # folded\n        # part of its value\n\n        lines\n      skip-engines: |2\n          x\n        y\n', 'one in its content is part of it, with its blank lines, at its indentation indicator’s indentation');
	unchanged('      skip-engines: | x\n', 'a block scalar’s header with something after it');
	unchanged('      skip-engines: |\n          x\n        not-declared: 1\n', 'a line indented less than a block scalar’s content');

	// quoted, and plain, scalars over several lines
	strips('      skip-engines: "a value\n        # that isn’t a comment\n        not-declared: 1 that isn’t a key"\n', 'every line of a quoted scalar is its value, whatever it looks like');
	strips('      skip-engines: \'it\'\'s\n        still its value\'\n', 'a single-quoted one too, with its escaped quotes');
	strips('      skip-engines: "a\n        \tb"\n', 'any whitespace after its lines’ indentation is a quoted scalar’s own');
	unchanged('      skip-engines: "a value\n      not-declared: 1"\n', 'a quoted scalar’s line indented no more than its key');
	unchanged('      skip-engines: "never\n        ends\n', 'a quoted scalar that never ends');
	unchanged('      skip-engines: "ends" not-declared: 1\n', 'anything but a comment after a quoted scalar, on its line');
	strips('      skip-engines: "ends"\n        # a comment after it\n', 'a comment may follow a quoted scalar that’s ended');
	strips('      skip-engines: a\n        b # c\n', 'a plain scalar’s lines are its value, with a comment after them');
	strips('      skip-engines:\n        # a comment\n        true\n      skip-pack:\n        "on the next line"\n', 'a value on the line after its key’s, after a comment or not');
	unchanged('      skip-engines: a\n        # c\n        b\n', 'a plain scalar’s line after a comment');
	unchanged('      skip-engines: true\n        not-declared: 1\n', 'a key on a plain scalar’s next line');
	drifts('      skip-engines:\n        not-declared: 1\n      skip-pack: true\n', '      skip-engines:\n        not-declared: 1\n', 'a mapping as a value is its value, not keys of the `with:`, and stays, since it might be anything');
	drifts('      skip-engines:\n        - a\n', '      skip-engines:\n        - a\n', 'as does a block sequence');
	drifts('      skip-engines: &a [x]\n      skip-pack: *a\n', '      skip-engines: &a [x]\n      skip-pack: *a\n', 'and an alias of a collection');
	strips('      skip-engines:\n      skip-pack: ~\n', 'an empty value, or a null, is a scalar');
	t.end();
});

test('inputsOf and removedInputs', (t) => {
	t.deepEqual(inputsOf(tapePretest), new Map([passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]])]), 'each input’s lines, by the job that passes it, and the workflow it calls');
	t.deepEqual(inputsOf(tapeCommented), new Map([passed('tests', 'pretest.yml', [['skip-engines', tapeCommentedLines]])]), 'with the comments on lines of their own above it');
	t.deepEqual(inputsOf(pretestCall), new Map([passed('tests', 'pretest.yml', [])]), 'a call without a `with:` passes none');
	t.deepEqual(inputsOf('jobs:\n  a:\n    runs-on: x\n'), new Map(), 'no calls, nothing');
	t.deepEqual(inputsOf(`${tapePretest}  again:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-pack: true\n`), new Map([
		passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]]),
		passed('again', 'pretest.yml', [['skip-pack', ['      skip-pack: true']]]),
	]), 'each call of a workflow has its own');
	t.deepEqual(inputsOf('    uses: ljharb/actions/.github/workflows/pretest.yml@main\n'), new Map(), 'a `uses:` that isn’t a job’s is no call');
	t.deepEqual(inputsOf('jobs:\n  a: [x]\n  b:\n    uses: [x]\n  c:\n    uses: actions/checkout@v4\n  ? [d]\n  : uses: ljharb/actions/.github/workflows/pretest.yml@main\n'), new Map(), 'nor is a job that isn’t a mapping, or whose `uses:` isn’t one of this repo’s reusable workflows, or whose id isn’t a scalar');
	t.deepEqual(inputsOf('- jobs\n'), new Map(), 'nor is anything in a file that isn’t a mapping');
	t.deepEqual(inputsOf(`${pretestCall}    with:\n      - odd\n      skip-pack: true\n`), new Map(), 'a file that isn’t YAML has no calls');
	t.deepEqual(inputsOf(`${pretestCall}    with:\n      skip-pack:\n        # more\n        continued\n`), new Map([passed('tests', 'pretest.yml', [['skip-pack', ['      skip-pack:', '        # more', '        continued']]])]), 'what the parser says is an input’s value is in its lines');
	t.deepEqual(inputsOf(`${pretestCall}    with: { skip-pack: true }\n`), new Map([passed('tests', 'pretest.yml', [])]), 'a `with:` that isn’t understood passes nothing that’s known');
	t.deepEqual(inputsOf(`${pretestCall}    with:\n      # nothing to say it about\n`), new Map([passed('tests', 'pretest.yml', [])]), 'a comment with no input is no input');

	const none = { removed: new Map(), ambiguous: new Map() };
	t.deepEqual(removedInputs(tapePretest, pretestCall), { removed: new Map([passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]])]), ambiguous: new Map() }, 'what the after no longer passes');
	t.deepEqual(removedInputs(tapeCommented, pretestCall), { removed: new Map([passed('tests', 'pretest.yml', [['skip-engines', tapeCommentedLines]])]), ambiguous: new Map() }, 'with its comments');
	t.deepEqual(removedInputs(tapePretest, tapePretest), none, 'nothing, when it still passes everything');
	t.deepEqual(removedInputs(tapePretest, 'jobs: {}\n'), none, 'nothing, for a workflow it no longer calls at all');
	t.deepEqual(removedInputs(tapePretest, pretestCall.replace('pretest.yml', 'node.yml')), none, 'nothing, for a job that now calls another workflow');
	t.deepEqual(removedInputs(tapePretest, pretestCall.replace('  tests:', '  renamed:')), { removed: new Map([passed('renamed', 'pretest.yml', [['skip-engines', [tapeLine]]])]), ambiguous: new Map() }, 'from a renamed job, by its new id: the one call of that workflow on each side');
	t.deepEqual(removedInputs(tapePretest.replace('  tests:', '  renamed:'), pretestCall), { removed: new Map([passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]])]), ambiguous: new Map() }, 'or from a job that the after renames');

	const two = (/** @type {string} */ a, /** @type {string} */ b, /** @type {string} */ withA = '', /** @type {string} */ withB = '') => `jobs:\n  ${a}:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n${withA}  ${b}:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n${withB}`;
	const engines = '    with:\n      skip-engines: true\n';
	const pack = '    with:\n      skip-pack: true\n';
	t.deepEqual(removedInputs(two('a', 'b', engines, pack), pretestCall), { removed: new Map(), ambiguous: new Map([passed('a', 'pretest.yml', [['skip-engines', ['      skip-engines: true']]]), passed('b', 'pretest.yml', [['skip-pack', ['      skip-pack: true']]])]) }, 'ambiguous, when two renamed calls might be the one left: by their jobs before');
	t.deepEqual(removedInputs(tapePretest, two('a', 'b')), { removed: new Map(), ambiguous: new Map([passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]])]) }, 'or when a renamed call might be either of two');
	t.deepEqual(removedInputs(tapePretest, two('a', 'b', '', '    with:\n      skip-engines: false\n')), none, 'but not what one of them still passes');
	t.deepEqual(removedInputs(two('a', 'b', engines, pack), two('a', 'c', engines)), { removed: new Map([passed('c', 'pretest.yml', [['skip-pack', ['      skip-pack: true']]])]), ambiguous: new Map() }, 'a call that keeps its job is its own counterpart, which leaves one renamed call on each side');
	t.end();
});

test('addInputs', (t) => {
	/** @type {(text: string, inputs: Inputs) => string} */
	const add = (text, inputs) => addInputs(text, inputs).text;
	const { removed } = removedInputs(tapePretest, pretestCall);
	t.equal(add(pretestCall, removed), tapePretest, 'restores them exactly, in a new `with:` right after the `uses:`');
	t.equal(add(pretestCall, removedInputs(tapeCommented, pretestCall).removed), tapeCommented, 'with their comments on lines of their own, as indented as they were');
	t.equal(add(tapePretest, removed), tapePretest, 'adds nothing that’s already passed');
	t.equal(add(`${pretestCall}    with:\n        skip-pack: true\n`, removed), `${pretestCall}    with:\n        skip-pack: true\n        skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n`, 'into an existing `with:`, as indented as its inputs');
	t.equal(add(`${pretestCall}    with:\n`, removed), `${pretestCall}    with:\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n`, 'into an empty `with:`');
	t.equal(add(`${pretestCall}    with: {}\n`, removed), `${pretestCall}    with: {}\n`, 'never into a flow-style `with:`');
	t.equal(add(pretestCall, new Map()), pretestCall, 'nothing to add');
	t.equal(add(pretestCall.replace('pretest.yml', 'node.yml'), removed), pretestCall.replace('pretest.yml', 'node.yml'), 'nothing, into a job that calls another workflow');
	const multiline = new Map([passed('tests', 'pretest.yml', [['skip-pack', ['  skip-pack: >', '', '    true']]])]);
	t.equal(add(pretestCall, multiline), `${pretestCall}    with:\n      skip-pack: >\n\n        true\n`, 'a value over several lines keeps its shape, and its blank lines');
	const twice = 'jobs:\n  a:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n  b:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n';
	const before = 'jobs:\n  a:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-pack: true\n  b:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n';
	t.equal(add(twice, removedInputs(before, twice).removed), before, 'to each call of a workflow, only what it was passed');
	const withFirst = 'jobs:\n  tests:\n    with:\n      skip-pack: true\n      # about it\n    # about what follows\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n';
	t.equal(add(withFirst, removed), 'jobs:\n  tests:\n    with:\n      skip-pack: true\n      # about it\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n    # about what follows\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n', 'after what the parser says is the last input, and its comments, wherever the `with:` is');
	t.equal(add(`${pretestCall}    with:\n      # nothing yet\n`, removed), `${pretestCall}    with:\n      # nothing yet\n      skip-engines: true # bin/tape requires node 8+, but the rest of tape supports 0.4+\n`, 'into a `with:` with only comments in it, after them');

	const unchanged = (/** @type {string} */ text, /** @type {string} */ message) => {
		t.equal(add(text, removed), text, `${message}: left as it is`);
		t.deepEqual(notPassed(add(text, removed), removed), removed, `${message}: so they’re not passed`);
	};
	unchanged(`${pretestCall}    with: { skip-pack: true }\n`, 'a flow-style `with:`');
	unchanged(`${pretestCall}    env: &defaults\n      skip-pack: true\n    with: *defaults\n`, 'a `with:` that’s an alias');
	unchanged(`${pretestCall}    with: ~\n`, 'a `with:` that’s null, explicitly');
	unchanged(`${pretestCall}    with:\n      &a skip-pack: true\n`, 'a `with:` with a key it doesn’t understand');
	unchanged(`${pretestCall}    with:\n      - odd\n`, 'a file that isn’t YAML');
	unchanged(`${pretestCall}  other: [\n`, 'even where the call is');
	unchanged(pretestCall.replace('pretest.yml', 'node.yml'), 'a job that calls another workflow');
	const broken = new Map([passed('tests', 'pretest.yml', [['skip-pack', ['      skip-pack: "never ends']]])]);
	t.equal(add(pretestCall, broken), pretestCall, 'nothing, when what it’d add leaves the file not YAML');
	const partly = new Map([...removed, passed('other', 'pretest.yml', [['skip-pack', ['      skip-pack: true']]])]);
	t.equal(add(pretestCall, partly), pretestCall, 'nothing, unless it can add all of them');
	t.deepEqual(notPassed(pretestCall, partly), partly, 'none of which are passed');
	t.deepEqual(notPassed(tapePretest, partly), new Map([passed('other', 'pretest.yml', [['skip-pack', ['      skip-pack: true']]])]), 'only those that aren’t are not passed');
	t.equal(unwritten(partly), 'job “tests” should pass skip-engines to pretest.yml, but they can’t be added to it: it doesn’t call it, or its “with:”, or the file, isn’t YAML the App understands; job “other” should pass skip-pack to pretest.yml, but they can’t be added to it: it doesn’t call it, or its “with:”, or the file, isn’t YAML the App understands', 'why, for a person');
	t.end();
});

test('keepInputs', (t) => {
	const rendered = template('node-pretest.yml');
	/** @type {(text: string) => { text: string, why: null }} */
	const ok = (text) => ({ text, why: null });
	t.deepEqual(keepInputs(rendered, tapePretest, ['skip-engines']), ok(tapePretest), 'keeps a kept input, as the current file has it');
	t.deepEqual(keepInputs(rendered, tapePretest, ['skip-pack']), ok(rendered), 'only the kept ones');
	t.deepEqual(keepInputs(rendered, tapePretest, []), ok(rendered), 'nothing kept');
	t.deepEqual(keepInputs(rendered, tapePretest, void undefined), ok(rendered), 'nothing to keep');
	t.deepEqual(keepInputs(rendered, null, ['skip-engines']), ok(rendered), 'no current file');
	t.deepEqual(keepInputs(rendered, tapeCommented, ['skip-engines']), ok(tapeCommented), 'with its comments on lines of their own');
	const twice = (/** @type {string} */ a, /** @type {string} */ b) => `jobs:\n  a:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n${a}  b:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n${b}`;
	const current = twice('    with:\n      skip-engines: true # a\n', '    with:\n      skip-engines: false # b\n      skip-pack: true\n');
	t.deepEqual(keepInputs(twice('', ''), current, ['skip-engines']), ok(twice('    with:\n      skip-engines: true # a\n', '    with:\n      skip-engines: false # b\n')), 'in each job, its own value');

	const renamed = 'jobs:\n  pretest:\n    uses: ljharb/actions/.github/workflows/pretest.yml@main\n    with:\n      skip-engines: true\n';
	t.deepEqual(keepInputs(rendered, renamed, ['skip-engines']), ok(`${rendered}    with:\n      skip-engines: true\n`), 'from a job with another id than the template’s, when each calls that workflow once');
	t.deepEqual(keepInputs(rendered, current, ['skip-engines']), {
		text: rendered,
		why: 'the kept inputs can’t all be kept: job “a” passes skip-engines to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous; job “b” passes skip-engines to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous',
	}, 'and not at all, with why, when which call they go to is ambiguous');
	t.deepEqual(keepInputs(rendered, current, ['skip-pack']), {
		text: rendered,
		why: 'the kept inputs can’t all be kept: job “b” passes skip-pack to pretest.yml, but no job with that id calls it now, and which other call of it should get them is ambiguous',
	}, 'only for the calls that pass a kept input');

	t.deepEqual(keepInputs(rendered, `${tapePretest}  other: [\n`, ['skip-engines']), {
		text: rendered,
		why: 'the kept inputs can’t all be kept: the file isn’t YAML the App understands, so what it passes isn’t known',
	}, 'and not at all, with why, when the current file isn’t YAML it understands');
	t.deepEqual(keepInputs(rendered, `${pretestCall}    with: { skip-engines: true }\n`, ['skip-engines']), {
		text: rendered,
		why: 'the kept inputs can’t all be kept: job “tests”’s `with:` for pretest.yml isn’t one the App understands, so what it passes isn’t known',
	}, 'or a call’s `with:` in it isn’t');
	const unreadable = `${rendered}    with: { skip-pack: true }\n`;
	t.deepEqual(keepInputs(unreadable, tapePretest, ['skip-engines']), {
		text: unreadable,
		why: 'the kept inputs can’t all be kept: job “tests” should pass skip-engines to pretest.yml, but they can’t be added to it: it doesn’t call it, or its “with:”, or the file, isn’t YAML the App understands',
	}, 'or they can’t be added to what’s rendered');
	t.end();
});

test('addInputs: only what’s given is added, as it’s given, or nothing is', (t) => {
	const nodeCall = pretestCall.replace('pretest.yml', 'node.yml');
	/** @type {(lines: string[], key?: string, file?: string) => Inputs} */
	const given = (lines, key = 'notable', file = 'node.yml') => new Map([passed('tests', file, [[key, lines]])]);
	/** @type {(text: string, inputs: Inputs, why: string, message: string) => void} */
	const refused = (text, inputs, why, message) => {
		t.deepEqual(addInputs(text, inputs), { text, why }, `${message}: refused, with why, leaving the file as it is`);
	};

	refused(nodeCall, given(['      notable: true', '  evil: 1']), 'job “tests”’s notable can’t be added to node.yml: a line after its key isn’t blank, a comment, or indented more than its key', 'a line after its key that’s indented less than it (which would be a key of something else)');
	refused(nodeCall, given(['      notable: true', '      evil: 1']), 'job “tests”’s notable can’t be added to node.yml: a line after its key isn’t blank, a comment, or indented more than its key', 'or as indented as it (which would be another input)');
	refused(nodeCall, given(['      notable: true\n  evil: 1']), 'job “tests”’s notable can’t be added to node.yml: a line has a line break in it', 'a “line” with a line break in it');
	refused(nodeCall, given(['      notable: true\r  evil: 1']), 'job “tests”’s notable can’t be added to node.yml: a line has a line break in it', 'or a carriage return');
	refused(nodeCall, given(['      # only a comment']), 'job “tests”’s notable can’t be added to node.yml: there’s no key', 'only comments');
	refused(nodeCall, given([]), 'job “tests”’s notable can’t be added to node.yml: there’s no key', 'no lines at all');
	refused(nodeCall, given(['      os: macos-latest']), 'job “tests”’s notable can’t be added to node.yml: its lines aren’t YAML of only that input', 'lines of another input than the one named');
	refused(nodeCall, given(['      - notable']), 'job “tests”’s notable can’t be added to node.yml: its lines aren’t YAML of only that input', 'lines that aren’t a mapping');
	refused(nodeCall, given(['      notable: "never ends']), 'job “tests”’s notable can’t be added to node.yml: its lines aren’t YAML of only that input', 'lines the parser finds an error in');
	refused(nodeCall, given(['      notable: !custom true']), 'job “tests”’s notable can’t be added to node.yml: its lines aren’t YAML of only that input', 'or a warning');

	const shadowed = 'jobs:\n  tests:\n    uses: ljharb/actions/.github/workflows/node.yml@main\n    with:\n      os: &a ubuntu-latest\n  other:\n    runs-on: *a\n';
	refused(shadowed, given(['      notable: &a true']), 'adding them would change more of the file than those inputs', 'an anchor that would change what an alias after it is');
	t.equal(addInputs(shadowed, given(['      notable: &b true'])).why, null, 'but not one that wouldn’t');

	const twin = 'jobs:\n  1:\n    uses: ljharb/actions/.github/workflows/node.yml@main\n  \'1\':\n    uses: ljharb/actions/.github/workflows/node.yml@main\n';
	refused(twin, new Map([passed('1', 'node.yml', [['notable', ['      notable: true']]])]), 'job “1”’s `with:` wouldn’t have exactly the inputs it has, and those added', 'a job whose id isn’t one job’s');

	t.deepEqual(addInputs(nodeCall, given(['      notable: |', '        true', '', '      # about it'])), { text: `${nodeCall}    with:\n      notable: |\n        true\n\n      # about it\n`, why: null }, 'what’s more indented than its key, blank, or a comment is part of it');
	t.end();
});

test('line endings', (t) => {
	/** @type {(text: string) => string} */
	const crlf = (text) => text.replace(/\n/g, '\r\n');
	const { removed } = removedInputs(crlf(tapePretest), crlf(pretestCall));
	t.deepEqual(removed, new Map([passed('tests', 'pretest.yml', [['skip-engines', [tapeLine]]])]), 'a `\\r\\n` is read as a `\\n`');
	t.deepEqual(removedInputs(tapePretest.replace(/\n/g, '\r'), pretestCall).removed, removed, 'as is a lone `\\r`');
	t.deepEqual(addInputs(crlf(pretestCall), removed), { text: crlf(tapePretest), why: null }, 'a file whose every line ends with `\\r\\n` keeps them');
	t.deepEqual(addInputs(pretestCall, removed), { text: tapePretest, why: null }, 'one whose lines end with `\\n` keeps them');
	const mixed = pretestCall.replace('\n', '\r\n');
	t.deepEqual(addInputs(mixed, removed), { text: tapePretest, why: null }, 'and one with both has only `\\n`s');
	t.deepEqual(addInputs(mixed, new Map()), { text: mixed, why: null }, 'unless nothing’s added');
	t.equal(stripKnownInputs(crlf(tapePretest), template('node-pretest.yml')), crlf(pretestCall), 'what’s left after removing inputs keeps them too');
	t.deepEqual(keepInputs(template('node-pretest.yml'), crlf(tapePretest), ['skip-engines']), { text: tapePretest, why: null }, 'a kept input keeps what’s rendered’s line endings, not the current file’s');
	t.end();
});
