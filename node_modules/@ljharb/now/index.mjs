import { performance } from 'perf_hooks';

import callBind from 'call-bind-apply-helpers';

export default callBind([performance.now, performance]);
