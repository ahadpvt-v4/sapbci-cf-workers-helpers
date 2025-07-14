function createError({ message, status = 500, code = 'PROXY_SERVER_ERROR', exit_code = 1, hint }) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.exit_code = exit_code;
	if (hint) e.hint = hint;
	return e;
}

/**
 * ProxyServer: Middleware to forward requests transparently to a target server,
 * with proper streaming, header management, and passthrough support.
 */
class ProxyServer {
	/**
	 * @param {string} targetBaseUrl - e.g., "https://api.example.com"
	 */
	constructor(targetBaseUrl, sliceStart, sliceStop) {
		if (!targetBaseUrl || typeof targetBaseUrl !== 'string') {
			throw createError({
				message: 'ProxyServer requires a targetBaseUrl string',
				code: 'INVALID_TARGET',
				exit_code: 1,
			});
		}
		this.target = targetBaseUrl.replace(/\/$/, '');
		this.sliceStart = sliceStart;
		this.sliceStop = sliceStop;
	}

	handler() {
		return async (req, res, env, ctx, next) => {
			console.log('~~~~');
			try {
				const incomingUrl = new URL(req.url);
				let newPath = incomingUrl.pathname;

				// If sliceStart configured: remove everything before it
				if (this.sliceStart) {
					const startIndex = newPath.indexOf(`/${this.sliceStart}`);
					if (startIndex !== -1) {
						newPath = newPath.slice(startIndex + this.sliceStart.length + 1);
					}
				}

				// If sliceStop configured: remove everything after it
				if (this.sliceStop) {
					const endIndex = newPath.indexOf(`/${this.sliceStop}`);
					if (endIndex !== -1) {
						newPath = newPath.slice(0, endIndex);
					}
				}
				console.log(newPath);
				const forwardUrl = this.target + (newPath.startsWith('/') ? newPath : '/' + newPath) + incomingUrl.search;

				// Clone and clean headers for fetch
				const outgoingHeaders = new Headers(req.rawRequest.headers);
				// Remove hop-by-hop headers per RFC 2616 Sec 13.5.1
				const hopByHopHeaders = [
					'connection',
					'keep-alive',
					'proxy-authenticate',
					'proxy-authorization',
					'te',
					'trailer',
					'transfer-encoding',
					'upgrade',
					'host',
				];
				for (const h of hopByHopHeaders) outgoingHeaders.delete(h);

				// Setup fetch options
				const fetchInit = {
					method: req.rawRequest.method,
					headers: outgoingHeaders,
					body: ['GET', 'HEAD'].includes(req.rawRequest.method) ? undefined : req.rawRequest.body,
					redirect: 'manual', // don't auto-follow redirects
				};

				// Issue fetch request
				const proxiedResponse = await fetch(forwardUrl, fetchInit);

				// Attach upstream raw response for possible later manual handling
				req.upstreamResponse = proxiedResponse;

				// If auto passthrough flag is set, respond immediately with upstream response
				if (req.autoProxyPassthrough) {
					// Filter hop-by-hop headers again for response
					const responseHeaders = new Headers(proxiedResponse.headers);
					for (const h of hopByHopHeaders) responseHeaders.delete(h);

					// Return a streaming Response to client
					return new Response(proxiedResponse.body, {
						status: proxiedResponse.status,
						statusText: proxiedResponse.statusText,
						headers: responseHeaders,
					});
				}

				// Otherwise, defer to next middleware or manual handling
				return next();
			} catch (err) {
				// Use res interface to set status and send error text
				return res.setStatus(500).sendText(`ProxyServer error: ${err.message}`);
			}
		};
	}
}

module.exports = { ProxyServer };

//cloudflare-workers-compatible-proxy-server.js
