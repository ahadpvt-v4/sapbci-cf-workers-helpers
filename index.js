import { fingerprint } from './cloudflare-compatible-fingerprint';
import { RouteDispatcher } from './cloudflare-workers-compatible-route-dispatcher';
import { randomIntVal, randomStringVal, generateAesKeyBase64 } from './random-stuff';
import { encryptResponse, decryptRequest } from './cloudflare-compatible-encryption-utils';
import { Cors } from './cloudflare-workers-compatible-cors-handler';
const dataTransferEncyptionLocationKeysPrefix = 'iwill_dataTransferEncryptionKeys_for_';
const userLoginDataLocationPrefix = 'iwill_userLoginData_for_';
const userMasterKeyDataPrefix = 'iwill_userMasterKeyData__for_';
const apiServer = new RouteDispatcher();
apiServer.use(
	new Cors({
		origin: (origin) => {
			if (!origin) return false;
			try {
				const url = new URL(origin);
				return url.hostname === 'tikmix.site' || url.hostname.endsWith('.tikmix.site');
			} catch {
				return false;
			}
		},
	})
);

apiServer.group('/iwill/data-transfer/revoke/encyption', (revokeRouter) => {
	revokeRouter.all('/*', revokeDataTransferEncryptionKeys);
});
apiServer.post('/user/register', handleClientRegister);
apiServer.post('/user/login', handleClientLogin);
apiServer.post('/master-key/verify/:masterKeyId', handleVerifyMasterKey);
apiServer.post('/master-key/revoke/:masterKeyId', handleMasterRevoke);
apiServer.post('/user/reset/:masterKeyId', handleReset);
async function handleReset(req, res, env, ctx) {
	const dateNow = Date.now();
	const { masterKeyId: reqMasterKeyId } = req.params;

	const { data, success, error, code, uniqueEncId } = await toDecryptedRequestData(req, res, env);

	if (!success) {
		return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
	} else {
		const { success, error, code } = await verifyMasterKeyData(reqMasterKeyId, data, env);

		if (!success) {
			return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
		}

		const {
			username: usernameRaw,
			password: passwordRaw,
			currentUsername: currentUsernameRaw,
			currentPassword: currentPasswordRaw,
			publicKeyRaw,
		} = data;
		if (!currentPasswordRaw || !currentPasswordRaw) {
			return res.enableCORS().setStatus(400).sendJSON({
				success: false,
				error: 'Both current username and password are required to reset anyone of them',
				code: 'CREDENTIALS_REQUIRED',
			});
		}

		let newUsername = usernameRaw ? usernameRaw.trim() : null;
		let newPassword = passwordRaw ? passwordRaw.trim() : null;
		const currentPassword = currentPasswordRaw.trim();
		const currentUsername = currentUsername.trim();

		if (newUsername || newPassword) {
			try {
				const userLoginDataLocation = `${userLoginDataLocationPrefix}${currentUsername}_.json`;
				const existingUserRaw = await env.USER_DATA_TIKMIX_R2_BUCKET.get(userLoginDataLocation);

				if (!existingUserRaw) {
					return res.enableCORS().setStatus(404).sendJSON({ success: false, error: 'Username not found', code: 'USERNAME_UNREGISTERED' });
				}

				const existingUserJSON = await existingUserRaw.json();
				if (currentPassword !== existingUserJSON.password) {
					return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid password', code: 'REQUEST_UNAUTHORISED' });
				}
				const username = newUsername ? newUsername : existingUserJSON.username;
				const password = newPassword ? newPassword : existingUserJSON.password;
				if (!username || username.length < 3 || username.length > 32) {
					return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid Username length', code: 'INVALID_USER_DATA' });
				}
				if (password && password.length < 8) {
					return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid password length', code: 'INVALID_USER_DATA' });
				}
				const publicKeyFromUser = existingUserJSON.publicKey;
				if (publicKeyRaw.trim() !== publicKeyFromUser) {
					return res.enableCORS().setStatus(403).sendJSON({
						success: false,
						error: 'Master key does not belong to this user',
						code: 'FORBIDDEN',
					});
				}
				await env.USER_DATA_TIKMIX_R2_BUCKET.put(
					userLoginDataLocation,
					JSON.stringify({
						...existingUserJSON,
						username,
						password,
						publicKey: publicKeyFromUser,
						updatedAt: dateNow,
					})
				);

				const { responseEncryptionKey } = await getDataTransferEncryptionKeys(uniqueEncId, env);

				const encryptedResponse = await encryptResponse(
					JSON.stringify({ success: true, username, publicKey: publicKeyFromUser, updatedAt: dateNow }),
					responseEncryptionKey
				);

				res.setStatus(200).end(encryptedResponse);
			} catch (error) {
				return res
					.enableCORS()
					.setStatus(500)
					.sendJSON({ success: false, error: 'Failed to reset user data', code: 'FAILED_TO_RESET_USER_DATA' });
			}
		} else {
			return res.enableCORS().setStatus(500).sendJSON({ success: false, error: 'Cannot reset void', code: 'CANNOT_RESET_VOID_ARGS' });
		}
	}
}
async function handleMasterRevoke(req, res, env, ctx) {
	const dateNow = Date.now();
	const { masterKeyId: reqMasterKeyId } = req.params;

	const { data, success, error, code, uniqueEncId } = await toDecryptedRequestData(req, res, env);

	if (!success) {
		return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
	} else {
		const { success, error, code, publicKey } = await verifyMasterKeyData(reqMasterKeyId, data, env);

		if (!success) {
			return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
		}

		const masterKeyId = randomIntVal();
		const userMasterKeyDataLocation = `${userMasterKeyDataPrefix}${masterKeyId}_.json`;
		const masterKeySecret = randomStringVal(true, 128);
		const masterKeyCreatedAt = dateNow;
		const masterKeyExpiryAt = dateNow + 3600000;

		await env.USER_DATA_TIKMIX_R2_BUCKET.put(
			userMasterKeyDataLocation,
			JSON.stringify({ publicKey, masterKeyId, masterKeySecret, expiryAt: masterKeyExpiryAt, createdAt: masterKeyCreatedAt })
		);

		const { responseEncryptionKey } = await getDataTransferEncryptionKeys(uniqueEncId, env);

		const encryptedResponse = await encryptResponse(
			JSON.stringify({ success: true, masterKeyId, masterKeySecret, publicKey, masterKeyCreatedAt, masterKeyExpiryAt }),
			responseEncryptionKey
		);

		await env.USER_DATA_TIKMIX_R2_BUCKET.delete(`${userMasterKeyDataPrefix}${reqMasterKeyId}_.json`);

		res.setStatus(200).end(encryptedResponse);
	}
}
async function handleVerifyMasterKey(req, res, env, ctx) {
	const { masterKeyId } = req.params;

	const { data, success, error, code, uniqueEncId } = await toDecryptedRequestData(req, res, env);
	if (!success) {
		return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
	} else {
		const { success, error, code } = await verifyMasterKeyData(masterKeyId, data, env);
		if (!success) {
			res.enableCORS().setStatus(500).sendJSON({ success, error, code });
		}
		res.setStatus(200).sendJSON({ sucess: true, masterKeyId });
	}
	res.enableCORS().setStatus(500).sendJSON({ error: 'INTERNAL SERVER ERROR' });
}
async function verifyMasterKeyData(masterKeyId, data, env) {
	const dateNow = Date.now();
	if (data) {
		const { masterKeySecret } = extractUserData(data);

		if (!masterKeySecret) {
			return { success: false, error: 'Invalid or Empty credentials', code: 'IMPROPER_CREDENTIALS' };
		}

		const userMasterKeyDataLocation = `${userMasterKeyDataPrefix}${masterKeyId}_.json`;
		const storedMasterKeyRaw = await env.USER_DATA_TIKMIX_R2_BUCKET.get(userMasterKeyDataLocation);

		if (!storedMasterKeyRaw) {
			return { success: false, error: 'Master key not found or expired', code: 'INVALID_MASTER_KEY_ID' };
		}

		const storedMasterKeyJSON = await storedMasterKeyRaw.json();

		const { masterKeySecret: storedMasterKeySecret, publicKey, expiryAt } = storedMasterKeyJSON;

		if (masterKeySecret !== storedMasterKeySecret) {
			return { success: false, error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' };
		}

		if (expiryAt < dateNow) {
			await env.USER_DATA_TIKMIX_R2_BUCKET.delete(userMasterKeyDataLocation);

			return { success: false, error: 'Invalid or Expired credentials', code: 'INVALID_CREDENTIALS' };
		}
		return { success: true, publicKey };
	}
	return { success: false, error: 'Invalid User Input', code: 'INVALID_USER_INPUT' };
}
async function handleClientLogin(req, res, env, ctx) {
	const dateNow = Date.now();
	const { data, success, error, code, uniqueEncId } = await toDecryptedRequestData(req, res, env);

	if (!success) {
		return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
	} else if (data) {
		const {
			username: usernameRaw,
			password: passwordRaw,
			success: extractSuccess,
			error: extractError,
			code: extractCode,
		} = extractUserData(data);

		const username = usernameRaw.trim();
		const password = passwordRaw.trim();

		if (!extractSuccess) {
			return res.enableCORS().setStatus(400).sendJSON({ success: extractSuccess, error: extractError, code: extractCode });
		}

		if (!username || username.length < 3 || username.length > 32) {
			return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid or empty username', code: 'INVALID_USER_DATA' });
		}

		if (!password || password.length < 8 || username.length > 16) {
			return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid password length', code: 'INVALID_USER_DATA' });
		}

		try {
			const userLoginDataLocation = `${userLoginDataLocationPrefix}${username}_.json`;

			const existingUserRaw = await env.USER_DATA_TIKMIX_R2_BUCKET.get(userLoginDataLocation);

			if (!existingUserRaw) {
				return res.enableCORS().setStatus(404).sendJSON({ success: false, error: 'Username not found', code: 'USERNAME_UNREGISTERED' });
			}

			const existingUserJSON = await existingUserRaw.json();

			const { password: storedPassword, publicKey, privateKey } = existingUserJSON;

			if (password !== storedPassword) {
				return res
					.enableCORS()
					.setStatus(400)
					.sendJSON({ success: false, error: 'Wrong username or password', code: 'INCORRECT_PASSWORD' });
			}

			const masterKeyId = randomIntVal();
			const userMasterKeyDataLocation = `${userMasterKeyDataPrefix}${masterKeyId}_.json`;
			const masterKeySecret = randomStringVal(true, 128);
			const masterKeyCreatedAt = dateNow;
			const masterKeyExpiryAt = dateNow + 3600000;

			await env.USER_DATA_TIKMIX_R2_BUCKET.put(
				userMasterKeyDataLocation,
				JSON.stringify({ publicKey, masterKeyId, masterKeySecret, expiryAt: masterKeyExpiryAt, createdAt: masterKeyCreatedAt })
			);

			const { responseEncryptionKey } = await getDataTransferEncryptionKeys(uniqueEncId, env);

			const encryptedResponse = await encryptResponse(
				JSON.stringify({ success: true, masterKeyId, masterKeySecret, publicKey, masterKeyCreatedAt, masterKeyExpiryAt }),
				responseEncryptionKey
			);

			res.setStatus(200).end(encryptedResponse);
		} catch (error) {
			return res.enableCORS().setStatus(500).sendJSON({ success: false, error: 'Failed to login user', code: 'FAILED_TO_GET_USER_DATA' });
		}
	}
}
async function handleClientRegister(req, res, env, ctx) {
	const dateNow = Date.now();
	const { data, success, error, code, uniqueEncId } = await toDecryptedRequestData(req, res, env);

	if (!success) {
		return res.enableCORS().setStatus(500).sendJSON({ success, error, code });
	} else if (data) {
		const {
			username: usernameRaw,
			password: passwordRaw,
			success: extractSuccess,
			error: extractError,
			code: extractCode,
		} = extractUserData(data);

		const username = usernameRaw.trim();
		const password = passwordRaw.trim();
		const publicKey = randomStringVal(true, 32, 'pub_');
		const privatekey = randomStringVal(true, 64, 'sec_');

		if (!extractSuccess) {
			return res.enableCORS().setStatus(400).sendJSON({ success: extractSuccess, error: extractError, code: extractCode });
		}

		if (!username || username.length < 3 || username.length > 32) {
			return res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid or empty username', code: 'INVALID_USER_DATA' });
		}

		if (!password || password.length < 8 || username.length > 16) {
			res.enableCORS().setStatus(400).sendJSON({ success: false, error: 'Invalid password length', code: 'INVALID_USER_DATA' });
		}

		try {
			const userLoginDataLocation = `${userLoginDataLocationPrefix}${username}_.json`;
			const existingUserRaw = await env.USER_DATA_TIKMIX_R2_BUCKET.get(userLoginDataLocation);

			if (existingUserRaw) {
				return res
					.setStatus(400)
					.sendJSON({ success: false, error: 'A user with this username already exists', code: 'USERNAME_IS_AQUIRED' });
			}

			await env.USER_DATA_TIKMIX_R2_BUCKET.put(
				userLoginDataLocation,
				JSON.stringify({ username, password, publicKey, privatekey, createdAt: dateNow })
			);
		} catch (error) {
			return res
				.enableCORS()
				.setStatus(500)
				.sendJSON({ success: false, error: 'Failed to register user data', code: 'FAILED_TO_PUT_USER_DATA' });
		}

		const { responseEncryptionKey } = await getDataTransferEncryptionKeys(uniqueEncId, env);

		const encryptedResponse = await encryptResponse(
			JSON.stringify({ success: true, username, publicKey, privatekey, createdAt: dateNow }),
			responseEncryptionKey
		);

		res.setStatus(200).end(encryptedResponse);
	}
}

function extractUserData(rawData) {
	const { data, success, error, code } = parseJSON(rawData);

	if (!success) {
		return { success, error, code };
	}
	return {
		success: true,
		error,
		code,
		...data,
	};
}
async function toDecryptedRequestData(req, res, env) {
	let decryptedRequestData;
	const { data, success, error, code } = await toReqJSON(req, res);

	if (!success) {
		return { success, error, code };
	}

	const { uniqueEncId, encryptedRequestData } = data;

	const {
		requestEncryptionKey,
		success: getKeySuccess,
		error: getKeyError,
		code: getKeyCode,
	} = await getDataTransferEncryptionKeys(uniqueEncId, env, res);

	if (!getKeySuccess) {
		return { error: getKeyError, code: getKeyCode, success: getKeySuccess };
	}

	try {
		decryptedRequestData = await decryptRequest(encryptedRequestData, requestEncryptionKey);
	} catch (error) {
		return { success: false, error, code: 'REQUEST_DECRYPTION_FAILED' };
	}

	return { success: true, data: decryptedRequestData, uniqueEncId };
}
async function toReqJSON(req, res) {
	try {
		const reqJSON = await req.json();
		return { data: reqJSON, success: true };
	} catch (error) {
		return { success: false, error, code: 'TO_JSON_DECRYPTION_FAILED' };
	}
}
async function getDataTransferEncryptionKeys(uniqueEncId, env) {
	const dateNow = Date.now();
	const dataTransferEncryptionKeysLocation = `${dataTransferEncyptionLocationKeysPrefix}${uniqueEncId}_.json`;
	const dataTransferEncryptionKeysRaw = await env.USER_DATA_TIKMIX_R2_BUCKET.get(dataTransferEncryptionKeysLocation);
	if (!dataTransferEncryptionKeysRaw) {
		return { success: false, error: 'Encryption Keys not found', code: 'FAILED_TO_FETCH_ENCRYPTION_KEYS' };
	}
	let dataTransferEncryptionKeysJSON;
	try {
		dataTransferEncryptionKeysJSON = await dataTransferEncryptionKeysRaw.json();
	} catch (error) {
		return { success: false, error, code: 'JSON_PARSING_FAILED' };
	}
	const { requestEncryptionKey, responseEncryptionKey, expiryAt } = dataTransferEncryptionKeysJSON;
	if (expiryAt < dateNow) {
		return { success: false, error: 'Encryption keys expired', code: 'CANNOT_GET_EXPIRED_ENCRYPTION_KEYS' };
	}
	return { requestEncryptionKey, responseEncryptionKey, success: true };
}
async function revokeDataTransferEncryptionKeys(req, res, env, ctx) {
	const dataTransferEncryptionKeys = generateDataTransferEncryptionKeys();
	const { uniqueEncId } = dataTransferEncryptionKeys;
	const dataTransferEncryptionKeysLocation = `${dataTransferEncyptionLocationKeysPrefix}${uniqueEncId}_.json`;
	await env.USER_DATA_TIKMIX_R2_BUCKET.put(dataTransferEncryptionKeysLocation, JSON.stringify(dataTransferEncryptionKeys));
	res.setStatus(200).sendJSON(dataTransferEncryptionKeys);
}
function generateDataTransferEncryptionKeys() {
	const createdAt = Date.now();
	return {
		createdAt,
		expiryAt: createdAt + 3600000,
		uniqueEncId: randomStringVal(true, 32),
		requestEncryptionKey: generateAesKeyBase64(),
		responseEncryptionKey: generateAesKeyBase64(),
	};
}
function parseJSON(data) {
	let text;
	if (data instanceof Uint8Array) {
		text = new TextDecoder().decode(data);
	} else if (typeof data === 'string') {
		text = data;
	} else {
		return { success: false, error: 'Unsupported input to parseJSON', code: 'INVALID_INPUT_TYPE' };
	}

	try {
		const parsed = JSON.parse(text);
		return { success: true, data: parsed };
	} catch (error) {
		return { success: false, error, code: 'FAILED_TO_PARSE_JSON' };
	}
}

export default {
	async scheduled(event, env, ctx) {
		const now = Date.now();
		const masterKeyListedResults = await env.USER_DATA_TIKMIX_R2_BUCKET.list({ prefix: userMasterKeyDataPrefix });
		const masterKeyObjects = masterKeyListedResults.objects;
		// Expired Master Keys
		for (const object of masterKeyObjects) {
			const key = object.key;
			try {
				const file = await env.USER_DATA_TIKMIX_R2_BUCKET.get(key);
				if (!file) continue;
				const json = await file.json();
				if (json.expiryAt && json.expiryAt < now) {
					await env.USER_DATA_TIKMIX_R2_BUCKET.delete(key);
				}
			} catch (err) {
				console.error(err);
			}
		}
		const dataTransferKeysListedResults = await env.USER_DATA_TIKMIX_R2_BUCKET.list({ prefix: dataTransferEncyptionLocationKeysPrefix });
		const dataTransferKeysObjects = dataTransferKeysListedResults.objects;
		// Expired Data Transfer Encryption Keys
		for (const object of dataTransferKeysObjects) {
			const key = object.key;
			try {
				const file = await env.USER_DATA_TIKMIX_R2_BUCKET.get(key);
				if (!file) continue;
				const json = await file.json();
				if (json.expiryAt && json.expiryAt < now) {
					await env.USER_DATA_TIKMIX_R2_BUCKET.delete(key);
				}
			} catch (err) {
				console.error(err);
			}
		}
	},

	async fetch(request, env, ctx) {
		return apiServer.respond(request, env, ctx);
	},
};
