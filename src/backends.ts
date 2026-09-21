import { CRAWLER_FEEDS, POLICY_API_URL, type FetchLike } from '@spur.us/monocle-edge-core';

import { CRAWLER_BACKEND_PREFIX, POLICY_BACKEND } from './constants';

/** The static backend for a crawler feed host, `crawler_developers_google_com`. The dashboard creates it by the same rule. */
export function crawlerBackendName(hostname: string): string {
	return `${CRAWLER_BACKEND_PREFIX}${hostname.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

const BACKENDS = new Map<string, string>([
	[new URL(POLICY_API_URL).hostname, POLICY_BACKEND],
	...CRAWLER_FEEDS.map((feed): [string, string] => {
		const { hostname } = new URL(feed);
		return [hostname, crawlerBackendName(hostname)];
	}),
]);

/** Outbound HTTP for the shared code, which names no backend. */
export const fetchWithBackend: FetchLike = (input, init) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const backend = BACKENDS.get(new URL(url).hostname);
	if (!backend) return Promise.reject(new Error(`No backend for ${new URL(url).hostname}`));
	return fetch(input instanceof Request ? input : url, { ...init, backend });
};
