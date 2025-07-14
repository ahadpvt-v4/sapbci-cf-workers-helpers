/**
 * @typedef {Object} ForwarderError
 * @property {string} message - Error message
 * @property {number} [status=500] - HTTP status
 * @property {string} [code='FORWARDER_ERROR'] - Error code
 * @property {number} [exit_code=1] - Exit code
 * @property {string} [hint] - Optional hint
 */

/**
 * Helper to create standardized errors.
 * @param {ForwarderError} param0
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'FORWARDER_ERROR', exit_code = 1, hint }) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.exit_code = exit_code;
	if (hint) e.hint = hint;
	return e;
}

/**
 * Redirects matching path prefixes to a new base URL.
 */
class PathForwarder {
	/**
	 * @param {[string, string]} pair - [originalPathPrefix, targetBaseUrl]
	 */
	constructor(pair) {
		if (!Array.isArray(pair) || pair.length !== 2) {
			throw createError({ message: 'PathForwarder requires a [original, target] pair' });
		}
		this.orig = pair[0].replace(/\/$/, '');
		this.target = pair[1].replace(/\/$/, '');
	}

	/**
	 * Returns middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingPath = incoming.pathname;
				if (incomingPath.startsWith(this.orig)) {
					const suffix = incomingPath.slice(this.orig.length) + incoming.search;
					const redirectUrl = this.target + suffix;
					return res.redirect(redirectUrl);
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in PathForwarder: ${err.message}`);
			}
		};
	}
}

/**
 * Redirects multiple path prefixes to target base URLs.
 */
class BulkPathForwarder {
	/**
	 * @param {Array<[string, string]>} pairs - Array of [original, target]
	 */
	constructor(pairs) {
		if (!Array.isArray(pairs) || pairs.length === 0) {
			throw createError({ message: 'BulkPathForwarder requires a non-empty array of pairs' });
		}
		this.pairs = pairs.map(([orig, target]) => {
			if (typeof orig !== 'string' || typeof target !== 'string') {
				throw createError({ message: 'BulkPathForwarder pairs must be strings' });
			}
			return {
				orig: orig.replace(/\/$/, ''),
				target: target.replace(/\/$/, ''),
			};
		});
	}

	/**
	 * Returns middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingPath = incoming.pathname;
				for (const { orig, target } of this.pairs) {
					if (incomingPath.startsWith(orig)) {
						const suffix = incomingPath.slice(orig.length) + incoming.search;
						const redirectUrl = target + suffix;
						return res.redirect(redirectUrl);
					}
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in BulkPathForwarder: ${err.message}`);
			}
		};
	}
}

/**
 * Forwards matching path prefixes to target base URL via fetch.
 */
class RequestForwarder {
	/**
	 * @param {[string, string]} pair - [originalPathPrefix, targetBaseUrl]
	 * @param {Object} [options]
	 * @param {string[]} [options.preserveSpecificHeaders] - Headers to explicitly preserve
	 */
	constructor(pair, options = {}) {
		if (!Array.isArray(pair) || pair.length !== 2) {
			throw createError({ message: 'RequestForwarder requires a [original, target] pair' });
		}
		this.orig = pair[0].replace(/\/$/, '');
		this.target = pair[1].replace(/\/$/, '');
		this.preserveSpecificHeaders = options.preserveSpecificHeaders || [];
	}

	/**
	 * Returns async middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return async (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingPath = incoming.pathname;
				if (incomingPath.startsWith(this.orig)) {
					const suffix = incomingPath.slice(this.orig.length) + incoming.search;
					const forwardUrl = this.target + suffix;

					const fetchInit = {
						method: req.request.method,
						headers: new Headers(req.request.headers),
						body: ['GET', 'HEAD'].includes(req.request.method) ? undefined : req.request.body,
						redirect: 'manual',
					};
					fetchInit.headers.delete('host');

					for (const h of this.preserveSpecificHeaders) {
						const v = req.request.headers.get(h);
						if (v && !fetchInit.headers.has(h)) {
							fetchInit.headers.set(h, v);
						}
					}

					const forwardedResponse = await fetch(forwardUrl, fetchInit);

					for (const [key, value] of forwardedResponse.headers.entries()) {
						if (!['transfer-encoding', 'content-encoding', 'content-length', 'connection'].includes(key.toLowerCase())) {
							res.setHeader(key, value);
						}
					}
					res.setStatus(forwardedResponse.status);
					const buf = await forwardedResponse.arrayBuffer();
					return res.end(Buffer.from(buf));
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in RequestForwarder: ${err.message}`);
			}
		};
	}
}

/**
 * Forwards multiple path prefixes via fetch.
 */
class BulkRequestForwarder {
	/**
	 * @param {Array<[string, string]>} pairs - Array of [original, target]
	 * @param {Object} [options]
	 * @param {string[]} [options.preserveSpecificHeaders] - Headers to explicitly preserve
	 */
	constructor(pairs, options = {}) {
		if (!Array.isArray(pairs) || pairs.length === 0) {
			throw createError({ message: 'BulkRequestForwarder requires a non-empty array of pairs' });
		}
		this.pairs = pairs.map(([orig, target]) => {
			if (typeof orig !== 'string' || typeof target !== 'string') {
				throw createError({ message: 'BulkRequestForwarder pairs must be strings' });
			}
			return {
				orig: orig.replace(/\/$/, ''),
				target: target.replace(/\/$/, ''),
			};
		});
		this.preserveSpecificHeaders = options.preserveSpecificHeaders || [];
	}

	/**
	 * Returns async middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return async (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingPath = incoming.pathname;
				for (const { orig, target } of this.pairs) {
					if (incomingPath.startsWith(orig)) {
						const suffix = incomingPath.slice(orig.length) + incoming.search;
						const forwardUrl = target + suffix;

						const fetchInit = {
							method: req.request.method,
							headers: new Headers(req.request.headers),
							body: ['GET', 'HEAD'].includes(req.request.method) ? undefined : req.request.body,
							redirect: 'manual',
						};
						fetchInit.headers.delete('host');

						for (const h of this.preserveSpecificHeaders) {
							const v = req.request.headers.get(h);
							if (v && !fetchInit.headers.has(h)) {
								fetchInit.headers.set(h, v);
							}
						}

						const forwardedResponse = await fetch(forwardUrl, fetchInit);

						for (const [key, value] of forwardedResponse.headers.entries()) {
							if (!['transfer-encoding', 'content-encoding', 'content-length', 'connection'].includes(key.toLowerCase())) {
								res.setHeader(key, value);
							}
						}
						res.setStatus(forwardedResponse.status);
						const buf = await forwardedResponse.arrayBuffer();
						return res.end(Buffer.from(buf));
					}
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in BulkRequestForwarder: ${err.message}`);
			}
		};
	}
}

/**
 * Redirects requests by origin match.
 */
class OriginForwarder {
	/**
	 * @param {[string, string]} pair - [originalOrigin, targetOrigin]
	 */
	constructor(pair) {
		if (!Array.isArray(pair) || pair.length !== 2) {
			throw createError({ message: 'OriginForwarder requires a [original, target] pair' });
		}
		this.orig = pair[0].replace(/\/$/, '');
		this.target = pair[1].replace(/\/$/, '');
	}

	/**
	 * Returns middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingOrigin = `${incoming.protocol}//${incoming.host}`;
				if (incomingOrigin === this.orig) {
					const redirectUrl = this.target + incoming.pathname + incoming.search;
					return res.redirect(redirectUrl);
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in OriginForwarder: ${err.message}`);
			}
		};
	}
}

/**
 * Redirects multiple origins to new origins.
 */
class BulkOriginForwarder {
	/**
	 * @param {Array<[string, string]>} pairs - Array of [original, target]
	 */
	constructor(pairs) {
		if (!Array.isArray(pairs) || pairs.length === 0) {
			throw createError({ message: 'BulkOriginForwarder requires a non-empty array of pairs' });
		}
		this.pairs = pairs.map(([orig, target]) => {
			if (typeof orig !== 'string' || typeof target !== 'string') {
				throw createError({ message: 'BulkOriginForwarder pairs must be strings' });
			}
			return {
				orig: orig.replace(/\/$/, ''),
				target: target.replace(/\/$/, ''),
			};
		});
	}

	/**
	 * Returns middleware handler.
	 * @returns {Function}
	 */
	handler() {
		return (req, res, env, ctx, next) => {
			try {
				const incoming = new URL(req.url);
				const incomingOrigin = `${incoming.protocol}//${incoming.host}`;
				for (const { orig, target } of this.pairs) {
					if (incomingOrigin === orig) {
						const redirectUrl = target + incoming.pathname + incoming.search;
						return res.redirect(redirectUrl);
					}
				}
				return next();
			} catch (err) {
				return res.setStatus(500).end(`Internal error in BulkOriginForwarder: ${err.message}`);
			}
		};
	}
}

module.exports = {
	PathForwarder,
	BulkPathForwarder,
	RequestForwarder,
	BulkRequestForwarder,
	OriginForwarder,
	BulkOriginForwarder,
};

//cloudflare-workers-compatible-bulk-forwaders.js
