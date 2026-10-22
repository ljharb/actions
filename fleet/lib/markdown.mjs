/** @type {(s: string) => string} */
export function code(s) {
	// commit messages, logins, ref/tag names, and file names are third-party input: keep them inert (no mentions, links, markup, or table cells)
	const text = s.replace(/[\r\n]+/g, ' ').trim().replace(/\|/g, '\\|');
	const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** @type {(s: string) => string} */
export function html(s) {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
