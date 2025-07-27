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
	constructor({ targetBaseUrl, fullUrlMode = false, forwardUrl = null, hooks = [] }) {
		if (!targetBaseUrl || typeof targetBaseUrl !== 'string') {
			throw createError({
				message: 'ProxyServer requires a targetBaseUrl string',
				code: 'INVALID_TARGET',
				exit_code: 1,
			});
		}
		this.target = targetBaseUrl.replace(/\/$/, '');
		this.fullUrlMode = fullUrlMode || false;
		this.forwardUrl = forwardUrl;
		this.hooks = hooks || [];
	}

	useHook(fn) {
		if (typeof fn === 'function') this.hooks.push(fn);
	}

	handler() {
		return async (req, res, env, ctx, next) => {
			try {
				const incomingUrl = new URL(req.url);
				let forwardUrl;

				if (this.fullUrlMode) {
					forwardUrl = this.target;
				} else {
					let newPath = incomingUrl.pathname;
					forwardUrl = this.target + (newPath.startsWith('/') ? newPath : '/' + newPath) + incomingUrl.search;
					if (typeof this.forwardUrl === 'function') {
						forwardUrl = this.forwardUrl(this.target, newPath, incomingUrl);
					}
				}

				let requestBody = ['GET', 'HEAD'].includes(req.rawRequest.method) ? undefined : req.rawRequest.body;

				const outgoingHeaders = new Headers(req.rawRequest.headers);
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
				for (const h of hopByHopHeaders) {
					outgoingHeaders.delete(h);
				}

				const fetchInit = {
					method: req.rawRequest.method,
					headers: outgoingHeaders,
					body: requestBody,
					redirect: 'manual',
				};
				for (const hook of this.hooks) {
					const hookResult = await hook(req, res, env, ctx);
					if (hookResult) {
						const { method, headers, body, redirect } = hookResult;
						if (method) {
							fetchInit.method = method;
						}
						if (headers) {
							for (const [k, v] of Object.entries(headers)) {
								fetchInit.headers.set(k, v);
							}
						}
						if (body) {
							fetchInit.body = body;
						}
						if (redirect) {
							fetchInit.redirect = redirect;
						}
					}
				}
				const proxiedResponse = await fetch(forwardUrl, fetchInit);
				req.upstreamResponse = proxiedResponse;

				if (req.autoProxyPassthrough) {
					const responseHeaders = new Headers(proxiedResponse.headers);
					for (const h of hopByHopHeaders) responseHeaders.delete(h);

					return new Response(proxiedResponse.body, {
						status: proxiedResponse.status,
						statusText: proxiedResponse.statusText,
						headers: responseHeaders,
					});
				}

				return next();
			} catch (err) {
				return res.setStatus(500).sendText(`ProxyServer error: ${err.message}`);
			}
		};
	}
}

module.exports = { ProxyServer };
