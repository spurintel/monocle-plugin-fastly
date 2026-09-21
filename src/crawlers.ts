import { SimpleCache } from 'fastly:cache';
import {
	compileCidrSet,
	crawlerSnapshot,
	fetchCrawlerRanges,
	parseCrawlerSnapshot,
	type CidrSet,
	type FetchLike,
} from '@spur.us/monocle-edge-core';

import {
	CRAWLER_CACHE_KEY,
	CRAWLER_CACHE_SECONDS,
	CRAWLER_REFRESH_KEY,
	CRAWLER_REFRESH_LEASE_SECONDS,
} from './constants';

/**
 * The crawler exemptions from the POP cache. Nothing schedules on Compute, so the request that
 * finds the snapshot missing or expired refreshes it off the hot path, once per POP per lease,
 * and grants no exemption itself.
 */
export async function crawlerRanges(
	waitUntil: (task: Promise<unknown>) => void,
	fetchImpl: FetchLike,
	now = Date.now()
): Promise<CidrSet> {
	const entry = SimpleCache.get(CRAWLER_CACHE_KEY);
	if (entry) {
		const snapshot = parseCrawlerSnapshot(await entry.text(), now / 1000);
		if (snapshot.expiresAt !== null) return snapshot.ranges;
	}
	if (!SimpleCache.get(CRAWLER_REFRESH_KEY)) {
		SimpleCache.set(CRAWLER_REFRESH_KEY, '1', CRAWLER_REFRESH_LEASE_SECONDS);
		waitUntil(refresh(fetchImpl, now));
	}
	return compileCidrSet([]);
}

async function refresh(fetchImpl: FetchLike, now: number): Promise<void> {
	try {
		SimpleCache.set(CRAWLER_CACHE_KEY, crawlerSnapshot(await fetchCrawlerRanges(now, fetchImpl)), CRAWLER_CACHE_SECONDS);
	} catch (error) {
		console.warn(`Crawler refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
