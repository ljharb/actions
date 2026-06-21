'use strict';

const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { createRequire } = require('module');
const path = require('path');

// bun writes no npm-compatible lockfile, so `npm ls` cannot validate a dist-tag dependency
// (e.g. `typescript@next`): `@npmcli/arborist` treats a `tag` edge as valid only when its target
// carries a remote `resolved` URL (arborist's `lib/dep-valid.js`, `case 'tag'`). Rebuild the
// hidden lockfile from the tree bun installed, without re-resolving or mutating `node_modules`.

async function main() {
	const cwd = process.cwd();
	const hiddenLockfile = path.join(cwd, 'node_modules', '.package-lock.json');

	// skip when a hidden lockfile is already present, e.g. a cache-restored tree.
	if (!existsSync(path.join(cwd, 'node_modules')) || existsSync(hiddenLockfile)) {
		return;
	}

	// arborist and npm-package-arg ship inside the globally installed npm, not this action.
	const npmRequire = createRequire(path.join(execSync('npm root -g').toString().trim(), 'npm', 'package.json'));
	const Arborist = npmRequire('@npmcli/arborist');
	const npa = npmRequire('npm-package-arg');

	const arb = new Arborist({ path: cwd, offline: true });
	const tree = await arb.loadActual();

	let synthesized = 0;
	for (const node of tree.inventory.values()) {
		const isTagTarget = !node.resolved && node.version && node.packageName && Array.from(node.edgesIn).some((edge) => {
			try {
				return npa(`${edge.name}@${edge.spec}`).type === 'tag';
			} catch {
				return false;
			}
		});
		if (isTagTarget) {
			// the `tag` validity check only requires a remote URL; integrity is not verified.
			const tarball = node.packageName.replace(/^@[^/]+\//, '');
			node.resolved = `https://registry.npmjs.org/${node.packageName}/-/${tarball}-${node.version}.tgz`;
			synthesized += 1;
		}
	}

	// nothing to fix when there are no dist-tag deps; `npm ls` validates plain semver from disk.
	if (synthesized === 0) {
		return;
	}

	tree.meta.hiddenLockfile = true;
	tree.meta.filename = hiddenLockfile;
	await tree.meta.save();
	console.log(`synthesized node_modules/.package-lock.json (${synthesized} dist-tag dep(s)) for the bun-installed tree`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
