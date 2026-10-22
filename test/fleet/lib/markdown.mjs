import test from 'tape';

import { code, html } from '../../../fleet/lib/markdown.mjs';

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
