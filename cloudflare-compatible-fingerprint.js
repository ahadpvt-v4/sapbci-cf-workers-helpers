async function fingerprint(req, res, env, ctx, next) {
	const h = req.headers;
	req.client = {
		ip: h['cf-connecting-ip'] || h['x-forwarded-for'] || null,
		country: h['cf-ipcountry'] || null,
		region: h['cf-region'] || null,
		city: h['cf-city'] || null,
		continent: h['cf-continent'] || null,
		latitude: h['cf-latitude'] || null,
		longitude: h['cf-longitude'] || null,
		timezone: h['cf-timezone'] || null,
		userAgent: h['user-agent'] || null,
		language: h['accept-language'] || null,
		accept: h['accept'] || null,
		referer: h['referer'] || null,
		origin: h['origin'] || null,
		tlsVersion: h['cf-tls-version'] || null,
		tlsCipher: h['cf-tls-cipher'] || null,
		rayId: h['cf-ray'] || null,
	};
	await next();
}

module.exports = {
	fingerprint,
};
