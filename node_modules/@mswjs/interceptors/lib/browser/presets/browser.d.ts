import { XMLHttpRequestInterceptor } from "../interceptors/XMLHttpRequest/web.js";
import { FetchInterceptor } from "../interceptors/fetch/web.js";
//#region src/presets/browser.d.ts
/**
 * A browser preset for the request interception regardless
 * of their initiator (fetch, XMLHttpRequest).
 */
declare const _default: readonly [FetchInterceptor, XMLHttpRequestInterceptor];
//#endregion
export { _default as default };
//# sourceMappingURL=browser.d.ts.map