import { CacheOverride } from 'fastly:cache-override';

/** A path-prefix cache rule cloned from the customer's source service. */
export interface CacheRule {
	prefix: string;
	ttl?: number;
	swr?: number;
	surrogateKey?: string;
}

/**
 * Parses the `CACHE_RULES` item, a JSON array. Anything malformed yields no rules, so a bad
 * value can never break request handling: the default readthrough cache applies. A rule's
 * malformed optional fields are stripped rather than the rule dropped.
 */
export function parseCacheRules(raw: string | undefined): CacheRule[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const rules: CacheRule[] = [];
		for (const entry of parsed) {
			if (typeof entry !== 'object' || entry === null) continue;
			const { prefix, ttl, swr, surrogateKey } = entry as Record<string, unknown>;
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

function isCacheSeconds(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** The first matching rule wins, so the dashboard lists the more specific prefixes first. */
export function cacheOverrideFor(pathname: string, rules: CacheRule[]): CacheOverride | undefined {
	const rule = rules.find((r) => pathname.startsWith(r.prefix));
	if (!rule) return undefined;
	return new CacheOverride('override', { ttl: rule.ttl, swr: rule.swr, surrogateKey: rule.surrogateKey });
}
