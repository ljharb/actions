'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

spawnSync(
    'bash',
    [path.join(__dirname, 'post.sh')],
    { cwd: process.cwd(), stdio: 'inherit' }
);
