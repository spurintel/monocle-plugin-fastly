/** A single path-prefix cache rule (see the web app's `SourceCacheProfile`). */
export interface CacheRule {
	prefix: string;
	ttl?: number;
	swr?: number;
	surrogateKey?: string;
}

/**
 * Parses the `CACHE_RULES` config item (a JSON array). Invalid/missing JSON
 * yields no rules so a bad value can never break request handling; the plugin
 * just falls back to default caching. Entries without a string `prefix` are
 * dropped; malformed optional fields (`ttl`/`swr` not finite non-negative
 * numbers, `surrogateKey` not a non-empty string) are stripped rather than
 * discarding the rule, so its prefix match still applies and a bad value never
 * reaches `CacheOverride` at request time.
 */
export function parseCacheRules(raw: string | undefined): CacheRule[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const rules: CacheRule[] = [];
		for (const r of parsed) {
			if (typeof r !== 'object' || r === null) continue;
			const { prefix, ttl, swr, surrogateKey } = r as Record<string, unknown>;
			if (typeof prefix !== 'string') continue;
			const rule: CacheRule = { prefix };
			if (isCacheSeconds(ttl)) rule.ttl = ttl;
			if (isCacheSeconds(swr)) rule.swr = swr;
			if (typeof surrogateKey === 'string' && surrogateKey !== '') rule.surrogateKey = surrogateKey;
			rules.push(rule);
		}
		return rules;
	} catch {
		return [];
	}
}

/** A usable ttl/swr value: a finite, non-negative number. */
function isCacheSeconds(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parses the `PROTECTED_PATHS` config item: a JSON object mapping a lowercase
 * hostname to an array of path patterns. Invalid/missing JSON yields undefined,
 * which fails SAFE: everything stays protected (never silently unprotected).
 */
export function parseProtectedPaths(
	raw: string | undefined,
): Record<string, string[]> | undefined {
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
		const result: Record<string, string[]> = {};
		for (const [host, patterns] of Object.entries(parsed)) {
			if (!Array.isArray(patterns)) continue;
			const valid = patterns.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
			if (valid.length > 0) result[host.toLowerCase()] = valid;
		}
		return Object.keys(result).length > 0 ? result : undefined;
	} catch {
		return undefined;
	}
}
