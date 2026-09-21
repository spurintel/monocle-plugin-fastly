/** The Fastly platform: what the shared pipeline asks of a Compute service. */

import { env } from 'fastly:env';
import { createBreaker, strippedRequest, type Platform } from '@spur.us/monocle-edge-core';

import { fetchWithBackend } from './backends';
import { cacheBreakerStore } from './breaker';
import type { OriginSettings } from './config';
import { rewriteHtml } from './html';
import { fetchOrigin } from './origin';

export function fastlyPlatform(clientIp: string | null, origin: OriginSettings): Platform {
	return {
		breaker: createBreaker(cacheBreakerStore()),
		fetch: fetchWithBackend,
		clientIp: () => clientIp,
		fetchOrigin: (request) => fetchOrigin(request, origin, clientIp),
		unknownHost: (request) => unknownHost(request, origin, clientIp),
		rewriteHtml,
	};
}

/** Viceroy, under `fastly compute serve`. */
export function isLocal(): boolean {
	return env('FASTLY_HOSTNAME') === 'localhost';
}

/**
 * A request for a host the deployment does not name still reaches this service, since the
 * domain is attached to it: it is forwarded as the origin would have seen it, unassessed.
 * Plain HTTP goes to HTTPS first, because the cookies are Secure and an unencrypted request
 * would otherwise pass every enforced path.
 */
function unknownHost(request: Request, origin: OriginSettings, clientIp: string | null): Promise<Response> {
	const url = new URL(request.url);
	if (url.protocol === 'http:') {
		url.protocol = 'https:';
		return Promise.resolve(
			new Response(null, { status: 301, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } })
		);
	}
	return fetchOrigin(strippedRequest(request), origin, clientIp);
}
