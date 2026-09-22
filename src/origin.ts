import { cacheOverrideFor } from './cacheRules';
import { buildChainAuthHeader } from './chainAuth';
import type { OriginSettings } from './config';
import { CHAIN_AUTH_HEADER, CHAIN_SECRET_HEADER, ORIGIN_BACKEND } from './constants';

/**
 * Proxies to the customer's origin. The inbound Host names this service, so a host-routing
 * origin would send the request straight back; `host` rewrites it. The client address is
 * asserted, never forwarded: Compute adds no client-IP headers of its own, and an inbound
 * value is the visitor's to forge. A chained service gets a time-limited signature so it can
 * refuse anything that did not come through here.
 */
export async function fetchOrigin(
	request: Request,
	settings: OriginSettings,
	clientIp: string | null
): Promise<Response> {
	const url = new URL(request.url);
	if (settings.host) url.hostname = settings.host;
	// Rebuilt from parts: the headers become mutable, and the body streams through.
	const outbound = new Request(url.toString(), {
		method: request.method,
		headers: request.headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
		duplex: 'half',
	} as RequestInit);
	if (settings.host) outbound.headers.set('host', settings.host);
	stampClientIp(outbound.headers, clientIp, settings.clientIpHeader);
	outbound.headers.delete(CHAIN_SECRET_HEADER);
	outbound.headers.delete(CHAIN_AUTH_HEADER);
	if (settings.chainSecret)
		outbound.headers.set(CHAIN_AUTH_HEADER, await buildChainAuthHeader(settings.chainSecret));
	// An enforced response was released against one visitor's verdict, so it must never
	// be stored where the next visitor could be handed it. edge-core makes the response
	// private downstream; the override would put it in the POP cache first. Only a
	// positive "this path is not enforced" allows one, so the fail-open path, which has
	// no deployment to ask, caches nothing rather than guessing.
	const cacheOverride =
		settings.enforced && !settings.enforced(url.pathname)
			? cacheOverrideFor(url.pathname, settings.cacheRules)
			: undefined;
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
export function stampClientIp(headers: Headers, clientIp: string | null, customHeader?: string): void {
	for (const name of FORGEABLE_CLIENT_IP_HEADERS) headers.delete(name);
	for (const name of ['X-Forwarded-For', 'Fastly-Client-IP', ...(customHeader ? [customHeader] : [])]) {
		if (clientIp) headers.set(name, clientIp);
		else headers.delete(name);
	}
}
