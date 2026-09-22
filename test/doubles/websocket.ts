/** `fastly:websocket` under Node: records the handoff instead of proxying a connection. */

export const handoffs: { request: Request; backend: string }[] = [];

export function resetHandoffs(): void {
	handoffs.length = 0;
}

export function createWebsocketHandoff(request: Request, backend: string): Response {
	if (!(request instanceof Request)) throw new Error('createWebsocketHandoff needs a Request');
	if (!backend || backend.length > 254) throw new Error('createWebsocketHandoff needs a backend');
	handoffs.push({ request, backend });
	// Node refuses to construct a 101, as the edge runtimes that can hand a socket over
	// do not. Only the shape matters here: the handler returns whatever this gives it.
	return {
		status: 101,
		statusText: 'Switching Protocols',
		headers: new Headers({ Upgrade: 'websocket' }),
		body: null,
	} as unknown as Response;
}
