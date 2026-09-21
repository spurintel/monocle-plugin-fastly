/** `fastly:cache-override` for tests: records what it was built with. */
export class CacheOverride {
	constructor(
		readonly mode: string,
		readonly init: { ttl?: number; swr?: number; surrogateKey?: string } = {}
	) {}
}
