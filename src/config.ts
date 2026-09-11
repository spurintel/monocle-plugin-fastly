import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import { CONFIG_STORE_NAME, SECRET_STORE_NAME } from './constants';
import { parseCacheRules, parseProtectedPaths, type CacheRule } from './configParse';

export type { CacheRule };

/**
 * Runtime configuration for the plugin, assembled from the Config Store
 * (non-secret) and the Secret Store (secret material). Mirrors the `Env`
 * bindings the Cloudflare worker receives so the request-handling logic can be
 * ported one-to-one.
 */
export interface MonocleConfig {
	publishableKey: string;
	/**
	 * Secret material is loaded LAZILY and memoized: most requests (unprotected
	 * paths, block-page passthrough) never need either secret, and cookie
	 * validation needs only the cookie secret. Keeping these behind async getters
	 * removes the Secret Store reads from the proxy hot path entirely.
	 */
	getSecretKey(): Promise<string>;
	getCookieSecret(): Promise<string>;
	/**
	 * Host to send to the customer's origin. Fastly's backend `override_host` is
	 * not honoured when we replay the inbound request, so the plugin rewrites the
	 * outbound Host to this value. Undefined (empty in the store) means "forward
	 * the visitor's Host unchanged".
	 */
	originHost?: string;
	/**
	 * Shared secret sent to the customer's existing service when chaining. Lets
	 * that service reject direct hits to the internal host that would otherwise
	 * bypass the Monocle challenge. Undefined when not chaining.
	 */
	chainSecret?: string;
	/**
	 * Optional path-prefix cache rules cloned from the customer's source service.
	 * Empty/absent means "use the default readthrough cache" (honour the origin's
	 * own cache headers), which is the normal case.
	 */
	cacheRules: CacheRule[];
	/**
	 * Optional path scoping per protected hostname (lowercase host → path
	 * patterns like "/api/*"). Requests outside the patterns bypass the Monocle
	 * challenge and proxy straight to the origin. Absent (the common case, all
	 * routes "/*") means every path on every domain is protected.
	 */
	protectedPaths?: Record<string, string[]>;
	/**
	 * When true, each verify (challenge solve) logs one JSON line with the raw
	 * policy decision: always to console (visible in the live log tail with no
	 * setup) and best-effort to the optional `monocle_assessments` named log
	 * endpoint. Default OFF; true only when the Config Store key is exactly
	 * "true", and dashboard-toggled via the Config Store (no redeploy needed).
	 */
	logAssessment: boolean;
	blockResponseType?: 'redirect' | 'html';
	blockRedirectUrl?: string;
	/** Parsed and clamped to a 4xx/5xx code here; the block builder defaults to 403. */
	blockStatusCode?: number;
	blockPageTitle?: string;
	blockResponseBody?: string;
}

function optional(store: ConfigStore, key: string): string | undefined {
	const value = store.get(key);
	return value === null || value === '' ? undefined : value;
}

function parseBlockType(raw: string | undefined): 'redirect' | 'html' | undefined {
	return raw === 'redirect' || raw === 'html' ? raw : undefined;
}

/**
 * Clamps the block status to a 4xx/5xx error code, returning undefined (so the
 * builder falls back to 403) otherwise. Doing it here means an out-of-range
 * value can never reach `new Response` and throw the block path into the verify
 * catch's fail-open. A 2xx is rejected too: the interstitial treats an `ok`
 * response as success and reloads, looping instead of showing the block page.
 */
function parseBlockStatus(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = parseInt(raw, 10);
	return n >= 400 && n <= 599 ? n : undefined;
}

async function secret(store: SecretStore, key: string): Promise<string> {
	const entry = await store.get(key);
	return entry ? entry.plaintext() : '';
}

/**
 * Loads config at request time. Config/Secret stores can only be accessed while
 * handling a request (not during build-time init), so this is called inside the
 * fetch handler. Secrets are NOT read here: the getters fetch each secret on
 * first use and memoize the promise, so requests that never touch secret
 * material never pay the Secret Store roundtrips.
 */
export function loadConfig(): MonocleConfig {
	const config = new ConfigStore(CONFIG_STORE_NAME);
	const secrets = new SecretStore(SECRET_STORE_NAME);

	const publishableKey = config.get('PUBLISHABLE_KEY') ?? '';
	if (!publishableKey) {
		// Without this the challenge page renders with an empty token and can never
		// complete: an invisible install failure worth a loud log.
		console.error('PUBLISHABLE_KEY is missing from the config store; the challenge page cannot work.');
	}

	let secretKey: Promise<string> | undefined;
	let cookieSecret: Promise<string> | undefined;

	return {
		publishableKey,
		originHost: optional(config, 'ORIGIN_HOST'),
		chainSecret: optional(config, 'CHAIN_SECRET'),
		cacheRules: parseCacheRules(optional(config, 'CACHE_RULES')),
		protectedPaths: parseProtectedPaths(optional(config, 'PROTECTED_PATHS')),
		logAssessment: optional(config, 'LOG_ASSESSMENT') === 'true',
		blockResponseType: parseBlockType(optional(config, 'BLOCK_RESPONSE_TYPE')),
		blockRedirectUrl: optional(config, 'BLOCK_REDIRECT_URL'),
		blockStatusCode: parseBlockStatus(optional(config, 'BLOCK_STATUS_CODE')),
		blockPageTitle: optional(config, 'BLOCK_PAGE_TITLE'),
		blockResponseBody: optional(config, 'BLOCK_RESPONSE_BODY'),
		getSecretKey: () => (secretKey ??= secret(secrets, 'SECRET_KEY')),
		getCookieSecret: () => (cookieSecret ??= secret(secrets, 'COOKIE_SECRET_VALUE')),
	};
}
