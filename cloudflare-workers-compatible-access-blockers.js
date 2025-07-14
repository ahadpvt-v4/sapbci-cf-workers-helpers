/**
 * Creates a standardized error object.
 * @param {Object} options
 * @param {string} options.message - Error message
 * @param {number} [options.status=500]
 * @param {string} [options.code="REQUEST_BLOCKER_ERROR"]
 * @param {number} [options.exit_code=99]
 * @param {string} [options.hint]
 * @returns {Error}
 */
function createError({ message, status = 500, code = 'REQUEST_BLOCKER_ERROR', exit_code = 99, hint }) {
	const e = new Error(message);
	e.status = status;
	e.code = code;
	e.exit_code = exit_code;
	if (hint) e.hint = hint;
	return e;
}
class IpRangeMatcher {
	static ipToNumber(ip) {
		return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
	}

	static isIpInCidr(ip, cidr) {
		const [range, bits = '32'] = cidr.split('/');
		const ipNum = this.ipToNumber(ip);
		const rangeNum = this.ipToNumber(range);
		const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
		return (ipNum & mask) === (rangeNum & mask);
	}

	static isIpInRange(ip, range) {
		const [start, end] = range.split('-').map((x) => x.trim());
		const ipNum = this.ipToNumber(ip);
		const startNum = this.ipToNumber(start);
		const endNum = this.ipToNumber(end);
		return ipNum >= startNum && ipNum <= endNum;
	}

	static matches(ip, pattern) {
		if (!pattern) return false;
		if (pattern === '*') return true;
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(pattern)) return ip === pattern;
		if (pattern.includes('/')) return this.isIpInCidr(ip, pattern);
		if (pattern.includes('-')) return this.isIpInRange(ip, pattern);
		if (pattern.includes('*')) return RequestBlocker.wildcardMatch(ip, pattern);
		return false;
	}
}
class RequestBlocker {
	constructor() {
		this.ipRules = [];
		this.countryRules = [];
		this._globalResponse = null;
	}

	/**
	 * Block IP patterns.
	 * @param {string} pattern - e.g., "192.168.1.*", "10.0.0.1-10.0.0.50", "*"
	 * @param {Object} options
	 * @param {Array<string>|string|null} [options.paths=null] - Paths to block (or null for all)
	 * @param {Function} [options.response] - Custom response handler
	 */
	blockIp(pattern, options = {}) {
		if (typeof pattern !== 'string') {
			throw createError({
				message: 'blockIp(pattern) requires pattern as string.',
				status: 400,
				code: 'INVALID_IP_PATTERN',
				exit_code: 1,
			});
		}
		this.ipRules.push({
			pattern,
			paths: this._normalizePaths(options.paths),
			response: options.response,
		});
		return this;
	}

	/**
	 * Block country codes.
	 * @param {string} pattern - e.g., "CN", "US", "*"
	 * @param {Object} options
	 * @param {Array<string>|string|null} [options.paths=null] - Paths to block (or null for all)
	 * @param {Function} [options.response] - Custom response handler
	 */
	blockCountry(pattern, options = {}) {
		if (typeof pattern !== 'string') {
			throw createError({
				message: 'blockCountry(pattern) requires pattern as string.',
				status: 400,
				code: 'INVALID_COUNTRY_PATTERN',
				exit_code: 2,
			});
		}
		this.countryRules.push({
			pattern,
			paths: this._normalizePaths(options.paths),
			response: options.response,
		});
		return this;
	}

	/**
	 * Sets a fallback response if no per-rule response is configured.
	 * @param {Function} handler
	 */
	setGlobalResponse(handler) {
		if (typeof handler !== 'function') {
			throw createError({
				message: 'setGlobalResponse() requires a function.',
				status: 400,
				code: 'INVALID_GLOBAL_RESPONSE',
				exit_code: 3,
			});
		}
		this._globalResponse = handler;
		return this;
	}

	/**
	 * Main handler
	 * @returns {Function}
	 */
	handler() {
		return async (req, res, env, ctx, next) => {
			const ip = req.request.headers.get('cf-connecting-ip') || req.request.headers.get('x-forwarded-for') || 'unknown';
			const country = req.request.headers.get('cf-ipcountry') || 'XX';
			const url = req.url.pathname;

			// Check IP rules
			for (const rule of this.ipRules) {
				if (IpRangeMatcher.matches(ip, rule.pattern)) {
					if (this._pathMatches(url, rule.paths)) {
						return this._respond(res, rule, { ip, country, url, reason: 'IP' });
					}
				}
			}

			// Check country rules
			for (const rule of this.countryRules) {
				if (RequestBlocker.wildcardMatch(country, rule.pattern)) {
					if (this._pathMatches(url, rule.paths)) {
						return this._respond(res, rule, { ip, country, url, reason: 'Country' });
					}
				}
			}

			// Allow if no match
			return next();
		};
	}

	_respond(res, rule, context) {
		if (typeof rule.response === 'function') {
			return rule.response(res, context);
		}
		if (typeof this._globalResponse === 'function') {
			return this._globalResponse(res, context);
		}
		return res.setStatus(403).send(`Access blocked by RequestBlocker (${context.reason})`);
	}

	_normalizePaths(paths) {
		if (!paths) return null;
		if (typeof paths === 'string') return [paths];
		if (Array.isArray(paths)) return paths;
		throw createError({
			message: 'paths must be string or array.',
			status: 400,
			code: 'INVALID_PATHS',
			exit_code: 4,
		});
	}

	_pathMatches(path, patterns) {
		if (!patterns) return true;
		return patterns.some((p) => RequestBlocker.wildcardMatch(path, p));
	}

	static wildcardToRegex(pattern) {
		const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
		return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
	}

	static wildcardMatch(str, pattern) {
		if (!pattern) return false;
		return this.wildcardToRegex(pattern).test(str);
	}
}
module.exports = { RequestBlocker };
