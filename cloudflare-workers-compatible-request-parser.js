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
class RequestParser {
	/**
	 * @param {Request} request - A Fetch API Request instance.
	 * @throws {TypeError} If the provided argument is not a Request.
	 */
	constructor(request) {
		if (!(request instanceof Request)) {
			throw createError({
				message: 'RequestParser expects a Fetch API Request object.',
				code: 'INVALID_REQUEST_INSTANCE',
				exit_code: 100,
				hint: 'Pass a valid instance of the Fetch API Request.',
			});
		}
		/** @private */
		this._request = request;
		/** @private */
		this._parsedBody = undefined;
		/** @private */
		this._bodyUsed = false;
		/** @private */
		this._textEncoder = new TextEncoder();
	}

	/**
	 * Returns the raw Fetch API Request object.
	 * @returns {Request}
	 */
	get request() {
		return this._request;
	}

	/**
	 * Returns the URL object of the request.
	 * @returns {URL}
	 * @throws {Error} If the URL cannot be parsed.
	 */
	get url() {
		try {
			return new URL(this._request.url);
		} catch (e) {
			throw createError({
				message: 'Failed to parse request URL.',
				code: 'INVALID_URL',
				status: 400,
				exit_code: 101,
				hint: 'Ensure the request.url is a valid absolute URL.',
			});
		}
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
	get headers() {
		return this._request.headers;
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
			const obj = Object.fromEntries(form.entries());
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
}

module.exports = { RequestParser };

//cloudflare-workers-compatible-request-parser.js
