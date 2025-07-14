/**
 * Helper to create standardized structured errors
 * @param {Object} params
 * @param {string} params.message - Error message
 * @param {number} [params.status=500] - HTTP status code
 * @param {string} [params.code='UNKNOWN_ERROR'] - Error code identifier
 * @param {number} [params.exit_code=99] - Exit code for the process
 * @param {string} [params.hint] - Optional hint for developers
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'UNKNOWN_ERROR', exit_code = 99, hint }) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	error.exit_code = exit_code;
	if (hint) error.hint = hint;
	return error;
}

/**
 * Creates a middleware that replicates the incoming request to multiple destinations.
 *
 * @param {Object} config - Configuration object
 * @param {Array<{
 *   url: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   modifyRequest?: (params: {
 *     request: Request,
 *     env: any,
 *     ctx: any
 *   }) => Promise<BodyInit|undefined>|BodyInit|undefined
 * }>} config.targets - Array of replication configurations
 * @param {string[]} [config.preserveHeaders=[]] - List of header names to preserve without deleting (e.g., "content-length", "host")
 * @param {boolean} [config.parallel=true] - Whether to replicate in parallel
 * @param {boolean} [config.waitForAll=true] - Whether to wait for all requests to complete before proceeding
 * @param {boolean} [config.ignoreErrors=true] - Whether to ignore fetch errors
 * @returns {Function} Middleware function
 */
function RequestReplicator({ targets, preserveHeaders = [], parallel = true, waitForAll = true, ignoreErrors = true }) {
	if (!Array.isArray(targets)) {
		throw createError({
			message: 'RequestReplicator requires "targets" as an array.',
			status: 500,
			code: 'INVALID_CONFIG_TARGETS',
			exit_code: 41,
			hint: 'Ensure "targets" is an array of replication targets.',
		});
	}

	/**
	 * Middleware handler function
	 *
	 * @param {Object} req - Request context
	 * @param {Object} res - Response context
	 * @param {any} env - Environment bindings
	 * @param {any} ctx - Execution context
	 * @param {Function} next - Next middleware function
	 * @returns {Promise<void>}
	 */
	return async function replicatorMiddleware(req, res, env, ctx, next) {
		const replicationTasks = [];

		for (const target of targets) {
			const { url, method, headers = {}, modifyRequest } = target;

			if (typeof url !== 'string') {
				throw createError({
					message: 'Each target must have a valid "url" string.',
					status: 500,
					code: 'INVALID_TARGET_URL',
					exit_code: 42,
					hint: 'Check your replication target object contains a valid string "url".',
				});
			}

			const finalMethod = (method || req.request.method).toUpperCase();

			const replicationTask = (async () => {
				let body = req.request.body;

				// Allow modifying the request body
				if (typeof modifyRequest === 'function') {
					const modifiedBody = await modifyRequest({ request: req.request, env, ctx });
					if (modifiedBody !== undefined) {
						body = modifiedBody;
					}
				}

				// Clone headers
				const outHeaders = new Headers(req.request.headers);

				// Remove standard headers unless they are explicitly preserved
				const headersToDelete = ['host', 'content-length'];
				for (const h of headersToDelete) {
					if (!preserveHeaders.includes(h)) {
						outHeaders.delete(h);
					}
				}

				// Apply custom headers
				for (const [k, v] of Object.entries(headers)) {
					outHeaders.set(k, v);
				}

				const init = {
					method: finalMethod,
					headers: outHeaders,
					body: ['GET', 'HEAD'].includes(finalMethod) ? undefined : body,
				};

				return await fetch(url, init);
			})();

			replicationTasks.push(replicationTask);
		}

		if (parallel) {
			if (waitForAll) {
				if (ignoreErrors) {
					await Promise.allSettled(replicationTasks);
				} else {
					await Promise.all(replicationTasks);
				}
			} else {
				for (const task of replicationTasks) {
					ctx.waitUntil(task.catch(() => {}));
				}
			}
		} else {
			for (const task of replicationTasks) {
				try {
					await task;
				} catch (err) {
					if (!ignoreErrors) throw err;
				}
			}
		}

		return next();
	};
}

module.exports = { RequestReplicator };

//cloudflare-workers-compatible-middleware-request-replicator.js
