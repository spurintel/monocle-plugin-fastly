import { SimpleCache } from 'fastly:cache';
import type { BreakerState, BreakerStore } from '@spur.us/monocle-edge-core';

import { BREAKER_CACHE_KEY, BREAKER_CACHE_SECONDS } from './constants';

/** Breaker state in the POP cache, the scope Policy reachability has. Two racing requests lose at most one update. */
export function cacheBreakerStore(): BreakerStore {
	return {
		async load() {
			const entry = SimpleCache.get(BREAKER_CACHE_KEY);
			if (!entry) return null;
			try {
				return JSON.parse(await entry.text()) as BreakerState;
			} catch {
				return null;
			}
		},
		async save(state) {
			// Deprecated in favour of getOrSet, which only fills an empty key; a breaker
			// overwrites its state, which only set does.
			SimpleCache.set(BREAKER_CACHE_KEY, JSON.stringify(state), BREAKER_CACHE_SECONDS);
		},
	};
}
