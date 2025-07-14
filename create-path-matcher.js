function createPathMatcher(pattern) {
	if (typeof pattern !== 'string') {
		throw new Error('Path pattern must be a string');
	}

	const patternParts = pattern.split('/').filter(Boolean);

	function match(pathname) {
		if (typeof pathname !== 'string') {
			throw new Error('pathname must be a string');
		}

		const pathSegments = pathname.split('/').filter(Boolean);

		let params = {};
		let segmentsMap = {};
		let j = 0;
		let i = 0;

		while (i < patternParts.length) {
			const part = patternParts[i];

			if (!part.startsWith(':') && !part.startsWith('*')) {
				if (pathSegments[j] !== part) {
					return null;
				}
				i++;
				j++;
				continue;
			}

			if (part.startsWith(':')) {
				const [paramName, ...forbidden] = part.slice(1).split('!');
				const segmentValue = pathSegments[j];
				if (!segmentValue || forbidden.includes(segmentValue)) {
					return null;
				}
				params[paramName] = segmentValue;
				i++;
				j++;
				continue;
			}

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
					return null;
				}

				const countSpec = wildcardMatch[1];
				const wildcardName = wildcardMatch[2];

				if (countSpec === '') {
					const remaining = pathSegments.slice(j);
					if (wildcardName) segmentsMap[wildcardName] = remaining;
					return { params, segments: segmentsMap };
				}

				let minCount = 0;
				let maxCount = Infinity;
				if (countSpec.includes('-')) {
					const [minStr, maxStr] = countSpec.split('-');
					minCount = parseInt(minStr, 10);
					maxCount = parseInt(maxStr, 10);
				} else {
					maxCount = parseInt(countSpec, 10);
				}

				for (let count = minCount; count <= maxCount; count++) {
					const consumed = pathSegments.slice(j, j + count);
					const remainingSegments = pathSegments.slice(j + count);
					const remainingPattern = patternParts.slice(i + 1);

					const submatch = matchRemaining(remainingPattern, remainingSegments);
					if (submatch) {
						if (wildcardName) segmentsMap[wildcardName] = consumed;
						return {
							params: { ...params, ...submatch.params },
							segments: { ...segmentsMap, ...submatch.segments },
						};
					}
				}

				return null;
			}
		}

		if (j === pathSegments.length) {
			return { params, segments: segmentsMap };
		}

		return null;
	}

	return match;
}

function matchRemaining(patternParts, pathSegments) {
	let params = {};
	let segmentsMap = {};
	let i = 0;
	let j = 0;

	while (i < patternParts.length) {
		const part = patternParts[i];

		if (!part.startsWith(':') && !part.startsWith('*')) {
			if (pathSegments[j] !== part) return null;
			i++;
			j++;
			continue;
		}

		if (part.startsWith(':')) {
			const [paramName, ...forbidden] = part.slice(1).split('!');
			const segmentValue = pathSegments[j];
			if (!segmentValue || forbidden.includes(segmentValue)) return null;
			params[paramName] = segmentValue;
			i++;
			j++;
			continue;
		}

		if (part.startsWith('*')) {
			if (part === '*') {
				const remaining = pathSegments.slice(j);
				// Optionally: segmentsMap['*'] = remaining;
				j = pathSegments.length;
				i = patternParts.length;
				break;
			}
			const wildcardMatch = part.match(/^\*(\d+(?:-\d+)?|)(?::([a-zA-Z_][a-zA-Z0-9_]*)?)$/);
			if (!wildcardMatch) return null;

			const countSpec = wildcardMatch[1];
			const wildcardName = wildcardMatch[2];

			if (countSpec === '') {
				const remaining = pathSegments.slice(j);
				if (wildcardName) segmentsMap[wildcardName] = remaining;
				return { params, segments: segmentsMap };
			}

			let minCount = 0;
			let maxCount = Infinity;
			if (countSpec.includes('-')) {
				const [minStr, maxStr] = countSpec.split('-');
				minCount = parseInt(minStr, 10);
				maxCount = parseInt(maxStr, 10);
			} else {
				maxCount = parseInt(countSpec, 10);
			}

			for (let count = minCount; count <= maxCount; count++) {
				const consumed = pathSegments.slice(j, j + count);
				const remainingPattern = patternParts.slice(i + 1);
				const remainingSegments = pathSegments.slice(j + count);

				const submatch = matchRemaining(remainingPattern, remainingSegments);
				if (submatch) {
					if (wildcardName) segmentsMap[wildcardName] = consumed;
					return {
						params: { ...params, ...submatch.params },
						segments: { ...segmentsMap, ...submatch.segments },
					};
				}
			}

			return null;
		}
	}

	if (j === pathSegments.length) {
		return { params, segments: segmentsMap };
	}
	return null;
}

module.exports = { createPathMatcher, matchRemaining };
