/** The Fastly platform: what the shared pipeline asks of a Compute service. */

import { env } from 'fastly:env';
import { createBreaker, strippedRequest, type Platform } from '@spur.us/monocle-edge-core';

import { fetchWithBackend } from './backends';
import { cacheBreakerStore } from './breaker';
import type { OriginSettings } from './config';
import { rewriteHtml } from './html';
import { fetchOrigin } from './origin';

export function fastlyPlatform(clientIp: string | null, origin: OriginSettings, hosts: readonly string[] = []): Platform {
	return {
		breaker: createBreaker(cacheBreakerStore()),
		fetch: fetchWithBackend,
		clientIp: () => clientIp,
		fetchOrigin: (request) => fetchOrigin(request, origin, clientIp),
		unknownHost: (request) => unknownHost(request, origin, clientIp, hosts),
		rewriteHtml,
	};
}

/** Viceroy, under `fastly compute serve`. */
export function isLocal(): boolean {
	return env('FASTLY_HOSTNAME') === 'localhost';
}

/**
 * Everything the pipeline declines to run on: a scheme that is not HTTPS, a URL carrying a
 * port, or a hostname the deployment does not name.
 *
 * A request for a host we do not name still reaches this service, since the domain is
 * attached to it, and is forwarded as the origin would have seen it, unassessed. A host we
 * DO name is a different matter: forwarding it would let `Host: site:8443` walk past every
 * enforced path, so it is refused. Plain HTTP goes to HTTPS first, because the cookies are
 * Secure and an unencrypted request would otherwise pass every enforced path.
 */
function unknownHost(
	request: Request,
	origin: OriginSettings,
	clientIp: string | null,
	hosts: readonly string[]
): Promise<Response> {
	const url = new URL(request.url);
	if (url.protocol === 'http:') {
		url.protocol = 'https:';
		return Promise.resolve(
			new Response(null, { status: 301, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } })
		);
	}
	// A backstop. edge-core normalises the one reason a host we name used to arrive
	// here, a port in the authority, so this should not be reachable; if it ever is,
	// the request is for a host we protect and could not be assessed, and forwarding
	// it would be the bypass rather than the safe option.
	if (hosts.includes(url.hostname)) {
		return Promise.resolve(
			new Response(null, { status: 421, headers: { 'Cache-Control': 'no-store' } })
		);
	}
	return fetchOrigin(strippedRequest(request), origin, clientIp);
}
