/**
 * Helper: create standardized errors
 * @param {Object} options
 * @param {string} options.message - Error message
 * @param {number} [options.status=500] - HTTP status code
 * @param {string} [options.code='UNKNOWN_ERROR'] - Error code string
 * @param {number} [options.exit_code=99] - Numeric exit code
 * @param {string} [options.hint] - Optional hint for debugging
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
 * Builder class to construct and send HTTP responses,
 * including support for JSON, text, streams, and CORS.
 */
class ResponseBuilder {
	/**
	 * @param {*} routeDispatcher - Your routing logic reference
	 * @param {*} env - Environment configuration object
	 */
	constructor(routeDispatcher, env) {
		/** @private */
		this._routeDispatcher = routeDispatcher;
		/** @private */
		this._env = env;

		/** @type {number} */
		this.status = 200;
		/** @type {Headers} */
		this.headers = new Headers();
		/** @type {*} */
		this.data = undefined;

		/** @private */
		this._usingStream = false;
		/** @private */
		this._ended = false;
		/** @private */
		this._redirect = false;
		/** @private */
		this._redirectLocation = '';
		/** @private */
		this._redirectCode = 302;

		/** @private TextEncoder and TextDecoder for stream processing */
		this._encoder = new TextEncoder();
		this._decoder = new TextDecoder('utf-8');

		/** @type {ReadableStreamDefaultController|null} */
		this.controller = null;

		/** @private */
		this._stream = null;
		/** @private */
		this._writableStream = null;

		/** @private */
		this._corsEnabled = false;
		/** @private */
		this._corsOrigin = '*';
		/** @private */
		this._corsMethods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
		/** @private */
		this._corsHeaders = 'Content-Type';
		/** @private */
		this._corsCredentials = false;
		this.rawResponse = null;
	}
	get streamReady() {
		return this._usingStream && this.controller !== null;
	}
	/**
	 * Sets the HTTP status code
	 * @param {number} statusCode - HTTP status code to set
	 * @returns {this}
	 */
	status(statusCode) {
		this.status = statusCode;
		return this;
	}
	/**
	 * Sends a response with automatic content type detection
	 * @param {string|Object} [data='OK'] - Response data
	 * @returns {Response|this}
	 */
	send(data = 'OK') {
		this.setStatus(200);
		if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
			return this.stream(data instanceof ArrayBuffer ? new Uint8Array(data) : data, 'application/octet-stream');
		}
		if (typeof data === 'object') return this.sendJSON(data);
		return this.sendText(data);
	}

	/**
	 * Sets the HTTP status code
	 * @param {number} code
	 * @returns {this}
	 */
	setStatus(code) {
		this.status = code;
		return this;
	}

	/**
	 * Sets a header key/value
	 * @param {string} key
	 * @param {string} value
	 * @returns {this}
	 */
	setHeader(key, value) {
		if (typeof key !== 'string' || typeof value !== 'string') {
			throw createError({
				message: 'setHeader() expects both key and value as strings.',
				status: 400,
				code: 'INVALID_HEADER_ARGUMENTS',
				exit_code: 20,
				hint: 'Check header names and values are strings.',
			});
		}
		this.headers.set(key, value);
		return this;
	}

	/**
	 * Appends a header key/value
	 * @param {string} key
	 * @param {string} value
	 * @returns {this}
	 */
	appendHeader(key, value) {
		if (typeof key !== 'string' || typeof value !== 'string') {
			throw createError({
				message: 'appendHeader() expects both key and value as strings.',
				status: 400,
				code: 'INVALID_HEADER_ARGUMENTS',
				exit_code: 21,
				hint: 'Check header names and values are strings.',
			});
		}
		this.headers.append(key, value);
		return this;
	}
	download(name = 'file.txt') {
		this.setHeader('Content-Disposition', `attachment; filename="${name}"`);
		return this;
	}
	fromError(err) {
		const status = err.status || 500;
		const code = err.code || 'INTERNAL_ERROR';
		return this.setStatus(status).json({ error: { code, message: err.message, hint: err.hint } });
	}

	/**
	 * Prepares text response without ending
	 * @param {string} data
	 * @returns {this}
	 */
	text(data) {
		this.setHeader('Content-Type', 'text/plain; charset=utf-8');
		this.data = data;
		return this;
	}

	/**
	 * Prepares JSON response without ending
	 * @param {Object} data
	 * @returns {this}
	 */
	json(data) {
		this.data = data;
		if (!this.headers.has('Content-Type')) {
			this.headers.set('Content-Type', 'application/json');
		}
		return this;
	}

	/**
	 * Immediately sends a text response
	 * @param {string} text
	 * @returns {Response}
	 */
	sendText(text) {
		console.log('text :-', text);
		this.setHeader('Content-Type', 'text/plain; charset=utf-8');
		return this.end(text);
	}

	/**
	 * Immediately sends a JSON response
	 * @param {Object} data
	 * @returns {Response}
	 */
	sendJSON(data) {
		this.headers.set('Content-Type', 'application/json');
		return this.end(data);
	}

	/**
	 * Immediately sends an HTML response
	 * @param {string} html
	 * @returns {Response}
	 */
	sendHTML(html) {
		this.setHeader('Content-Type', 'text/html; charset=utf-8');
		return this.end(html.toString());
	}

	/**
	 * Redirects the client to another location
	 * @param {string} location
	 * @param {number} [code=302]
	 * @returns {this}
	 */
	redirect(location, code = 302) {
		if (typeof location !== 'string') {
			throw createError({
				message: 'redirect() expects location as string.',
				status: 400,
				code: 'INVALID_REDIRECT_ARGUMENT',
				exit_code: 22,
				hint: 'Provide a valid redirect URL string.',
			});
		}
		this._redirect = true;
		this._redirectLocation = location;
		this._redirectCode = code;
		this._ended = true;
		return this;
	}

	/**
	 * Sends an error response
	 * @param {number} [status=500]
	 * @param {string} [message='Internal Server Error']
	 * @returns {Response}
	 */
	error(status = 500, message = 'Internal Server Error') {
		this.setStatus(status);
		return this.sendText(message);
	}

	/**
	 * Ends response with given body
	 * @param {*} [body=null]
	 * @returns {Response}
	 */
	setBody(body) {
		return this.end(body);
	}

	/**
	 * Streams arbitrary content as response
	 * @param {ReadableStream|Uint8Array} body
	 * @param {string} [contentType='application/octet-stream']
	 * @returns {Response}
	 */
	stream(body, contentType = 'application/octet-stream') {
		this.headers.set('Content-Type', contentType);
		return this.end(body);
	}

	/**
	 * Writes a chunk to the stream
	 * @param {string|Uint8Array} chunk
	 * @returns {this}
	 */
	writeChunk(chunk) {
		this._ensureStream();
		if (!this.controller) {
			throw createError({
				message: 'Stream controller not initialized.',
				status: 500,
				code: 'STREAM_NOT_READY',
				exit_code: 23,
				hint: 'Make sure _ensureStream() has been called.',
			});
		}
		let data;
		if (typeof chunk === 'string') {
			data = this._encoder.encode(chunk);
		} else if (chunk instanceof Uint8Array) {
			data = chunk;
		} else {
			throw createError({
				message: 'writeChunk() expects string or Uint8Array.',
				status: 400,
				code: 'INVALID_CHUNK_TYPE',
				exit_code: 24,
				hint: 'Provide chunk as string or Uint8Array.',
			});
		}
		this.controller.enqueue(data);
		return this;
	}

	/**
	 * Write a UTF-8 encoded string chunk to the stream
	 * @param {string} str
	 * @returns {this}
	 */
	writeEncodedChunk(str) {
		this._ensureStream();
		if (!this.controller) {
			throw createError({
				message: 'Stream controller not initialized.',
				status: 500,
				code: 'STREAM_NOT_READY',
				exit_code: 23,
				hint: 'Make sure _ensureStream() has been called.',
			});
		}
		this.controller.enqueue(this._encoder.encode(str));
		return this;
	}

	/**
	 * Write a Uint8Array chunk: decode & re-encode UTF-8 then enqueue
	 * @param {Uint8Array} buffer
	 * @returns {this}
	 */
	writeDecodedChunk(buffer) {
		this._ensureStream();
		if (!this.controller) {
			throw createError({
				message: 'Stream controller not initialized.',
				status: 500,
				code: 'STREAM_NOT_READY',
				exit_code: 23,
				hint: 'Make sure _ensureStream() has been called.',
			});
		}
		const decoded = this._decoder.decode(buffer);
		this.controller.enqueue(this._encoder.encode(decoded));
		return this;
	}

	/**
	 * Returns writable stream interface for piping data into response stream
	 * @returns {WritableStream}
	 */
	get writableStream() {
		this._ensureStream();
		if (!this._writableStream) {
			this._writableStream = new WritableStream({
				write: (chunk) => {
					if (!this.controller) throw new Error('Stream controller missing');
					let data;
					if (typeof chunk === 'string') {
						data = this._encoder.encode(chunk);
					} else if (chunk instanceof Uint8Array) {
						data = chunk;
					} else {
						throw createError({
							message: 'write() expects string or Uint8Array.',
							status: 400,
							code: 'INVALID_CHUNK_TYPE',
							exit_code: 25,
							hint: 'Provide chunk as string or Uint8Array.',
						});
					}
					this.controller.enqueue(data);
				},
				close: () => {
					if (this.controller) this.controller.close();
				},
				abort: (err) => {
					if (this.controller) this.controller.error(err);
				},
			});
		}
		return this._writableStream;
	}

	/**
	 * Ends the response and returns Response object
	 * @param {*} [body=null]
	 * @returns {Response}
	 */
	end(body = null) {
		if (this._ended && this.rawResponse) {
			return this.rawResponse;
		}
		this._ended = true;

		if (this._corsEnabled) {
			this.headers.set('Access-Control-Allow-Origin', this._corsOrigin);
			this.headers.set('Access-Control-Allow-Methods', this._corsMethods);
			this.headers.set('Access-Control-Allow-Headers', this._corsHeaders);
			if (this._corsCredentials) {
				this.headers.set('Access-Control-Allow-Credentials', 'true');
			}
		}

		if (this._redirect) {
			this.headers.set('Location', this._redirectLocation);
			this.rawResponse = new Response(null, {
				status: this._redirectCode,
				headers: this.headers,
			});
		}

		if (this._usingStream && this.controller) {
			if (body) this.writeChunk(body);
			this.controller.close();
			this.rawResponse = new Response(this._stream, {
				status: this.status,
				headers: this.headers,
			});
		}
		let output = '';
		const useData = body !== null ? body : this.data;
		if (typeof Blob !== 'undefined' && useData instanceof Blob) {
			this.rawResponse = new Response(useData, { status: this.status, headers: this.headers });
			return this.rawResponse;
		}
		if (typeof FormData !== 'undefined' && useData instanceof FormData) {
			this.rawResponse = new Response(useData, { status: this.status, headers: this.headers });
			return this.rawResponse;
		}
		if (useData instanceof ArrayBuffer) {
			this.headers.set('Content-Type', 'application/octet-stream');
			this.rawResponse = new Response(new Uint8Array(useData), {
				status: this.status,
				headers: this.headers,
			});
			return this.rawResponse;
		}
		if (useData instanceof Uint8Array) {
			this.headers.set('Content-Type', 'application/octet-stream');
			this.rawResponse = new Response(useData, {
				status: this.status,
				headers: this.headers,
			});
			return this.rawResponse;
		}
		if (typeof useData === 'object') {
			output = JSON.stringify(useData);
			if (!this.headers.has('Content-Type')) {
				this.headers.set('Content-Type', 'application/json');
			}
		} else if (typeof useData === 'string') {
			output = useData;
			if (!this.headers.has('Content-Type')) {
				this.headers.set('Content-Type', 'text/plain; charset=utf-8');
			}
		} else if (useData instanceof Uint8Array) {
			if (!this.headers.has('Content-Type')) {
				this.headers.set('Content-Type', 'application/octet-stream');
			}
		}
		if (!(this.rawResponse instanceof Response)) {
			this.rawResponse = new Response(output || '', {
				status: this.status,
				headers: this.headers,
			});
		}
		return this.rawResponse;
	}

	/**
	 * Initializes internal ReadableStream
	 * @private
	 */
	_ensureStream() {
		if (this._usingStream) return;
		this._usingStream = true;
		this._stream = new ReadableStream({
			start: (controller) => {
				this.controller = controller;
			},
		});
	}

	/**
	 * Enables CORS headers
	 * @param {string} [origin='*']
	 * @param {string} [methods='GET,POST,PUT,PATCH,DELETE,OPTIONS']
	 * @param {string} [headers='Content-Type']
	 * @param {boolean} [credentials=false]
	 * @returns {this}
	 */
	enableCORS(origin = '*', methods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS', headers = 'Content-Type', credentials = false) {
		this._corsEnabled = true;
		this._corsOrigin = origin;
		this._corsMethods = methods;
		this._corsHeaders = headers;
		this._corsCredentials = credentials;
		return this;
	}

	/**
	 * Sets public cache headers
	 * @param {number} [seconds=60]
	 * @returns {this}
	 */
	cachePublic(seconds = 60) {
		this.setHeader('Cache-Control', `public, max-age=${seconds}`);
		return this;
	}

	/**
	 * Sets private cache headers
	 * @param {number} [seconds=0]
	 * @returns {this}
	 */
	cachePrivate(seconds = 0) {
		this.setHeader('Cache-Control', `private, max-age=${seconds}`);
		return this;
	}

	/**
	 * Disables caching
	 * @returns {this}
	 */
	noCache() {
		this.setHeader('Cache-Control', 'no-store');
		return this;
	}

	/**
	 * Adds an X-Flush-Debug header for diagnostics
	 * @returns {this}
	 */
	enableFlushDebug() {
		this.setHeader('X-Flush-Debug', Date.now().toString());
		return this;
	}

	/**
	 * Sets Content-Type by file extension
	 * @param {string} ext
	 * @returns {this}
	 */
	contentType(ext) {
		const map = {
			json: 'application/json',
			txt: 'text/plain; charset=utf-8',
			html: 'text/html; charset=utf-8',
			js: 'application/javascript',
			css: 'text/css',
			xml: 'application/xml',
			svg: 'image/svg+xml',
			png: 'image/png',
			jpg: 'image/jpeg',
			webp: 'image/webp',
		};
		const cleanExt = ext.replace(/^\./, '').toLowerCase();
		if (map[cleanExt]) {
			this.setHeader('Content-Type', map[cleanExt]);
		}
		return this;
	}

	/**
	 * Static helper: Converts a ReadableStream of objects into
	 * a ReadableStream of JSON string lines (each JSON + newline)
	 * @param {ReadableStream} objectStream
	 * @returns {ReadableStream}
	 */
	static toJSONStream(objectStream) {
		const encoder = new TextEncoder();
		const reader = objectStream.getReader();

		return new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
				} catch (err) {
					controller.error(err);
				}
			},
			cancel() {
				reader.cancel();
			},
		});
	}
}

module.exports = { ResponseBuilder };
