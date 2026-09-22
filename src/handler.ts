/** Fastly adapter: load the deployment from the stores and hand the request to the shared pipeline. */

import {
	canonicalizePath,
	handleRequest,
	isMclPath,
	resolveIndexedRoute,
	strippedRequest,
} from '@spur.us/monocle-edge-core';

import { createWebsocketHandoff } from 'fastly:websocket';

import {
	ConfigUnavailable,
	loadOriginSettings,
	loadProtection,
	loadSecrets,
	type OriginSettings,
	type Protection,
} from './config';
import { ORIGIN_BACKEND } from './constants';
import { crawlerRanges } from './crawlers';
import { fetchOrigin, originHeaders } from './origin';
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
		// Upgrades are answered before the pipeline, which would otherwise try to proxy
		// one through a leg that cannot carry a socket.
		const websocket = await websocketAnswer(event.request, request, protection, origin, clientIp);
		if (websocket) return websocket;
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
 * Answers a WebSocket upgrade, or null when this request is not one or is not for a host we
 * protect. Both answers are the platform's to give, because both follow from what Compute
 * can do rather than from any decision about the visitor.
 *
 * On a path we do not enforce, Fastly is asked to proxy the connection itself: the origin
 * leg cannot carry a socket, so a proxied upgrade reaches the origin and its 101 arrives
 * with nothing we can pass on. The service must have WebSocket passthrough enabled for the
 * handoff to complete; without it the upgrade fails, which is what it already did.
 *
 * On a path we do enforce, it is refused. A connection handed to Fastly leaves our sight
 * for its lifetime, so there is no way to hold it to a verdict that can turn to block while
 * it is open, and the alternative of proxying it is the 502 this exists to remove.
 */
async function websocketAnswer(
	original: Request,
	request: Request,
	protection: Protection,
	settings: OriginSettings,
	clientIp: string | null
): Promise<Response | null> {
	const upgrade = request.headers.get('Upgrade');
	if (!upgrade || !upgrade.toLowerCase().includes('websocket')) return null;
	const url = new URL(request.url);
	if (!protection.config.hosts.includes(url.hostname)) return null;
	let enforced: boolean;
	try {
		enforced = resolveIndexedRoute(canonicalizePath(url.pathname), protection.routeIndex).enforced;
	} catch {
		// An unusable path is the pipeline's to answer, not ours.
		return null;
	}
	if (enforced) return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
	// The connection leaves our sight once Fastly has it, so everything the origin must
	// not see goes first. `strippedRequest` removes our cookies and contract headers, as
	// it does on the proxied path, and the rest is the same preparation the origin leg
	// does, including the signature a chained service refuses requests without.
	const stripped = strippedRequest(original);
	const outbound = new URL(stripped.url);
	if (settings.host) outbound.hostname = settings.host;
	return createWebsocketHandoff(
		new Request(
			outbound.toString(),
			{
				method: stripped.method,
				headers: await originHeaders(stripped.headers, settings, clientIp),
			} as RequestInit
		),
		ORIGIN_BACKEND
	);
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
