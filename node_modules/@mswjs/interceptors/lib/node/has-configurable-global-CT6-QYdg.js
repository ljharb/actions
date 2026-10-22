import { t as getDeepPropertyDescriptor } from "./patches-registry-DxR5TEc-.js";
//#region src/utils/has-configurable-global.ts
/**
* Returns a boolean indicating whether the given global property
* is defined and is configurable.
*/
function hasConfigurableGlobal(propertyName) {
	const match = getDeepPropertyDescriptor(globalThis, propertyName);
	if (typeof match === "undefined") return false;
	const { descriptor } = match;
	if (typeof descriptor.get === "function" && typeof descriptor.get() === "undefined") return false;
	if (typeof descriptor.get === "undefined" && descriptor.value == null) return false;
	if (typeof descriptor.set === "undefined" && !descriptor.configurable) {
		console.error(`[MSW] Failed to apply interceptor: the global \`${propertyName}\` property is non-configurable. This is likely an issue with your environment. If you are using a framework, please open an issue about this in their repository.`);
		return false;
	}
	return true;
}
//#endregion
export { hasConfigurableGlobal as t };

//# sourceMappingURL=has-configurable-global-CT6-QYdg.js.map