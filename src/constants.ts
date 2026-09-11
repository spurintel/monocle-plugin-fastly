export const COOKIE_NAME = 'MCLVALID';

// Names of the statically defined backends on the Monocle Compute service.
// The customer's origin/service is the ORIGIN backend; the Monocle Policy API
// is reached via the POLICY backend. Both must exist on the service version
// because js-compute requires every fetch() to name a backend.
export const ORIGIN_BACKEND = 'origin';
export const POLICY_BACKEND = 'monocle_policy';

// Resource-link names attaching the account-level stores to the service
// version. These are the names the runtime uses, and need not match the
// underlying store names.
export const CONFIG_STORE_NAME = 'monocle_config';
export const SECRET_STORE_NAME = 'monocle_secrets';

// Named log endpoint for raw assessment lines (LOG_ASSESSMENT="true"). The
// customer creates it on the service themselves to get retained/streamed logs;
// it is OPTIONAL and usually absent, so every write to it is best-effort.
export const ASSESSMENT_LOG_ENDPOINT = 'monocle_assessments';

// Host for the Monocle Policy API. Note the `decrypt.` prefix: the backend
// SDK targets `https://decrypt.<baseDomain>/api/v1/policy`.
export const POLICY_API_URL = 'https://decrypt.mcl.spur.us/api/v1/policy';

// Legacy header that once carried the raw chaining secret. No longer SENT (a
// static, never-expiring credential was a permanent replay risk); the plugin
// only strips any inbound value under this name so a visitor can't spoof it.
// Kept solely for that strip; the signed header below is the real proof.
export const CHAIN_SECRET_HEADER = 'X-Monocle-Chain-Secret';

// Header carrying the time-limited chaining signature:
// "<unix seconds>.0x<hmac-sha256 hex>", where the HMAC is keyed with the shared
// secret over the timestamp. Current guards validate THIS (not the static
// secret), so a captured header only replays for a few minutes instead of
// working forever. Format must match the guard snippets built by the web app
// (web/apps/app/src/lib/fastly/chaining.ts) and Fastly VCL's
// digest.hmac_sha256 output (0x-prefixed lowercase hex).
export const CHAIN_AUTH_HEADER = 'X-Monocle-Chain-Auth';
