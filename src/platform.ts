/** The Fastly platform: what the shared pipeline asks of a Compute service. */

import { env } from 'fastly:env';
import { createBreaker, type Platform } from '@spur.us/monocle-edge-core';

import { fetchWithBackend } from './backends';
import { cacheBreakerStore } from './breaker';
import type { OriginSettings } from './config';
import { rewriteHtml } from './html';
import { fetchOrigin } from './origin';

/**
 * No `unknownHost`: Fastly delivers only the domains attached to this service, and every one
 * reaches the same origin, so the pipeline assesses them all as the site. Answering an
 * unnamed one separately forwarded it unassessed, with the chain signature attached.
 */
export function fastlyPlatform(clientIp: string | null, origin: OriginSettings): Platform {
	return {
		breaker: createBreaker(cacheBreakerStore()),
		fetch: fetchWithBackend,
		clientIp: () => clientIp,
		fetchOrigin: (request, route) => fetchOrigin(request, origin, clientIp, route),
		rewriteHtml,
	};
}

/** Viceroy, under `fastly compute serve`. */
export function isLocal(): boolean {
	return env('FASTLY_HOSTNAME') === 'localhost';
}
