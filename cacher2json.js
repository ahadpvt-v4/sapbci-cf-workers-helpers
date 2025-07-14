/**
 * Loads an R2 JSON object and caches specific keys in module RAM.
 * @param {any} env - The environment object passed to fetch().
 * @param {string} bucketName - The R2 binding name in env.
 * @param {string} objectName - The object key inside R2.
 * @param {string[]} exportsNames - List of keys to export and cache.
 * @returns {Promise<Object>} An object of { key: value } pairs.
 */
// At the top of your Worker module
const __R2_RAM_CACHE_JSON__ = {};

async function cacheR2JSON(env, bucketName, objectName, exportsNames) {
	const uncachedKeys = exportsNames.filter((k) => !__R2_RAM_CACHE_JSON__[k]);

	if (uncachedKeys.length === 0) {
		// All keys already cached
		const result = {};
		for (const key of exportsNames) {
			result[key] = __R2_RAM_CACHE_JSON__[key];
		}
		return result;
	}

	const r2 = env[bucketName];
	if (!r2) throw new Error(`R2 bucket "${bucketName}" not found in env.`);

	const obj = await r2.get(objectName);
	if (!obj) throw new Error(`R2 object "${objectName}" not found.`);

	const text = await obj.text();
	const parsed = JSON.parse(text);

	const result = {};
	for (const key of exportsNames) {
		if (!(key in parsed)) throw new Error(`Key "${key}" not found in R2 JSON.`);
		__R2_RAM_CACHE_JSON__[key] = parsed[key];
		result[key] = parsed[key];
	}

	return result;
}
module.exports = { __R2_RAM_CACHE_JSON__, cacheR2JSON };
