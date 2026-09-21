/** Fastly adapter: load the deployment from the stores and hand the request to the shared pipeline. */

import { handleRequest, strippedRequest } from '@spur.us/monocle-edge-core';

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
		const platform = fastlyPlatform(clientIp, origin);
		const runtime = await buildRuntime(
			protection,
			loadSecrets(),
			await crawlerRanges((task) => event.waitUntil(task), platform.fetch!),
			/\/__mcl\//i.test(new URL(request.url).pathname)
		);
		return await handleRequest(request, { runtime, platform });
	} catch (error) {
		const reason = error instanceof ConfigUnavailable ? 'config' : 'runtime';
		console.error(
			`monocle passing through unprotected (${reason}): ${error instanceof Error ? error.message : String(error)}`
		);
		const unprotected = strippedRequest(request);
		unprotected.headers.set('X-Monocle-Skip', reason);
		return fetchOrigin(unprotected, origin, clientIp);
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
