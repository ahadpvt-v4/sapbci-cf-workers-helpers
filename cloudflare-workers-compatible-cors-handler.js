/**
 * Helper: create standardized errors
 * @param {Object} params
 * @param {string} params.message - Error message
 * @param {number} [params.status=500] - HTTP status
 * @param {string} [params.code='UNKNOWN_ERROR'] - Error code
 * @param {number} [params.exit_code=99] - Exit code
 * @param {string} [params.hint] - Optional hint
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'UNKNOWN_ERROR', exit_code = 99, hint = undefined }) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	error.exit_code = exit_code;
	if (hint) error.hint = hint;
	return error;
}

/**
 * CORS middleware for handling Cross-Origin Resource Sharing headers.
 */
class Cors {
	/**
	 * @param {Object} [options={}] - CORS options
	 * @param {string} [options.origin='*'] - Allowed origin
	 * @param {string[]|string} [options.methods=['GET','POST','PUT','DELETE','PATCH','OPTIONS']] - Allowed methods
	 * @param {string[]|string} [options.headers=['Content-Type']] - Allowed headers
	 * @param {boolean} [options.credentials=false] - Whether credentials are allowed
	 * @param {number} [options.maxAge=86400] - Max age for preflight caching
	 */
	constructor(options = {}) {
		/** @type {Object} */
		this.defaults = {
			origin: '*',
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
			headers: ['Content-Type'],
			credentials: false,
			maxAge: 86400,
			...options,
		};

		/** @private @type {Set<string>} */
		this.customMethods = new Set();
		// If origin is a function, store it:
		this.originFn = typeof this.defaults.origin === 'function' ? this.defaults.origin : null;
	}

	/**
	 * Adds a custom HTTP method to the allowed methods
	 * @param {string} methodName - Method name to allow
	 * @returns {Cors}
	 * @throws {Error} If methodName is not a string
	 */
	addMethod(methodName) {
		if (typeof methodName !== 'string') {
			throw createError({
				message: 'addMethod() expects methodName as string.',
				status: 400,
				code: 'INVALID_ARGUMENT',
				exit_code: 1,
				hint: 'Provide a valid HTTP method name as string.',
			});
		}
		this.customMethods.add(methodName.toUpperCase());
		return this;
	}

	/**
	 * Computes the final comma-separated list of allowed methods
	 * @returns {string}
	 */
	getAllowedMethods() {
		const builtIn = Array.isArray(this.defaults.methods) ? this.defaults.methods : this.defaults.methods.split(',').map((m) => m.trim());

		return [...new Set([...builtIn, ...this.customMethods])].join(',');
	}

	/**
	 * Returns an async handler function to use in middleware pipelines
	 * @returns {Function} Middleware handler
	 */
	handler() {
		return async (req, res, env, ctx, next) => {
			const { origin, headers, credentials, maxAge } = this.defaults;

			const methods = this.getAllowedMethods();

			if (!req || !req.request || typeof req.request.method !== 'string') {
				throw createError({
					message: 'Invalid request object passed to Cors handler.',
					status: 500,
					code: 'INVALID_REQUEST_OBJECT',
					exit_code: 2,
					hint: 'Ensure your middleware pipeline provides a valid RequestParser-like object.',
				});
			}

			if (!res || typeof res.setHeader !== 'function' || typeof res.setStatus !== 'function' || typeof res.end !== 'function') {
				throw createError({
					message: 'Invalid response object passed to Cors handler.',
					status: 500,
					code: 'INVALID_RESPONSE_OBJECT',
					exit_code: 3,
					hint: 'Ensure your middleware pipeline provides a valid ResponseBuilder-like object.',
				});
			}
			if (req.request.method === 'OPTIONS') {
				res
					.setHeader('Access-Control-Allow-Origin', '*')
					.setHeader('Access-Control-Allow-Methods', methods)
					.setHeader('Access-Control-Allow-Headers', Array.isArray(headers) ? headers.join(',') : String(headers))
					.setHeader('Access-Control-Max-Age', String(maxAge));

				if (credentials) {
					res.setHeader('Access-Control-Allow-Credentials', 'true');
				}
				return res.setStatus(204).end();
			}

			const originHeader = req.headers.origin;

			let allowOrigin = '*';
			if (this.originFn) {
				allowOrigin = this.originFn(originHeader) ? originHeader : 'null';
			} else {
				allowOrigin = this.defaults.origin;
			}

			res
				.setHeader('Access-Control-Allow-Origin', allowOrigin)
				.setHeader('Access-Control-Allow-Methods', methods)
				.setHeader('Access-Control-Allow-Headers', Array.isArray(headers) ? headers.join(',') : String(headers));

			if (credentials) {
				res.setHeader('Access-Control-Allow-Credentials', 'true');
			}

			return await next();
		};
	}
}

module.exports = { Cors };

//cloudflare-workers-compatible-cors-handler.js
