/**
 * AccessTracker: Middleware that tracks requests and stores selected info from headers and body.
 * Can be configured per-path, per-method, or global. Uses string-safe keys in storage.
 */

/**
 * Helper to create standardized errors.
 * @param {Object} options
 * @param {string} options.message - Error message
 * @param {number} [options.status=500] - HTTP status
 * @param {string} [options.code='ACCESS_TRACKER_ERROR'] - Error code
 * @param {number} [options.exit_code=99] - Exit code
 * @param {string} [options.hint] - Optional hint
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'ACCESS_TRACKER_ERROR', exit_code = 99, hint }) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.exit_code = exit_code;
	if (hint) e.hint = hint;
	return e;
}

class AccessTracker {
	constructor() {
		/**
		 * @private
		 * @type {Array<Object>}
		 */
		this.rules = [];

		/**
		 * @private
		 * @type {Object}
		 */
		this._storage = this._createDefaultMemoryStorage();
	}

	/**
	 * Sets the storage backend.
	 * @param {Object} storageObj - Must have get(key), set(key, entry), and keys() methods.
	 * @returns {AccessTracker}
	 */
	storage(storageObj) {
		if (
			!storageObj ||
			typeof storageObj.get !== 'function' ||
			typeof storageObj.set !== 'function' ||
			typeof storageObj.keys !== 'function'
		) {
			throw createError({
				message: 'Storage must implement get(key), set(key, entry), and keys()',
				code: 'INVALID_STORAGE',
				exit_code: 1,
			});
		}
		this._storage = storageObj;
		return this;
	}

	/**
	 * Adds a tracking rule.
	 * @param {Object} options
	 * @param {string|string[]} [options.paths='*'] - Path(s) to match
	 * @param {string|string[]} [options.methods='*'] - Method(s) to match
	 * @param {string[]} [options.headers=[]] - Headers to capture
	 * @param {string[]} [options.bodyFields=[]] - JSON body fields to capture
	 * @returns {AccessTracker}
	 */
	track({ paths = '*', methods = '*', headers = [], bodyFields = [] }) {
		const rule = {
			paths: this._normalizeArray(paths),
			methods: this._normalizeArray(methods).map((m) => m.toUpperCase()),
			headers,
			bodyFields,
		};
		this.rules.push(rule);
		return this;
	}

	/**
	 * Middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return async (req, res, env, ctx, next) => {
			const path = req.url.pathname + (req.url.search || ''); // full path + query string
			const method = req.request.method.toUpperCase();

			for (const rule of this.rules) {
				if (!this._match(rule.paths, path) || !this._match(rule.methods, method)) continue;

				const ip = req.request.headers.get('cf-connecting-ip') || 'unknown';
				const key = this._makeKey(method, path, ip);

				const entry = {
					time: Date.now(),
					method,
					path, // full path + query string here too
					ip,
					headers: {},
					body: {},
				};

				for (const h of rule.headers) {
					entry.headers[h] = req.request.headers.get(h) || null;
				}

				if (rule.bodyFields.length > 0) {
					try {
						const cloned = req.request.clone();
						const json = await cloned.json();
						for (const f of rule.bodyFields) {
							entry.body[f] = this._getNested(json, f);
						}
					} catch {
						// Ignore parse errors
					}
				}

				await this._storage.set(key, entry);
				break;
			}

			return next();
		};
	}

	/**
	 * Download a report of stored entries lazily.
	 * Returns an async generator.
	 * @param {Object} [filter]
	 * @param {string} [filter.method]
	 * @param {string} [filter.path]
	 * @param {string} [filter.ip]
	 * @returns {AsyncGenerator<Object>}
	 */
	async *downloadReport(filter = {}) {
		const keys = await this._storage.keys();
		for (const key of keys) {
			try {
				const decoded = this._parseKey(key);
				if (
					(filter.method && filter.method !== decoded.method) ||
					(filter.path && filter.path !== decoded.path) ||
					(filter.ip && filter.ip !== decoded.ip)
				) {
					continue;
				}

				const entry = await this._storage.get(key);
				if (entry) {
					yield {
						key,
						decodedKey: decoded,
						entry,
					};
				}
			} catch {
				// Ignore invalid keys
			}
		}
	}

	_normalizeArray(val) {
		if (val === '*') return ['*'];
		if (Array.isArray(val)) return val;
		return [val];
	}

	_match(patterns, value) {
		if (!patterns || patterns.includes('*')) return true;
		return patterns.some((p) => this._wildcardMatch(value, p));
	}

	_wildcardMatch(str, pattern) {
		const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
		const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
		return regex.test(str);
	}

	_getNested(obj, path) {
		return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
	}

	_makeKey(method, path, ip) {
		const raw = JSON.stringify({ method, path, ip });
		return Buffer.from(raw).toString('base64url');
	}

	_parseKey(key) {
		const decoded = Buffer.from(key, 'base64url').toString('utf-8');
		return JSON.parse(decoded);
	}

	_createDefaultMemoryStorage() {
		const map = new Map();
		return {
			get: (key) => Promise.resolve(map.get(key)),
			set: (key, value) => Promise.resolve(map.set(key, value)),
			keys: () => Promise.resolve(Array.from(map.keys())),
		};
	}
}

module.exports = { AccessTracker };

//cloudflare-workers-compatible-access-tracker.js
