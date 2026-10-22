import { ClientRequestInterceptor } from "../interceptors/ClientRequest/index.js";
import { XMLHttpRequestInterceptor } from "../interceptors/XMLHttpRequest/node.js";
import { FetchInterceptor } from "../interceptors/fetch/node.js";
//#region src/presets/node.ts
/**
* A Node.js preset for the request interception regardless
* of their initiator (http, fetch, XMLHttpRequest).
*/
var node_default = [
	new ClientRequestInterceptor(),
	new XMLHttpRequestInterceptor(),
	new FetchInterceptor()
];
//#endregion
export { node_default as default };

//# sourceMappingURL=node.js.map