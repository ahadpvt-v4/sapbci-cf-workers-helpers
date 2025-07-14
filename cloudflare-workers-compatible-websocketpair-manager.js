class WebSocketPairManager {
	constructor() {
		this.clients = new Set();
	}

	// Call this to create a new WebSocketPair and setup the server side socket
	createConnection() {
		const [client, server] = Object.values(new WebSocketPair());
		server.accept();

		this.addClient(server);

		return client; // Return the client socket for handshake response
	}

	addClient(ws) {
		this.clients.add(ws);

		ws.addEventListener('message', (event) => {
			this.onMessage(ws, event.data);
		});

		ws.addEventListener('close', () => {
			this.clients.delete(ws);
			this.onClose(ws);
		});

		ws.addEventListener('error', (err) => {
			this.onError(ws, err);
		});
	}

	onMessage(ws, message) {
		console.log(`Received from client: ${message}`);
		// override for custom message handling
	}

	send(ws, data) {
		if (this.clients.has(ws) && ws.readyState === ws.OPEN) {
			const msg = typeof data === 'string' ? data : JSON.stringify(data);
			ws.send(msg);
		}
	}

	broadcast(data) {
		for (const client of this.clients) {
			this.send(client, data);
		}
	}

	onClose(ws) {
		console.log('Client disconnected');
	}

	onError(ws, err) {
		console.error('Client error', err);
	}
}
async function autoSwitchProtocol({ request, env, ctx, routeDispatcher }, webSocketPairManger) {
	const upgradeHeader = request.headers.get('upgrade')?.toLowerCase();
	const isWebSocket = upgradeHeader && upgradeHeader.toLowerCase() === 'websocket';

	if (isWebSocket) {
		const clientSocket = webSocketPairManger.createConnection();

		return new Response(null, {
			status: 101,
			webSocket: clientSocket,
		});
	} else if ('object' === typeof routeDispatcher) {
		return await routeDispatcher.respond(request, env, ctx);
	}
}
module.exports = { autoSwitchProtocol, WebSocketPairManager };

// cloudflare-workers-compatible-websocketpair-manager.js
