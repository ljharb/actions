//#region src/create-request-id.ts
/**
* Generate a random ID string to represent a request.
* @example
* createRequestId()
* // "f774b6c9c600f"
*/
function createRequestId() {
	return Math.random().toString(16).slice(2);
}
//#endregion
export { createRequestId as t };

//# sourceMappingURL=create-request-id-DHo-fRTV.js.map