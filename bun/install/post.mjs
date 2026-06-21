import { spawnSync } from 'child_process';
import path from 'path';

import * as core from '@actions/core';

const afterSuccess = core.getInput('after_success');

spawnSync(
	'bash',
	[path.join(import.meta.dirname, 'post.sh'), afterSuccess],
	{ cwd: process.cwd(), stdio: 'inherit' },
);
