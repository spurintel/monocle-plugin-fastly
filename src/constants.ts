/** Names the dashboard provisions on the service; the plugin only reads them. */

export const CONFIG_STORE_NAME = 'monocle_config';
export const SECRET_STORE_NAME = 'monocle_secrets';

/** js-compute needs a named backend on every fetch. */
export const ORIGIN_BACKEND = 'origin';
export const POLICY_BACKEND = 'monocle_policy';
export const CRAWLER_BACKEND_PREFIX = 'crawler_';

/** The chaining signature, `<unix seconds>.0x<hmac hex>`, which the customer's service verifies. */
export const CHAIN_AUTH_HEADER = 'X-Monocle-Chain-Auth';

/** POP cache keys and lifetimes. */
export const BREAKER_CACHE_KEY = 'mcl:brk';
export const BREAKER_CACHE_SECONDS = 120;
export const CRAWLER_CACHE_KEY = 'mcl:bots';
/** A snapshot is kept for its whole day, and refreshed once it is this old. */
export const CRAWLER_REFRESH_AFTER_SECONDS = 3600;
export const CRAWLER_REFRESH_KEY = 'mcl:bots:refreshing';
export const CRAWLER_REFRESH_LEASE_SECONDS = 60;
