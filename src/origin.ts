import { createWebsocketHandoff } from 'fastly:websocket';

import { cacheOverrideFor } from './cacheRules';
import { buildChainAuthHeader } from './chainAuth';
import type { OriginSettings } from './config';
import { CHAIN_AUTH_HEADER, ORIGIN_BACKEND } from './constants';

/**
 * Proxies to the customer's origin. The inbound Host names this service, so a host-routing
 * origin would send the request straight back; `host` rewrites it. The client address is
 * asserted, never forwarded: Compute adds no client-IP headers of its own, and an inbound
 * value is the visitor's to forge. A chained service gets a time-limited signature so it can
 * refuse anything that did not come through here.
 *
 * `route` is absent when the pipeline never resolved one, and nothing is cached then: a
 * response released against a verdict must not wait in the POP cache for the next visitor.
 */
export async function fetchOrigin(
	request: Request,
	settings: OriginSettings,
	clientIp: string | null,
	route?: { enforced: boolean }
): Promise<Response> {
	const url = new URL(request.url);
	if (settings.host) url.hostname = settings.host;
	const headers = await originHeaders(request.headers, settings, clientIp);
	// This leg cannot carry a socket, so an upgrade the pipeline let through is handed to
	// Fastly to proxy. That needs WebSocket passthrough enabled on the service.
	if ((request.headers.get('Upgrade') ?? '').toLowerCase().includes('websocket'))
		return createWebsocketHandoff(
			new Request(url.toString(), { method: request.method, headers } as RequestInit),
			ORIGIN_BACKEND
		);
	// Rebuilt from parts: the headers become mutable, and the body streams through.
	const outbound = new Request(url.toString(), {
		method: request.method,
		headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
		duplex: 'half',
	} as RequestInit);
	const cacheOverride = route && !route.enforced ? cacheOverrideFor(url.pathname, settings.cacheRules) : undefined;
	try {
		return await fetch(outbound, { backend: ORIGIN_BACKEND, ...(cacheOverride && { cacheOverride }) });
	} catch (error) {
		console.error(
			`Origin proxy failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
		);
		return new Response('Bad Gateway', { status: 502 });
	}
}

/**
 * The headers the origin must see: the client address stamped rather than trusted, and the
 * chain signature when chaining. The pipeline has already removed every `X-Monocle-*` the
 * viewer sent, so a forged signature never reaches this far.
 */
async function originHeaders(source: Headers, settings: OriginSettings, clientIp: string | null): Promise<Headers> {
	const headers = new Headers(source);
	if (settings.host) headers.set('host', settings.host);
	stampClientIp(headers, clientIp, settings.clientIpHeader);
	if (settings.chainSecret) headers.set(CHAIN_AUTH_HEADER, await buildChainAuthHeader(settings.chainSecret));
	return headers;
}

/**
 * The other names an origin might be configured to trust. Deleted outright: Compute
 * adds none of them, so any value present is the viewer's own and forging one is how
 * an origin behind `real_ip_header` is told the wrong address.
 */
const FORGEABLE_CLIENT_IP_HEADERS = [
	'X-Real-IP',
	'True-Client-IP',
	'CF-Connecting-IP',
	'Forwarded',
	'X-Client-IP',
	'X-Cluster-Client-IP',
];

/** Overwrites, never appends: the inbound values are client-supplied. */
function stampClientIp(headers: Headers, clientIp: string | null, customHeader?: string): void {
	for (const name of FORGEABLE_CLIENT_IP_HEADERS) headers.delete(name);
	for (const name of ['X-Forwarded-For', 'Fastly-Client-IP', ...(customHeader ? [customHeader] : [])]) {
		if (clientIp) headers.set(name, clientIp);
		else headers.delete(name);
	}
}
