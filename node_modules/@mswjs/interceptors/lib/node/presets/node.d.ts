import { ClientRequestInterceptor } from "../interceptors/ClientRequest/index.js";
import { XMLHttpRequestInterceptor } from "../interceptors/XMLHttpRequest/node.js";
import { FetchInterceptor } from "../interceptors/fetch/node.js";
//#region src/presets/node.d.ts
/**
 * A Node.js preset for the request interception regardless
 * of their initiator (http, fetch, XMLHttpRequest).
 */
declare const _default: readonly [ClientRequestInterceptor, XMLHttpRequestInterceptor, FetchInterceptor];
//#endregion
export { _default as default };
//# sourceMappingURL=node.d.ts.map