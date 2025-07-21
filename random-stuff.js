import crypto from 'crypto';
function randomStringVal(alphaNumeric = false, length = 50, prefix = '', suffix = '') {
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	const chars = alphaNumeric ? letters + '0123456789' : letters;
	const charsLen = chars.length;
	const maxValidByte = 256 - (256 % charsLen); // max byte value allowed to avoid bias

	const bytes = crypto.randomBytes(length * 2); // generate extra bytes to account for discards
	let result = '';

	for (let i = 0, j = 0; result.length < length && j < bytes.length; j++) {
		const byte = bytes[j];
		if (byte < maxValidByte) {
			result += chars[byte % charsLen];
		}
	}
	// fallback if not enough valid bytes, could generate more or throw
	if (result.length < length) throw new Error('Not enough randomness generated');

	return prefix + result + suffix;
}

function randomIntVal(placeValue = 13, rangeStart = 1_000_000_000_000, rangeStop = 9_999_999_999_999) {
	const range = rangeStop - rangeStart + 1;
	const maxBytes = 6;
	const maxDec = 2 ** (8 * maxBytes);

	let rand;
	do {
		rand = parseInt(crypto.randomBytes(maxBytes).toString('hex'), 16);
	} while (rand >= maxDec - (maxDec % range));

	return rangeStart + (rand % range);
}
function generateAesKeyBase64(lengthBytes = 32) {
	const array = crypto.randomBytes(lengthBytes); // 32 bytes = 256 bits
	return array.toString('base64');
}

module.exports = { randomStringVal, randomIntVal, generateAesKeyBase64 };
