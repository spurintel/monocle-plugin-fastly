/** `fastly:cache` SimpleCache for tests: one shared map with expiry, like one POP. */

const entries = new Map<string, { value: string; expiresAt: number }>();

export function resetSimpleCache(): void {
	entries.clear();
}

export function cachedValue(key: string): string | null {
	const entry = entries.get(key);
	return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

export class SimpleCache {
	static get(key: string) {
		const value = cachedValue(key);
		if (value === null) return null;
		return {
			text: async () => value,
			json: async () => JSON.parse(value) as object,
			arrayBuffer: async () => new TextEncoder().encode(value).buffer,
		};
	}
	static set(key: string, value: string, ttl: number): undefined {
		entries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
		return undefined;
	}
	static purge(key: string): undefined {
		entries.delete(key);
		return undefined;
	}
}
