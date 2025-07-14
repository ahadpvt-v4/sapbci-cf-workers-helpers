import { createPathMatcher } from './create-path-matcher';
/**
 * Creates a standardized error object.
 * @param {Object} options
 * @param {string} options.message - Error message
 * @param {number} [options.status=500] - HTTP status code
 * @param {string} [options.code="ACCESS_RATE_LIMITER_ERROR"] - Error code string
 * @param {number} [options.exit_code=99] - Exit code or severity code
 * @param {string} [options.hint] - Developer hint
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'ACCESS_RATE_LIMITER_ERROR', exit_code = 99, hint = undefined }) {
	const err = new Error(message);
	err.status = status;
	err.code = code;
	err.exit_code = exit_code;
	if (hint) err.hint = hint;
	return err;
}
class AccessRateLimiter {
	constructor() {
		this.rules = [];
		this._storage = this._createMemoryStorage();
		this._globalOnBlocked = null;
	}

	perIp(limit, options = {}) {
		if (typeof limit !== 'number' || limit <= 0) {
			throw createError({
				message: 'perIp(limit) requires a positive integer limit.',
				status: 400,
				code: 'INVALID_LIMIT',
				exit_code: 1,
				hint: 'Provide a positive number for limit.',
			});
		}
		this.rules.push({
			type: 'perIp',
			keySelector: (req) => req.rawRequest.headers.get('cf-connecting-ip') || req.rawRequest.headers.get('x-forwarded-for') || 'unknown',
			rateLimit: limit,
			windowMs: options.windowMs ?? 60_000,
			concurrency: options.concurrency,
			statusCode: options.statusCode ?? 429,
			message: options.message ?? 'Too many requests',
			onLimitExceeded: options.onLimitExceeded,
		});
		return this;
	}

	perPath(pathPattern, options = {}) {
		if (typeof pathPattern !== 'string') {
			throw createError({
				message: 'perPath(pathPattern) requires a string pathPattern.',
				status: 400,
				code: 'INVALID_PATH_PATTERN',
				exit_code: 2,
				hint: 'Provide a valid string path (wildcards supported).',
			});
		}
		if (typeof options.rateLimit !== 'number' || options.rateLimit <= 0) {
			throw createError({
				message: 'perPath() requires a positive numeric rateLimit.',
				status: 400,
				code: 'INVALID_LIMIT',
				exit_code: 3,
			});
		}
		const matcher = createPathMatcher(pathPattern);

		this.rules.push({
			type: 'perPath',
			pathPattern,
			matcher,
			keySelector: (req) => req.url.pathname,
			rateLimit: options.rateLimit,
			windowMs: options.windowMs ?? 60_000,
			concurrency: options.concurrency,
			statusCode: options.statusCode ?? 429,
			message: options.message ?? 'Too many requests',
			onLimitExceeded: options.onLimitExceeded,
		});
		return this;
	}

	async block(key, ms) {
		if (typeof key !== 'string') {
			throw createError({
				message: 'block(key, ms) requires key as string.',
				status: 400,
				code: 'INVALID_BLOCK_KEY',
				exit_code: 4,
			});
		}
		if (typeof ms !== 'number' || ms <= 0) {
			throw createError({
				message: 'block(key, ms) requires ms as positive number.',
				status: 400,
				code: 'INVALID_BLOCK_DURATION',
				exit_code: 5,
			});
		}
		const storeKey = this._encodeKey({ type: 'block', key });
		await this._storage.set(storeKey, { expiresAt: Date.now() + ms });
	}

	async unblock(key) {
		if (typeof key !== 'string') {
			throw createError({
				message: 'unblock(key) requires key as string.',
				status: 400,
				code: 'INVALID_UNBLOCK_KEY',
				exit_code: 6,
			});
		}
		const storeKey = this._encodeKey({ type: 'block', key });
		await this._storage.delete(storeKey);
	}

	withStorage(storageObj) {
		if (
			!storageObj ||
			typeof storageObj.get !== 'function' ||
			typeof storageObj.set !== 'function' ||
			typeof storageObj.delete !== 'function'
		) {
			throw createError({
				message: 'Storage must implement get, set, delete methods.',
				status: 500,
				code: 'INVALID_STORAGE',
				exit_code: 8,
			});
		}
		this._storage = storageObj;
		return this;
	}

	onBlocked(fn) {
		if (typeof fn !== 'function') {
			throw createError({
				message: 'onBlocked() expects a function.',
				status: 400,
				code: 'INVALID_ONBLOCKED',
				exit_code: 9,
			});
		}
		this._globalOnBlocked = fn;
		return this;
	}

	handler() {
		return async (req, res, env, ctx, next) => {
			const now = Date.now();
			const concurrencyKeysToDecrement = [];

			for (const rule of this.rules) {
				// Skip perPath rules if the path doesn't match
				if (rule.type === 'perPath') {
					const matchResult = rule.matcher(req.url.pathname);
					if (!matchResult) {
						continue; // no match, skip this rule
					}
				}

				const key = rule.keySelector(req);

				if (await this._checkBlocked(key, now)) {
					return this._respondBlocked(res, rule, key, 'blocked');
				}

				if (rule.concurrency !== undefined) {
					const cKey = this._encodeKey({
						type: 'concurrency',
						ruleType: rule.type,
						key,
						pathPattern: rule.pathPattern || null,
					});
					let c = (await this._storage.get(cKey)) ?? 0;
					if (c >= rule.concurrency) {
						return this._respondBlocked(res, rule, key, 'concurrency');
					}
					await this._storage.set(cKey, c + 1);
					concurrencyKeysToDecrement.push(cKey);
				}

				if (rule.rateLimit !== undefined) {
					const rKey = this._encodeKey({
						type: 'rate',
						ruleType: rule.type,
						key,
						pathPattern: rule.pathPattern || null,
					});
					let entry = await this._storage.get(rKey);
					if (!entry || now - entry.start > rule.windowMs) {
						entry = { count: 0, start: now };
					}
					entry.count++;
					await this._storage.set(rKey, entry);
					if (entry.count > rule.rateLimit) {
						return this._respondBlocked(res, rule, key, 'rate');
					}
				}
			}

			try {
				return await next();
			} finally {
				for (const cKey of concurrencyKeysToDecrement) {
					let c = (await this._storage.get(cKey)) ?? 1;
					await this._storage.set(cKey, Math.max(0, c - 1));
				}
			}
		};
	}

	async _checkBlocked(key, now) {
		const bKey = this._encodeKey({ type: 'block', key });
		const entry = await this._storage.get(bKey);
		return entry && entry.expiresAt > now;
	}

	_respondBlocked(res, rule, key, reason) {
		if (typeof rule.onLimitExceeded === 'function') {
			return rule.onLimitExceeded(res, { key, rule, reason });
		}
		if (typeof this._globalOnBlocked === 'function') {
			return this._globalOnBlocked(res, { key, rule, reason });
		}
		return res.setStatus(rule.statusCode ?? 429).send(`${rule.message} [${reason}] (${key})`);
	}

	_encodeKey(obj) {
		const json = JSON.stringify(obj);
		const b64 = Buffer.from(json).toString('base64url');
		return `accessrl:${b64}`;
	}

	_decodeKey(str) {
		const base = str.replace(/^accessrl:/, '');
		const json = Buffer.from(base, 'base64url').toString();
		return JSON.parse(json);
	}
	_createMemoryStorage() {
		const map = new Map();
		return {
			get: async (k) => map.get(k),
			set: async (k, v) => map.set(k, v),
			delete: async (k) => map.delete(k),
		};
	}
	async reset(key, pathPattern = null) {
		if (typeof key !== 'string') {
			throw createError({
				message: 'reset(key) requires key as string.',
				status: 400,
				code: 'INVALID_RESET_KEY',
				exit_code: 7,
			});
		}

		const types = ['rate', 'concurrency', 'block'];

		// Always delete the keys without pathPattern
		for (const type of types) {
			const storeKey = this._encodeKey({
				type,
				key,
				pathPattern: null,
			});
			await this._storage.delete(storeKey);
		}

		// If pathPattern is specified, delete those keys too
		if (pathPattern !== null) {
			for (const type of types) {
				const storeKey = this._encodeKey({
					type,
					key,
					pathPattern,
				});
				await this._storage.delete(storeKey);
			}
		}
	}
}
module.exports = { AccessRateLimiter };

//cloudflare-workers-compatible-rate-limiter.js
