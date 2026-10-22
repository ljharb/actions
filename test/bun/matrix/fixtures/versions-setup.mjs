// Preloaded via `node --import` into the `bun/matrix` child process; inert unless `BUN_MATRIX_VERSIONS` is set, so tape can load it harmlessly.
import semver from 'semver';

const injected = process.env.BUN_MATRIX_VERSIONS;

if (injected) {
	const versions = JSON.parse(injected);
	const { sort } = semver;
	/** @type {typeof semver.sort} */
	const patchedSort = (list, ...rest) => sort(
		list.length === 1 && list[0] === 'latest' ? versions : list,
		...rest,
	);
	semver.sort = patchedSort;
}
