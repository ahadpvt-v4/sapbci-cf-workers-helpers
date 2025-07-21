async function encryptResponse(plaintext, base64Key) {
	// Convert key
	const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
	const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
	// Convert plaintext
	let data;
	if (typeof plaintext === 'string') {
		data = new TextEncoder().encode(plaintext);
	} else {
		data = plaintext; // Uint8Array
	}
	// Generate IV
	const iv = crypto.getRandomValues(new Uint8Array(12));
	// Encrypt
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
	// Return IV + ciphertext as a single Uint8Array
	const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(ciphertext), iv.byteLength);
	return result;
}
async function decryptRequest(encryptedData, base64Key) {
	// Convert key
	const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
	const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
	// Convert input if base64
	if (typeof encryptedData === 'string') {
		encryptedData = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
	}
	// Split IV and ciphertext
	const iv = encryptedData.slice(0, 12);
	const ciphertext = encryptedData.slice(12);
	// Decrypt
	const plaintextBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
	return new Uint8Array(plaintextBuffer);
}

module.exports = { encryptResponse, decryptRequest };

// cloudflare-compatible-encryption-utils.js
