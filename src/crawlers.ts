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
	CRAWLER_REFRESH_AFTER_SECONDS,
	CRAWLER_REFRESH_KEY,
	CRAWLER_REFRESH_LEASE_SECONDS,
} from './constants';

/** How long a fetched snapshot stays valid, which is how long the POP cache keeps it. */
const SNAPSHOT_SECONDS = 86_400;

/**
 * The crawler exemptions from the POP cache. Nothing schedules on Compute, so the request that
 * finds the snapshot missing, expired or due refreshes it off the hot path, once per POP per
 * lease. A due snapshot still exempts meanwhile; only a missing or expired one grants nothing.
 */
export async function crawlerRanges(
	waitUntil: (task: Promise<unknown>) => void,
	fetchImpl: FetchLike,
	now = Date.now()
): Promise<CidrSet> {
	const entry = SimpleCache.get(CRAWLER_CACHE_KEY);
	const snapshot = entry ? parseCrawlerSnapshot(await entry.text(), now / 1000) : null;
	const expiresAt = snapshot?.expiresAt ?? null;
	const due = expiresAt === null || expiresAt - now / 1000 < SNAPSHOT_SECONDS - CRAWLER_REFRESH_AFTER_SECONDS;
	if (due && !SimpleCache.get(CRAWLER_REFRESH_KEY)) {
		SimpleCache.set(CRAWLER_REFRESH_KEY, '1', CRAWLER_REFRESH_LEASE_SECONDS);
		waitUntil(refresh(fetchImpl, now));
	}
	return expiresAt === null ? compileCidrSet([]) : snapshot!.ranges;
}

async function refresh(fetchImpl: FetchLike, now: number): Promise<void> {
	try {
		SimpleCache.set(CRAWLER_CACHE_KEY, crawlerSnapshot(await fetchCrawlerRanges(now, fetchImpl)), SNAPSHOT_SECONDS);
	} catch (error) {
		console.warn(`Crawler refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
