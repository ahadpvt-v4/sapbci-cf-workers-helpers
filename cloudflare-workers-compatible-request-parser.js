/**
 * Utility to create rich, developer-friendly errors.
 * @param {Object} options
 * @param {string} options.message - Error message.
 * @param {number} [options.status=400] - HTTP status code.
 * @param {string} [options.code='BAD_REQUEST'] - Error code string.
 * @param {number} [options.exit_code=1] - Numeric exit code for internal use.
 * @param {string} [options.hint=''] - Optional hint for debugging.
 * @returns {Error}
 */
function createError({ message, status = 400, code = 'BAD_REQUEST', exit_code = 1, hint = '' }) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	error.exit_code = exit_code;
	if (hint) error.hint = hint;
	return error;
}

/**
 * A helper class to parse Fetch API Request objects into
 * usable forms: text, JSON, form data, query parameters, etc.
 */
/**
 * A utility class for parsing and handling Fetch API Request objects in a Cloudflare Workers-compatible environment.
 * Provides convenient accessors and methods for headers, query parameters, route segments, body parsing, and more.
 *
 * @class
 * @example
 * const parser = new RequestParser(request, routeMatcher);
 * const params = parser.params;
 * const body = await parser.json();
 */
class RequestParser {
	/**
	 * @param {Request} request - A Fetch API Request instance.
	 * @throws {TypeError} If the provided argument is not a Request.
	 */
	constructor(originalRequest, routeMatcher = null) {
		if (!(originalRequest instanceof Request)) {
			throw createError({
				message: 'RequestParser expects a Fetch API Request object.',
				code: 'INVALID_REQUEST_INSTANCE',
				exit_code: 100,
				hint: 'Pass a valid instance of the Fetch API Request.',
			});
		}
		/** @private */
		this._request = originalRequest;
		/** @private */
		this._originalHeaders = new Headers(originalRequest.headers);
		/** @private */
		this._rawHeaders = this._originalHeaders.entries();
		/** @private */
		this._headers = Object.fromEntries(this._rawHeaders.map(([key, value]) => [key.toLowerCase(), value]));

		/** @private */
		this._rawBody = this._request.body;
		/** @private */
		this._parsedBody = undefined;
		/** @private */
		this._bodyUsed = false;
		/** @private */
		this._textEncoder = new TextEncoder();
		/**
		 * Accessing the request URL.
		 */
		this.url = this._request.url;
		/**
		 * Accessing the request URL Object.
		 */
		this.urlObject = new URL(this._request.url);
		/**
		 * Parsed query parameters from the URL.
		 * This is an object where keys are parameter names and values are their values.
		 * @type {Object.<string,string>}
		 */
		this.queryParams = Object.fromEntries(this.urlObject.searchParams.entries());
		/**
		 * 	Alias for queryParams for compatibility with older code
		 * Parsed query parameters from the URL.
		 * This is an object where keys are parameter names and values are their values.
		 * @type {Object.<string,string>}
		 */

		this.parsedQuery = this.queryParams;
		/** @private */
		this._routeMatcher = routeMatcher;
	}

	/**
	 * Returns the segments of the route matcher.
	 * @returns {Array<string>}
	 * @throws {Error} If the route matcher is not defined.
	 */
	get segments() {
		if (!this._routeMatcher) {
			throw createError({
				message: 'Route matcher is not defined.',
				code: 'ROUTE_MATCHER_NOT_DEFINED',
				exit_code: 109,
				hint: 'Ensure you provide a route matcher when creating RequestParser.',
			});
		}
		return this._routeMatcher.segments;
	}
	/**
	 * Returns the route parameters extracted from the URL.
	 * @returns {Object.<string,string>}
	 */
	get params() {
		if (!this._routeMatcher) {
			throw createError({
				message: 'Route matcher is not defined.',
				code: 'ROUTE_MATCHER_NOT_DEFINED',
				exit_code: 109,
				hint: 'Ensure you provide a route matcher when creating RequestParser.',
			});
		}
		return this._routeMatcher.params;
	}
	/**
	 * Returns the wildcard segments extracted from the URL.
	 * @returns {Array<string>}
	 */
	get wildcards() {
		if (!this._routeMatcher) {
			throw createError({
				message: 'Route matcher is not defined.',
				code: 'ROUTE_MATCHER_NOT_DEFINED',
				exit_code: 109,
				hint: 'Ensure you provide a route matcher when creating RequestParser.',
			});
		}
		return this._routeMatcher.wildcards;
	}
	/**
	 * Returns the headers of the request.
	 * @returns {Headers}
	 */
	get headers() {
		return this._headers;
	}
	/**
	 * Returns the raw Fetch API Request object.
	 * @returns {Request}
	 */
	get rawRequest() {
		return this._request;
	}
	/**
	 * Returns the original request object.
	 * This is an alias for rawRequest.
	 * @returns {Request}
	 */
	get request() {
		return this._request;
	}
	/**
	 * Alias for rawRequest.
	 * @returns {Request}
	 * @deprecated Use rawRequest instead.
	 * @throws {Error} If the request is not a valid Fetch API Request.
	 */
	get originalRequest() {
		return this._request;
	}
	/**
	 *
	 */
	get pathname() {
		return this.urlObject.pathname;
	}
	/**
	 * Returns the HTTP method in lowercase.
	 * @returns {string}
	 */
	get method() {
		return this._request.method.toLowerCase();
	}

	/**
	 * Returns the headers of the request.
	 * @returns {Headers}
	 */
	get originalHeaders() {
		return this._originalHeaders;
	}
	/**
	 * Return rawHeaders of the orignal request
	 * @returns {Array<Array>}
	 */
	get rawHeaders() {
		return this._rawHeaders;
	}
	/**
	 * Return hash of url
	 * @returns {Number}
	 */
	get hash() {
		const hash = this.urlObject.hash.slice(1) || null;
		return hash;
	}
	get queryString() {
		return this.query();
	}
	/**
	 * Parses query string parameters into an object.
	 * @returns {Object.<string,string>}
	 */
	query() {
		try {
			return Object.fromEntries(this.url.searchParams.entries());
		} catch (err) {
			throw createError({
				message: 'Failed to parse query string from URL.',
				code: 'QUERY_PARSE_FAILED',
				exit_code: 102,
				hint: 'Make sure request.url is a valid URL.',
			});
		}
	}

	/**
	 * Returns the body as an ArrayBuffer.
	 * @returns {Promise<ArrayBuffer>}
	 */
	async arrayBuffer() {
		if (this._bodyUsed) return this._parsedBody;
		try {
			const buf = await this._request.arrayBuffer();
			this._parsedBody = buf;
			this._bodyUsed = true;
			return buf;
		} catch (err) {
			throw createError({
				message: 'Failed to parse body as ArrayBuffer.',
				code: 'BODY_ARRAYBUFFER_FAILED',
				status: 422,
				exit_code: 103,
			});
		}
	}

	/**
	 * Returns the body as a string.
	 * @returns {Promise<string>}
	 */
	async text() {
		if (this._bodyUsed) {
			if (typeof this._parsedBody === 'string') return this._parsedBody;
			if (this._parsedBody instanceof Uint8Array || this._parsedBody instanceof ArrayBuffer) {
				return new TextDecoder().decode(this._parsedBody);
			}
		}
		try {
			const txt = await this._request.text();
			this._parsedBody = txt;
			this._bodyUsed = true;
			return txt;
		} catch (err) {
			throw createError({
				message: 'Failed to read body as text.',
				code: 'BODY_TEXT_FAILED',
				status: 422,
				exit_code: 104,
			});
		}
	}

	/**
	 * Returns the body parsed as JSON.
	 * @returns {Promise<Object>}
	 */
	async json() {
		if (this._bodyUsed) {
			if (typeof this._parsedBody === 'object') return this._parsedBody;
			if (typeof this._parsedBody === 'string') {
				try {
					return JSON.parse(this._parsedBody);
				} catch (e) {
					throw createError({
						message: 'Failed to parse cached body as JSON.',
						code: 'CACHED_JSON_PARSE_ERROR',
						status: 422,
						exit_code: 105,
					});
				}
			}
		}
		try {
			const obj = await this._request.json();
			this._parsedBody = obj;
			this._bodyUsed = true;
			return obj;
		} catch (err) {
			throw createError({
				message: 'Failed to parse body as JSON.',
				code: 'BODY_JSON_PARSE_FAILED',
				status: 422,
				exit_code: 106,
				hint: 'Ensure the Content-Type is application/json and body is valid JSON.',
			});
		}
	}

	/**
	 * Returns the body parsed as form data.
	 * @returns {Promise<Object.<string,string>>}
	 */
	async formData() {
		if (this._bodyUsed) return this._parsedBody;
		try {
			const form = await this._request.formData();
			const obj = {};
			for (const key of form.keys()) {
				const all = form.getAll(key);
				obj[key] = all.length > 1 ? all : all[0];
			}
			this._parsedBody = obj;
			this._bodyUsed = true;
			return obj;
		} catch (err) {
			throw createError({
				message: 'Failed to parse body as FormData.',
				code: 'BODY_FORMDATA_PARSE_FAILED',
				status: 422,
				exit_code: 107,
			});
		}
	}

	/**
	 * Auto-detects and parses the body based on Content-Type.
	 * @returns {Promise<any>}
	 */
	async body() {
		if (this._bodyUsed) return this._parsedBody;

		const contentType = this._request.headers.get('content-type') || '';

		try {
			if (contentType.includes('application/json')) {
				return await this.json();
			}
			if (contentType.includes('application/x-www-form-urlencoded')) {
				return await this.formData();
			}
			if (contentType.includes('text/')) {
				return await this.text();
			}
			if (contentType.includes('multipart/form-data')) {
				return await this.formData();
			}
			// fallback to raw bytes
			return await this.arrayBuffer();
		} catch (err) {
			throw createError({
				message: 'Auto body parser failed based on content-type.',
				code: 'BODY_AUTO_PARSE_FAILED',
				status: 422,
				exit_code: 108,
				hint: 'Check if the body matches the declared content-type.',
			});
		}
	}
	/**
	 * Returns the raw ReadableStream of the body.
	 * Note: This stream can only be consumed once.
	 * @returns {ReadableStream}
	 */
	stream() {
		if (this._bodyUsed) {
			throw createError({
				message: 'The body has already been consumed.',
				code: 'BODY_ALREADY_USED',
				status: 400,
				exit_code: 110,
				hint: 'Streams can only be read once. Use .tee() to split.',
			});
		}
		this._bodyUsed = true;
		return this._request.body;
	}
	/**
	 * Returns two cloned ReadableStreams of the body.
	 * This allows you to read the body twice independently.
	 * @returns {[ReadableStream, ReadableStream]}
	 */
	tee() {
		if (this._bodyUsed) {
			throw createError({
				message: 'The body has already been consumed.',
				code: 'BODY_ALREADY_USED',
				status: 400,
				exit_code: 111,
				hint: 'Streams can only be read once. Use .tee() before reading.',
			});
		}
		if (!this._request.body) {
			throw createError({
				message: 'The request has no body stream.',
				code: 'BODY_STREAM_MISSING',
				status: 400,
				exit_code: 112,
			});
		}
		const streams = this._request.body.tee();
		this._bodyUsed = true;
		this._parsedBody = null;
		return streams;
	}
}

module.exports = { RequestParser };

//cloudflare-workers-compatible-request-parser.js
