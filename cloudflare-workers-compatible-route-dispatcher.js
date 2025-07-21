import { RequestParser } from './cloudflare-workers-compatible-request-parser';
import { ResponseBuilder } from './cloudflare-workers-compatible-response-builder';
/**
 * A global registry to store routes by HTTP method.
 * @type {Map<string, Array<{path: string, middlewares : Array<Function>;  options : Object handler: (Function|null)}>>}
 */
const GLOBAL_ROUTES_REGISTRY = new Map();

/**
 * In-memory key-value storage used internally by RouteDispatcher.
 * @type {Map<string, any>}
 */

/**
 * Creates a standardized Error object with additional properties.
 * @param {Object} options
 * @param {string} options.message - Error message.
 * @param {number} [options.status=500] - HTTP status code.
 * @param {string} [options.code='UNKNOWN_ERROR'] - Custom error code.
 * @param {number} [options.exit_code=99] - Numeric exit code.
 * @param {string} [options.hint] - Optional hint message.
 * @returns {Error & {status: number, code: string, exit_code: number, hint?: string}}
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
 * Proxies an incoming request to a specified external URL.
 * Copies headers except 'host' and 'content-length', preserves method and body.
 * @param {string} method - HTTP method (e.g., 'GET', 'POST').
 * @param {string} url - Target URL with protocol (http:// or https://).
 * @param {Request} originalRequest - Original Fetch API Request object.
 * @returns {Promise<Response>} Response from the proxied request.
 * @throws Throws if arguments are invalid or fetch fails.
 */
async function forwardCustomRequest(method, url, originalRequest) {
	if (
		typeof method !== 'string' ||
		typeof url !== 'string' ||
		typeof originalRequest !== 'object' ||
		typeof originalRequest.headers !== 'object'
	) {
		throw createError({
			message: `Invalid argument types.\nExpected:\n- method: string\n- url: string\n- originalRequest: object with headers.\nReceived:\n- method: ${typeof method}\n- url: ${typeof url}\n- originalRequest: ${typeof originalRequest}`,
			status: 400,
			code: 'ERROR_INVALID_ARGUMENTS',
			exit_code: 1,
			hint: 'Check that all arguments are correctly typed and not undefined.',
		});
	}

	const isValidUrl = /^(https?|ftp):\/\//i.test(url);
	if (!isValidUrl) {
		throw createError({
			message: 'Invalid or missing protocol in URL (e.g., must start with http:// or https://)',
			status: 400,
			code: 'ERROR_INVALID_URL',
			exit_code: 2,
			hint: 'Provide a valid URL string including the protocol.',
		});
	}

	const target = new URL(url);
	const originalUrl = new URL(originalRequest.url);
	if (originalUrl.search) {
		target.search = originalUrl.search;
	}

	const headers = {};
	for (const [key, value] of originalRequest.headers.entries()) {
		if (!['host', 'content-length'].includes(key.toLowerCase())) {
			headers[key] = value;
		}
	}

	const init = {
		method: method.toUpperCase(),
		headers,
		duplex: 'half',
	};

	if (!['GET', 'HEAD'].includes(init.method)) {
		init.body = originalRequest.body;
	}

	try {
		return await fetch(target.toString(), init);
	} catch (err) {
		throw createError({
			message: `Fetch failed: ${err.message}`,
			status: 502,
			code: 'ERROR_FETCH_FAILED',
			exit_code: 10,
			hint: 'Check network connectivity and target server availability.',
		});
	}
}
class Resolver {
	constructor() {
		this._resolvedValues = new Map();
		this._promisedValues = new Map();
		this._pendingLoads = new Map();
	}

	delete(key) {
		this._resolvedValues.delete(key);
		this._promisedValues.delete(key);
		this._pendingLoads.delete(key);
	}

	clear() {
		this._resolvedValues.clear();
		this._promisedValues.clear();
		this._pendingLoads.clear();
	}

	async get(key) {
		const loaderEntry = this._promisedValues.get(key);
		const resolvedEntry = this._resolvedValues.get(key);

		if (resolvedEntry) {
			if (loaderEntry && typeof loaderEntry.purge === 'function' && (await loaderEntry.purge(resolvedEntry.value))) {
				return await this.reload(key);
			}
			if (resolvedEntry.value !== null) return resolvedEntry.value;
		}

		if (!resolvedEntry) return null;

		if (loaderEntry) {
			if (this._pendingLoads.has(key)) {
				return await this._pendingLoads.get(key);
			}

			const promise = this._loadAndResolve(key, loaderEntry);
			this._pendingLoads.set(key, promise);
			return await promise;
		}

		return null;
	}

	add(object = null) {
		if (object && object.value && object.key) {
			if (typeof object.value === 'function' && Object.prototype.toString.call(object.value) === '[object AsyncFunction]') {
				this._promisedValues.set(object.key, {
					value: object.value,
					Adapter: object.Adapter || null,
					purge: object.purge || null,
				});
				this._resolvedValues.set(object.key, {
					key: object.key,
					Adapter: object.Adapter || null,
					value: null,
				});
			} else {
				this._resolvedValues.set(object.key, {
					key: object.key,
					Adapter: object.Adapter || null,
					value: object.value,
				});
			}
		}
		return object;
	}

	async reload(key) {
		const loaderEntry = this._promisedValues.get(key);
		if (!loaderEntry) return null;

		if (this._pendingLoads.has(key)) {
			return await this._pendingLoads.get(key);
		}

		const promise = this._loadAndResolve(key, loaderEntry);
		this._pendingLoads.set(key, promise);
		return await promise;
	}

	async _loadAndResolve(key, loaderEntry) {
		const value = await loaderEntry.value();
		const adapted = loaderEntry.Adapter ? new loaderEntry.Adapter(value) : value;
		this._resolvedValues.set(key, {
			key,
			Adapter: loaderEntry.Adapter || null,
			value: adapted,
		});
		this._pendingLoads.delete(key);
		return adapted;
	}
}

/**
 * Class to manage route registration, matching, and request dispatching.
 */
class RouteDispatcher {
	/**
	 * Creates a new RouteDispatcher instance.
	 */

	constructor() {
		this._securityHeaders = {};
		this._errorHandler = null;
		this.middlewares = [];
		this.routes = new Map();
	}
	useGlobalRegistry() {
		this.routes = GLOBAL_ROUTES_REGISTRY; // method -> [{ path, handler }]
	}
	dissociate() {
		this.routes = new Map();
	}
	associate(routes) {
		this.routes = routes;
	}
	/**
	 * Proxies all matching requests to a target URL, optionally slicing the path.
	 *
	 * @param {string} path - Path pattern to match.
	 * @param {string} targetUrl - Target base URL.
	 * @param {Object} [options] - Optional behavior modifiers.
	 * @param {string} [options.sliceStart] - Segment after which to start retaining path.
	 * @param {string} [options.sliceStop] - Segment before which to stop retaining path.
	 * @returns {RouteDispatcher}
	 */
	proxy(path, targetUrl, sliceStart, sliceStop) {
		return this.get(path, async (req) => {
			const url = new URL(targetUrl);

			const segments = req.url.pathname.split('/').filter(Boolean);

			let startIdx = 0;
			let endIdx = segments.length;

			if (sliceStart) {
				const idx = segments.indexOf(sliceStart);
				if (idx >= 0) startIdx = idx + 1; // skip sliceStart itself
			}

			if (sliceStop) {
				const idx = segments.indexOf(sliceStop);
				if (idx >= 0) endIdx = idx; // stop before sliceStop
			}

			const slicedPath = '/' + segments.slice(startIdx, endIdx).join('/');

			url.pathname = slicedPath;
			url.search = req.url.search;

			return fetch(url.toString(), {
				method: req.method,
				headers: req.rawRequest.headers,
				body: req.method !== 'GET' && req.method !== 'HEAD' ? req.rawRequest.body : undefined,
			});
		});
	}

	/**
	 * Rewrites the request URL before dispatching.
	 * @param {string} path - Path to match.
	 * @param {string} newPath - New path to replace.
	 * @returns {RouteDispatcher}
	 */
	rewrite(path, newPath) {
		return this.get(path, async (req, res, env, ctx, next) => {
			req.url = new URL(req.url.origin + newPath);
			return next();
		});
	}

	/**
	 * Mounts a sub-router at a path prefix.
	 * @param {string} prefix - Path prefix.
	 * @param {RouteDispatcher} subrouter - Another RouteDispatcher instance.
	 * @returns {RouteDispatcher}
	 */
	mount(prefix, subrouter) {
		if (!(subrouter instanceof RouteDispatcher)) {
			throw createError({
				message: 'Subrouter must be a RouteDispatcher instance.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
			});
		}

		for (const [method, routes] of subrouter.routes.entries()) {
			const parentRoutes = this.routes.get(method) || [];
			const updatedRoutes = routes.map((route) => {
				const { path } = route;
				let fullPath;

				if (path === '/') {
					fullPath = prefix;
				} else if (prefix.endsWith('/') && path.startsWith('/')) {
					fullPath = prefix + path.slice(1);
				} else if (!prefix.endsWith('/') && !path.startsWith('/')) {
					fullPath = `${prefix}/${path}`;
				} else {
					fullPath = prefix + path;
				}

				// Clone route object with adjusted path
				return { ...route, path: fullPath };
			});

			this.routes.set(method, parentRoutes.concat(updatedRoutes));
		}

		return this;
	}

	/**
	 * Sets security headers to be applied to all responses.
	 * @param {Object} headers - Key-value pairs of headers.
	 * @returns {RouteDispatcher}
	 */
	setSecurityHeaders(headers) {
		this._securityHeaders = headers || {};
		return this;
	}

	/**
	 * Groups multiple routes under a common path prefix.
	 * @param {string} prefix - The path prefix (e.g., "/api/v1").
	 * @param {Function} callback - Function receiving a temporary dispatcher.
	 * @returns {RouteDispatcher} Self for chaining.
	 */
	group(prefix, callback) {
		if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
			throw createError({
				message: 'Group prefix must be a string starting with "/".',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Example: .group("/api/v1", fn)',
			});
		}
		if (typeof callback !== 'function') {
			throw createError({
				message: 'Group callback must be a function.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Pass a function that receives the group dispatcher.',
			});
		}

		// Provide a helper to auto-prefix paths
		const self = this;
		const grouped = {
			group(_prefix, callback) {
				return self.group(`${prefix}${_prefix}`, callback);
			},
			get(path, ...args) {
				return self.get(`${prefix}${path}`, ...args);
			},
			post(path, ...args) {
				return self.post(`${prefix}${path}`, ...args);
			},
			put(path, ...args) {
				return self.put(`${prefix}${path}`, ...args);
			},
			delete(path, ...args) {
				return self.delete(`${prefix}${path}`, ...args);
			},
			head(path, ...args) {
				return self.head(`${prefix}${path}`, ...args);
			},
			all(path, ...args) {
				return self.all(`${prefix}${path}`, ...args);
			},
			use(...args) {
				return self.use(...args);
			},
		};
		callback(grouped);

		return this;
	}

	/**
	 * Processes an incoming request, matches a route, and executes middleware and handler.
	 * @param {Request} request - Incoming Fetch API Request.
	 * @param {Object} env - Environment bindings.
	 * @param {Object} ctx - Context for waitUntil and other Cloudflare Workers features.
	 * @returns {Promise<Response>} The HTTP response.
	 */
	async respond(request, env, ctx) {
		if (typeof request !== 'object') {
			throw createError({
				message: 'Invalid request argument: expected a Request object.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Ensure you are passing a Fetch API Request instance.',
			});
		}

		const url = new URL(request.url);
		const method = request.method.toLowerCase();
		const pathname = url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : url.pathname;

		if (request.method === 'OPTIONS') {
			const res = new ResponseBuilder().setStatus(204).enableCORS();
			return res.end();
		}

		const match = this.matchRoute(method, pathname);
		if (!match) {
			return new Response(`Not found: ${method.toUpperCase()} ${pathname}`, { status: 404 });
		}

		const res = new ResponseBuilder(this, env);

		let req;
		try {
			req = new RequestParser(request, match);
		} catch (err) {
			throw createError({
				message: 'Failed while initiating a Request: ' + err.message,
				status: 500,
				code: 'REQUEST_INIT_FAILED',
				exit_code: 15,
				hint: 'Verify the request body and headers are properly structured.',
			});
		}
		// Automatic validation if configured
		if (match.options && match.options.validate) {
			const { validate } = match.options;
			if (validate.body && typeof validate.body.safeParse === 'function') {
				const parsed = validate.body.safeParse(await req.body());
				if (!parsed.success) {
					return new Response(JSON.stringify({ error: 'Invalid request body', issues: parsed.error }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				req.validatedBody = parsed.data;
			}
			if (validate.query && typeof validate.query.safeParse === 'function') {
				const parsed = validate.query.safeParse(req.queryString);
				if (!parsed.success) {
					return new Response(JSON.stringify({ error: 'Invalid query parameters', issues: parsed.error }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				req.validatedQuery = parsed.data;
			}
		}

		const routeMiddlewares = Array.isArray(match.middlewares) ? match.middlewares : [];
		const allMiddlewares = [...this.middlewares, ...routeMiddlewares];
		const composed = this.compose(allMiddlewares, async (req, res, env, ctx, next) => {
			return match.handler(req, res, env, ctx, next);
		});

		return composed(req, res, env, ctx)
			.then((result) => {
				let finalResponse;
				if (result instanceof Response) {
					finalResponse = new Response(result.body, {
						status: result.status,
					});
				} else if (result instanceof ResponseBuilder) finalResponse = result.end();
				else if (res._ended) finalResponse = res.rawResponse;
				else if (result && result.constructor === Object) {
					console.log(result);
					return new Response(JSON.stringify(result), { status: 200 });
				} else if (result instanceof Error) {
					finalResponse = new Response(JSON.stringify(result), { status: 500 });
				}

				if (!finalResponse) {
					return new Response(null, { status: 204 });
				}

				let newHeaders = new Headers(finalResponse.headers);

				// Inject security headers
				for (const [k, v] of Object.entries(this._securityHeaders)) {
					newHeaders.set(k, v);
				}

				return new Response(finalResponse.body, { headers: newHeaders, status: finalResponse.status });
			})
			.catch((err) => {
				if (typeof this._errorHandler === 'function') {
					try {
						const handled = this._errorHandler(err, req, res, env, ctx);
						if (handled instanceof Promise) return handled;
						if (handled instanceof Response) return handled;
					} catch (handlerError) {
						console.error('Error handler threw:', handlerError);
					}
				}
				console.error('Unhandled error:', err);
				return new Response(
					JSON.stringify({
						error: err.message,
						code: err.code || 'UNKNOWN_ERROR',
						hint: err.hint || undefined,
						exit_code: err.exit_code || undefined,
					}),
					{
						status: err.status || 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			});
	}
	/**
	 * Adds a middleware function or middleware object with a handler method.
	 * @param {Function|Object} middleware - Middleware function or object with handler().
	 * @returns {RouteDispatcher} Returns self for chaining.
	 * @throws Throws if the middleware is invalid.
	 */
	use(middleware) {
		if (typeof middleware === 'function') {
			this.middlewares.push(middleware);
		} else if (middleware && typeof middleware.handler === 'function') {
			this.middlewares.push(middleware.handler());
		} else {
			throw createError({
				message: '.use() expects a function or an object with handler().',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Pass either a middleware function or an object with handler().',
			});
		}
		return this;
	}
	/**
	 * Sets a global error handler function.
	 * @param {Function} fn - Error handler accepting (error, req, res, env, ctx).
	 * @returns {RouteDispatcher} Returns self for chaining.
	 */
	onError(fn) {
		this._errorHandler = fn;
		return this;
	}
	/**
	 * Matches a registered route for the given method and pathname.
	 * Supports named parameters, wildcards, and forbidden values.
	 * @param {string} method - HTTP method (lowercase).
	 * @param {string} pathname - Request pathname.
	 * @returns {Object|null} Matched route info with handler, params, segments, wildcards or null if no match.
	 * @throws Throws on invalid argument types.
	 */
	matchRoute(method, pathname) {
		if (typeof method !== 'string' || typeof pathname !== 'string') {
			throw createError({
				message: 'Invalid method/pathname arguments: both must be strings.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Ensure method and pathname are string values.',
			});
		}

		const candidates = this.routes.get(method) || [];
		const pathSegments = pathname.split('/').filter(Boolean);

		for (const { path, handler, middlewares } of candidates) {
			if (path === pathname || path === '*') {
				return { handler, params: {}, segments: {}, wildcards: [], middlewares };
			}

			const patternParts = path.split('/').filter(Boolean);

			let params = {};
			let segmentsMap = {};
			let j = 0; // index in pathSegments
			let i = 0; // index in patternParts
			let matchFailed = false;

			while (i < patternParts.length) {
				const part = patternParts[i];

				// Literal
				if (!part.startsWith(':') && !part.startsWith('*')) {
					if (pathSegments[j] !== part) {
						matchFailed = true;
						break;
					}
					i++;
					j++;
					continue;
				}

				// Named parameter with optional forbidden values
				if (part.startsWith(':')) {
					const [paramName, ...forbidden] = part.slice(1).split('!');

					if (!pathSegments[j]) {
						matchFailed = true;
						break;
					}

					const segmentValue = pathSegments[j];

					if (forbidden.includes(segmentValue)) {
						matchFailed = true;
						break;
					}

					params[paramName] = segmentValue;
					i++;
					j++;
					continue;
				}

				// Wildcard
				if (part.startsWith('*')) {
					// Special case: plain "*"
					if (part === '*') {
						const remaining = pathSegments.slice(j);
						// Optionally: segmentsMap['*'] = remaining;
						j = pathSegments.length;
						i = patternParts.length;
						break;
					}
					const wildcardMatch = part.match(/^\*(\d+(?:-\d+)?|)(?::([a-zA-Z_][a-zA-Z0-9_]*)?)$/);
					if (!wildcardMatch) {
						matchFailed = true;
						break;
					}

					const countSpec = wildcardMatch[1];
					const wildcardName = wildcardMatch[2];

					// Special case: plain "*" (no min/max) = match rest
					if (countSpec === '') {
						const remainingSegments = pathSegments.slice(j);
						if (wildcardName) {
							segmentsMap[wildcardName] = remainingSegments;
						}
						// Since * with no count consumes all remaining segments, stop processing
						j = pathSegments.length;
						i = patternParts.length;
						break;
					}

					// Parse min/max count
					let minCount = 0;
					let maxCount = Infinity;
					if (countSpec.includes('-')) {
						const [minStr, maxStr] = countSpec.split('-');
						minCount = parseInt(minStr, 10);
						maxCount = parseInt(maxStr, 10);
					} else {
						maxCount = parseInt(countSpec, 10);
					}

					let matched = false;
					// Try all possible counts within range
					for (let count = minCount; count <= maxCount; count++) {
						const consumed = pathSegments.slice(j, j + count);
						const remainingPattern = patternParts.slice(i + 1);
						const remainingSegments = pathSegments.slice(j + count);

						// Recursively match remaining pattern to remaining segments
						const submatch = this._matchRemaining(remainingPattern, remainingSegments);
						if (submatch.success) {
							if (wildcardName) {
								segmentsMap[wildcardName] = consumed;
							}
							// Merge submatch results
							params = { ...params, ...submatch.params };
							segmentsMap = { ...segmentsMap, ...submatch.segments };
							j += count + submatch.jIncrement;
							i = patternParts.length; // end loop
							matched = true;
							break;
						}
					}

					if (!matched) {
						matchFailed = true;
						break;
					}
				}
			}

			if (!matchFailed && j === pathSegments.length) {
				return { handler, params, segments: segmentsMap, wildcards: [], middlewares };
			}
		}

		return null;
	}
	_matchRemaining(patternParts, pathSegments) {
		let params = {};
		let segmentsMap = {};
		let i = 0;
		let j = 0;

		while (i < patternParts.length) {
			const part = patternParts[i];

			// Literal
			if (!part.startsWith(':') && !part.startsWith('*')) {
				if (pathSegments[j] !== part) {
					return { success: false };
				}
				i++;
				j++;
				continue;
			}

			if (part.startsWith(':')) {
				const [paramName, ...forbidden] = part.slice(1).split('!');

				if (!pathSegments[j]) {
					return { success: false };
				}

				const segmentValue = pathSegments[j];

				if (forbidden.includes(segmentValue)) {
					return { success: false };
				}

				params[paramName] = segmentValue;
				i++;
				j++;
				continue;
			}

			// Wildcard in nested match (catch-all)
			if (part.startsWith('*')) {
				if (part === '*') {
					const remaining = pathSegments.slice(j);
					// Optionally: segmentsMap['*'] = remaining;
					j = pathSegments.length;
					i = patternParts.length;
					break;
				}
				const wildcardMatch = part.match(/^\*(\d+(?:-\d+)?|)(?::([a-zA-Z_][a-zA-Z0-9_]*)?)$/);
				if (!wildcardMatch) {
					return { success: false };
				}
				const countSpec = wildcardMatch[1];
				const wildcardName = wildcardMatch[2];

				if (countSpec === '') {
					// Catch-all wildcard
					const remaining = pathSegments.slice(j);
					if (wildcardName) {
						segmentsMap[wildcardName] = remaining;
					}
					return {
						success: true,
						params,
						segments: segmentsMap,
						jIncrement: remaining.length,
					};
				}

				// Parse min/max
				let minCount = 0;
				let maxCount = Infinity;
				if (countSpec.includes('-')) {
					const [minStr, maxStr] = countSpec.split('-');
					minCount = parseInt(minStr, 10);
					maxCount = parseInt(maxStr, 10);
				} else {
					maxCount = parseInt(countSpec, 10);
				}

				// Try all counts
				for (let count = minCount; count <= maxCount; count++) {
					const consumed = pathSegments.slice(j, j + count);
					const subRemaining = pathSegments.slice(j + count);
					const subPattern = patternParts.slice(i + 1);
					const submatch = this._matchRemaining(subPattern, subRemaining);
					if (submatch.success) {
						if (wildcardName) {
							segmentsMap[wildcardName] = consumed;
						}
						return {
							success: true,
							params: { ...params, ...submatch.params },
							segments: { ...segmentsMap, ...submatch.segments },
							jIncrement: count + (submatch.jIncrement || 0),
						};
					}
				}

				return { success: false };
			}
		}

		if (j === pathSegments.length) {
			return { success: true, params, segments: segmentsMap, jIncrement: 0 };
		}
		return { success: false };
	}
	/**
	 * Composes an array of middleware functions into a single callable chain.
	 * @param {Function[]} middlewares - Array of middleware functions.
	 * @param {Function} finalHandler - Final handler function after middleware.
	 * @returns {Function} Composed middleware executor function.
	 * @throws Throws if arguments are invalid.
	 */
	compose(middlewares, finalHandler) {
		if (typeof middlewares !== 'object') {
			throw createError({
				message: 'Invalid middlewares argument: must be iterable.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Pass an array or iterable of middleware functions.',
			});
		}
		if (typeof finalHandler !== 'function') {
			throw createError({
				message: 'Invalid finalHandler argument: must be a function.',
				status: 400,
				code: 'ERROR_INVALID_ARGUMENTS',
				exit_code: 1,
				hint: 'Provide a function as the final handler.',
			});
		}
		return async function execute(req, res, env, ctx) {
			let index = -1;
			async function dispatch(i) {
				if (i <= index) throw new Error('next() called multiple times');
				index = i;
				const fn = i === middlewares.length ? finalHandler : middlewares[i];
				if (!fn) return;
				return await fn(req, res, env, ctx, () => dispatch(i + 1));
			}
			return await dispatch(0);
		};
	}

	/**
	 * Registers a handler for a specific HTTP methods and path.
	 * @param {Array<string>} methodNames - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	methods(methodNames, path, predicate, maybeHandler) {
		for (const method of methodNames) {
			this._registerRoute(method, path, predicate, maybeHandler);
		}
		return this;
	}
	/**
	 * Registers a GET route.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	get(path, predicate, maybeHandler) {
		return this._registerRoute('get', path, predicate, maybeHandler);
	}
	/**
	 * Registers a POST route.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	post(path, predicate, maybeHandler) {
		return this._registerRoute('post', path, predicate, maybeHandler);
	}
	/**
	 * Registers a PUT route.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */

	put(path, predicate, maybeHandler) {
		return this._registerRoute('put', path, predicate, maybeHandler);
	}
	/**
	 * Registers a DELETE route.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	delete(path, predicate, maybeHandler) {
		return this._registerRoute('delete', path, predicate, maybeHandler);
	}
	/**
	 * Registers a HEAD route.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	head(path, predicate, maybeHandler) {
		return this._registerRoute('head', path, predicate, maybeHandler);
	}
	/**
	 * Registers a route for all HTTP methods.
	 * @param {string} method - HTTP method (e.g., 'get', 'post').
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function|Object|Array} predicate - Either:
	 *   - the handler function,
	 *   - an array of middleware functions,
	 *   - or an options object (e.g., { validate }).
	 * @param {Function} [maybeHandler] - The handler function if predicate is middlewares or options.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws {TypeError} Throws if path is invalid.
	 */
	all(path, predicate, maybeHandler) {
		const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
		for (const method of methods) {
			this._registerRoute(method, path, predicate, maybeHandler);
		}
		return this;
	}

	/**
	 * Internal method to register a route handler.
	 * @param {string} method - HTTP method.
	 * @param {string} path - Route path starting with '/'.
	 * @param {Function} handler - Handler function.
	 * @returns {RouteDispatcher} Self for chaining.
	 * @throws Throws if path is invalid.
	 */
	_registerRoute(method, path, predicate, maybeHandler) {
		if (typeof path !== 'string' || !path.startsWith('/')) {
			throw new TypeError(`Route path must be a string starting with "/". Received: ${path}`);
		}
		method = method.toLowerCase();
		if (!this.routes.has(method)) this.routes.set(method, []);

		let handler,
			middlewares = [],
			options = {};
		if (Array.isArray(predicate)) {
			middlewares = predicate.map((middleware) => {
				if ('function' === typeof middleware.handler) return middleware.handler();
				return middleware;
			});
			handler = maybeHandler;
		} else if (typeof predicate === 'object' && predicate !== null && !Array.isArray(predicate)) {
			options = predicate;
			handler = maybeHandler;
		} else {
			handler = predicate;
		}

		const route = { path, handler, middlewares, options, method };
		this.routes.get(method).push(route);

		return this;
	}
}

module.exports = { RouteDispatcher, Resolver };

// cloudflare-workers-compatible-route-dispatcher.js
