import { invariant } from "outvariant";
//#region src/utils/patches-registry.ts
var PatchesRegistry = class {
	#replacements = /* @__PURE__ */ new Map();
	applyPatch(owner, key, getNextValue) {
		const ownerReplacements = this.#replacements.get(owner);
		invariant(!ownerReplacements?.has(key), `Failed to replace a global value at "${String(key)}": already replaced.`);
		const match = getDeepPropertyDescriptor(owner, key);
		if (typeof match === "undefined") {
			console.warn(`Failed to replace a global value at "${String(key)}": not a global value.`);
			return () => {};
		}
		if (match.descriptor.configurable) Object.defineProperty(owner, key, {
			value: getNextValue(owner[key]),
			enumerable: true,
			configurable: true
		});
		else if (match.descriptor.writable) owner[key] = getNextValue(owner[key]);
		else throw new Error(`Failed to patch a non-configurable non-writable property "${key.toString()}"`);
		const restorePatch = () => {
			const currentReplacements = this.#replacements.get(owner);
			if (!currentReplacements?.has(key)) return;
			if (match.owner === owner)
 /**
			* @note Restoring non-configurable properties works as long as "writable: true"
			* and none of the other descriptor properties except for "value" have changed.
			*/
			Object.defineProperty(match.owner, key, match.descriptor);
			else
 /**
			* @todo Delete the proxy property set by the registry.
			* If the match's owner isn't the original owner, the property is likely nested in the prototype.
			* The registry does not meddle with those, they are left intact.
			*/
			Reflect.deleteProperty(owner, key);
			currentReplacements.delete(key);
			if (currentReplacements.size === 0) this.#replacements.delete(owner);
		};
		if (ownerReplacements) ownerReplacements.set(key, restorePatch);
		else this.#replacements.set(owner, /* @__PURE__ */ new Map([[key, restorePatch]]));
		return restorePatch;
	}
	restoreAllPatches() {
		const errors = [];
		for (const [, ownerReplacements] of this.#replacements) for (const [, restorePatch] of ownerReplacements) try {
			restorePatch();
		} catch (error) {
			if (error instanceof Error) errors.push(error);
			else throw error;
		}
		if (errors.length > 0) throw new AggregateError(errors, "FOO!");
	}
};
const patchesRegistry = new PatchesRegistry();
/**
* Returns a property descriptor for the given property on the owner.
* Walks down the prototype chain if the property does not exist on the owner.
* Handy for getting a global property descriptor where `globalThis` is
* replaced with a controlled class (e.g. ServiceWorkerGlobalScope).
*/
function getDeepPropertyDescriptor(owner, key) {
	let currentOwner = owner;
	let descriptor;
	while (currentOwner) {
		descriptor = Object.getOwnPropertyDescriptor(currentOwner, key);
		if (descriptor) return {
			owner: currentOwner,
			descriptor
		};
		currentOwner = Object.getPrototypeOf(currentOwner);
	}
}
//#endregion
export { patchesRegistry as n, getDeepPropertyDescriptor as t };

//# sourceMappingURL=patches-registry-DxR5TEc-.js.map