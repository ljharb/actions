import test from 'tape';

import {
	code,
	html,
	split,
} from '../../../fleet/lib/markdown.mjs';

test('code', (t) => {
	t.equal(code('foo'), '`foo`', 'plain text gets a single-backtick fence');
	t.equal(code('  foo  '), '`foo`', 'surrounding whitespace is trimmed');
	t.equal(code('a\nb\r\n\r\nc'), '`a b c`', 'line breaks collapse to single spaces');
	t.equal(code('a | b'), '`a \\| b`', 'pipes are escaped so they can’t split table cells');
	t.equal(code('a `b` c'), '``a `b` c``', 'the fence is longer than any backtick run inside');
	t.equal(code('a ``b`` c'), '```a ``b`` c```', 'the fence is longer than the longest run');
	t.equal(code('`a'), '`` `a ``', 'a leading backtick gets padding');
	t.equal(code('a`'), '`` a` ``', 'a trailing backtick gets padding');
	t.equal(code('@ljharb [x](y)'), '`@ljharb [x](y)`', 'mentions and links stay inert inside code');
	t.equal(code(''), '``', 'empty string');

	t.end();
});

test('html', (t) => {
	t.equal(html('plain'), 'plain', 'nothing to escape');
	t.equal(html('<a href="x" title=\'y\'>&</a>'), '&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#60;/a&#62;', 'all five special characters are escaped');

	t.end();
});

// a part's own text, without the notes saying which part it is
/** @type {(part: string) => string} */
function content(part) {
	return part.replace(/^(?:<!-- c -->\n)?_continued \(\d+\/\d+\)_\n\n/, '').replace(/\n\n_continued below \(\d+\/\d+\)_$/, '');
}

test('split: what fits is one part, as is', (t) => {
	t.deepEqual(split(['a', '', 'b'], 1000), ['a\n\nb'], 'joined by newlines');
	t.deepEqual(split([], 1000), [''], 'nothing is one empty part');
	t.deepEqual(split(['', ''], 1000), [''], 'as are only blank lines');
	const group = { open: 'OPEN', close: 'CLOSE' };
	t.deepEqual(split([{ text: 'x', group }, { text: 'y', group }], 1000), ['x\ny'], 'a group that isn’t split adds nothing');

	t.end();
});

test('split: between units, as few parts as it takes, each within the limit', (t) => {
	const rows = Array.from({ length: 100 }, (_, i) => `row ${String(i).padStart(3, '0')} ${'r'.repeat(40)}`);
	const parts = split(['intro', '', ...rows, '', 'the end'], 1000, '<!-- c -->\n');
	t.ok(parts.length > 4, `several parts (${parts.length})`);
	parts.forEach((part, i) => {
		t.ok(part.length <= 1000, `part ${i + 1} (${part.length} characters) fits`);
		t.equal(part.startsWith(`<!-- c -->\n_continued (${i + 1}/${parts.length})_\n\n`), i > 0, `part ${i + 1} starts with the prefix and its number only if it isn’t the first`);
		t.equal(part.endsWith(`\n\n_continued below (${i + 2}/${parts.length})_`), i < parts.length - 1, `part ${i + 1} says it continues only if it isn’t the last`);
	});
	t.deepEqual(parts.map(content).join('\n').split('\n').filter(Boolean), ['intro', ...rows, 'the end'], 'every unit is in one part, whole, in order');
	t.ok(parts[0].startsWith('intro\n\nrow 000'), 'the first part starts as the text does');
	t.ok(parts.at(-1)?.endsWith('\n\nthe end'), 'the last part ends as the text does');
	parts.slice(0, -1).forEach((part, i) => {
		const next = content(parts[i + 1]).split('\n')[0];
		t.ok(content(part).length + 1 + next.length > 1000 - '<!-- c -->\n'.length - 100, `part ${i + 1} has no room for the next unit`);
	});

	t.end();
});

test('split: a group’s text opens and closes each part it’s split across', (t) => {
	const table = { open: '| A | B |\n| --- | --- |', close: '' };
	const details = { open: '<details><summary>x (continued)</summary>\n', close: '\n</details>' };
	const rows = Array.from({ length: 30 }, (_, i) => ({ text: `| ${i} | ${'b'.repeat(40)} |`, group: table }));
	const lines = Array.from({ length: 30 }, (_, i) => ({ text: `- line ${i} ${'d'.repeat(40)}`, group: details }));
	const parts = split([
		'intro',
		{ text: table.open, group: table },
		...rows,
		'',
		{ text: '<details><summary>x</summary>', group: details },
		...lines,
		{ text: '</details>', group: details },
		'end',
	], 600);
	t.ok(parts.length > 4, `several parts (${parts.length})`);
	for (const [i, part] of parts.entries()) {
		const text = content(part);
		const tableRows = text.split('\n').filter((l) => (/^\| \d+ \|/).test(l));
		if (tableRows.length > 0) {
			t.ok(text.includes(`${table.open}\n${tableRows[0]}`), `part ${i + 1}: its rows follow the table’s header`);
		}
		t.equal((text.match(/<details>/g) ?? []).length, (text.match(/<\/details>/g) ?? []).length, `part ${i + 1}: every <details> it opens, it closes`);
		t.ok(part.length <= 600, `part ${i + 1} fits`);
	}
	t.equal(parts.map(content).join('\n').split('\n').filter((l) => (/^- line \d+/).test(l)).length, 30, 'every line of the group is in one part');

	t.end();
});

test('split: a unit too long for any part is shown as its source, in fenced pieces, each in a part of its own', (t) => {
	const long = `${'@someone [x](y) '.repeat(100)}\`\`\`\`\n${'z'.repeat(1000)}😀${'w'.repeat(500)}`;
	const group = { open: 'OPEN', close: 'CLOSE' };
	const parts = split([
		'before',
		{ text: 'first', group },
		{ text: long, group },
		{ text: 'after', group },
	], 1000);
	parts.forEach((part, i) => t.ok(part.length <= 1000, `part ${i + 1} (${part.length} characters) fits`));
	t.equal(content(parts[0]), 'before\nfirst\nCLOSE', 'what comes before is in its own part, closing the group');
	t.equal(content(parts.at(-1) ?? ''), 'OPEN\nafter', 'what comes after is in its own part, reopening it');
	const pieces = parts.slice(1, -1).map(content);
	t.ok(pieces.length > 1, `the long unit is in several pieces (${pieces.length})`);
	/** @type {string[]} */
	const sources = [];
	pieces.forEach((piece, i) => {
		const match = piece.match(/^_✂️ This item is too long to fit in one part, so it’s shown as its source, in (?<n>\d+) pieces: this is piece (?<k>\d+) of \d+\._\n\n(?<ticks>`{3,})\n(?<source>[^]*)\n\k<ticks>$/u);
		t.ok(match, `piece ${i + 1} is marked, and fenced`);
		t.equal(Number(match?.groups?.k), i + 1, `piece ${i + 1} says which it is`);
		t.equal(Number(match?.groups?.n), pieces.length, `piece ${i + 1} says how many there are`);
		const source = match?.groups?.source ?? '';
		t.ok((match?.groups?.ticks.length ?? 0) > Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length)), `piece ${i + 1}’s fence is longer than any backtick run in it`);
		sources.push(source);
	});
	t.equal(sources.join(''), long, 'the pieces are the whole unit, in order, with no surrogate pair split');

	// a piece holds 232 characters at this limit, so this surrogate pair straddles the first cut
	const emoji = `${'z'.repeat(231)}😀${'w'.repeat(1000)}`;
	const surrogates = split([emoji], 1000).map((part) => content(part).split('\n')[3]);
	t.equal(surrogates[0], 'z'.repeat(231), 'a piece that would end between the halves of a surrogate pair ends before it');
	t.equal(surrogates.join(''), emoji, 'so it’s whole in the next piece');

	const ticks = '`'.repeat(3000);
	const fenced = split([ticks], 1000);
	fenced.forEach((part, i) => t.ok(part.length <= 1000, `a unit of only backticks: part ${i + 1} (${part.length} characters) fits`));
	t.equal(fenced.map((part) => content(part).split('\n')[3]).join(''), ticks, 'and its pieces are the whole unit');

	t.end();
});
