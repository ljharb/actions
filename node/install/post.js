'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const core = require('@actions/core');
const github = require('@actions/github');

const afterSuccess = core.getInput('after_success');

spawnSync(
	'bash',
	[path.join(__dirname, 'post.sh'), afterSuccess],
	{ cwd: process.cwd(), stdio: 'inherit' }
);
