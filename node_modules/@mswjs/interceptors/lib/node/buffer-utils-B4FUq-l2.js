//#region src/utils/buffer-utils.ts
const encoder = new TextEncoder();
function encodeBuffer(text) {
	return encoder.encode(text);
}
function decodeBuffer(buffer, encoding) {
	return new TextDecoder(encoding).decode(buffer);
}
function toBuffer(data, encoding) {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof Uint8Array) return Buffer.from(data.buffer);
	return Buffer.from(data, encoding);
}
//#endregion
export { encodeBuffer as n, toBuffer as r, decodeBuffer as t };

//# sourceMappingURL=buffer-utils-B4FUq-l2.js.map