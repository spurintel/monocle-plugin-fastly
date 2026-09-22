/** Fastly adapter: load the deployment from the stores and hand the request to the shared pipeline. */

import {
	canonicalizePath,
	handleRequest,
	isMclPath,
	resolveIndexedRoute,
	strippedRequest,
} from '@spur.us/monocle-edge-core';

import { ConfigUnavailable, loadOriginSettings, loadProtection, loadSecrets, type OriginSettings } from './config';
import { crawlerRanges } from './crawlers';
import { fetchOrigin } from './origin';
import { fastlyPlatform, isLocal } from './platform';
import { buildRuntime } from './runtime';


/** Answers one request. Never throws: a failure of ours serves the origin unprotected, marked. */
export async function handle(event: FetchEvent): Promise<Response> {
	const clientIp = event.client.address || null;
	const request = viewerRequest(event.request);
	let origin: OriginSettings = { cacheRules: [] };
	try {
		origin = loadOriginSettings();
		const protection = loadProtection();
		// The origin leg needs to know an enforced path to keep its response out of
		// the POP cache; only now is the deployment known.
		origin = {
			...origin,
			enforced: (pathname) => {
				try {
					return resolveIndexedRoute(canonicalizePath(pathname), protection.routeIndex).enforced;
				} catch {
					// An unusable path is never cached either.
					return true;
				}
			},
		};
		const platform = fastlyPlatform(clientIp, origin, protection.config.hosts);
		const runtime = await buildRuntime(
			protection,
			loadSecrets(),
			await crawlerRanges((task) => event.waitUntil(task), platform.fetch!),
			needsSecretKey(request)
		);
		return await handleRequest(request, { runtime, platform });
	} catch (error) {
		const reason = error instanceof ConfigUnavailable ? 'config' : 'runtime';
		console.error(
			`monocle passing through unprotected (${reason}): ${error instanceof Error ? error.message : String(error)}`
		);
		try {
			const unprotected = strippedRequest(request);
			unprotected.headers.set('X-Monocle-Skip', reason);
			return await fetchOrigin(unprotected, origin, clientIp);
		} catch (fallbackError) {
			// The last resort still answers: a rejected promise here would surface as
			// the platform's own error page for every request.
			console.error(
				`monocle fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
			);
			return new Response('Bad Gateway', { status: 502, headers: { 'Cache-Control': 'no-store' } });
		}
	}
}

/**
 * Whether this request can reach an endpoint, which is the only thing that reads the
 * Secret Store's policy key. A path the canonicalizer rejects reaches no endpoint, and
 * is left for the pipeline to answer 400 as the visitor's own doing.
 */
function needsSecretKey(request: Request): boolean {
	try {
		return isMclPath(canonicalizePath(new URL(request.url).pathname));
	} catch {
		return false;
	}
}

/** Viceroy serves plain HTTP; production terminates TLS before the service sees a request. */
function viewerRequest(request: Request): Request {
	if (!isLocal()) return request;
	const url = new URL(request.url);
	if (url.protocol !== 'http:') return request;
	url.protocol = 'https:';
	return new Request(url.toString(), request);
}
