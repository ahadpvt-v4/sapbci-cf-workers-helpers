class HostMatcher {
	constructor({ map = {}, fallback = null, perMethod = false } = {}) {
		this.map = map; // Can be exact host or wildcard base
		this.fallback = fallback;
		this.perMethod = perMethod;
	}

	resolveTarget(host, method) {
		// Exact match
		if (this.perMethod && this.map[method] && this.map[method][host]) {
			return this.map[method][host];
		}
		if (!this.perMethod && this.map[host]) {
			return this.map[host];
		}

		// Wildcard DNS-style match: *.domain.com
		for (const key of Object.keys(this.perMethod ? this.map[method] ?? {} : this.map)) {
			if (key.startsWith('*')) {
				const suffix = key.slice(1); // remove '*'
				if (host.endsWith(suffix)) {
					return this.perMethod ? this.map[method][key] : this.map[key];
				}
			}
		}

		// Fallback
		return this.fallback;
	}

	handler() {
		return async (req, res, env, ctx, next) => {
			const host = req.rawRequest.headers.get('host')?.toLowerCase() || '';
			const method = req.method.toLowerCase();

			const targetBase = this.resolveTarget(host, method);

			if (targetBase) {
				const originalUrl = new URL(req.rawRequest.url);
				const targetUrl = new URL(targetBase);
				targetUrl.pathname = originalUrl.pathname;
				targetUrl.search = originalUrl.search;

				const proxyRequest = new Request(targetUrl.toString(), {
					method: req.rawRequest.method,
					headers: req.rawRequest.headers,
					body: req.rawRequest.body,
					redirect: 'manual',
				});

				const proxyResponse = await fetch(proxyRequest);
				return proxyResponse;
			}

			return next(); // no match, continue
		};
	}
}

module.exports = { HostMatcher };
