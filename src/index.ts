/// <reference types="@fastly/js-compute" />
import { CacheOverride } from 'fastly:cache-override';
import { logAssessment } from './assessmentLog';
import { buildChainAuthHeader } from './chainAuth';
import { CHAIN_AUTH_HEADER, CHAIN_SECRET_HEADER, ORIGIN_BACKEND, POLICY_BACKEND } from './constants';
import { loadConfig, type CacheRule, type MonocleConfig } from './config';
import { validateCookie, setSecureCookie } from './cookies';
import { escapeHtml } from './escape';
import { isProtectedPath } from './paths';
import { evaluateAssessment, MonocleAPIError } from './policy';
import captcha from './templates/captcha_page.html';

addEventListener('fetch', event => event.respondWith(handleRequestSafe(event)));

async function handleRequestSafe(event: FetchEvent): Promise<Response> {
	try {
		return await handleRequest(event);
	} catch (error: unknown) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`Unhandled error in request handler: ${detail}`);
		return new Response('Internal Server Error', { status: 500 });
	}
}

async function handleRequest(event: FetchEvent): Promise<Response> {
	const request = event.request;
	const clientIp = event.client.address;
	const url = new URL(request.url);
	const config = loadConfig();

	// Serve the configured redirect block page itself without a challenge, so
	// same-domain block pages work even under wildcard routes.
	if (config.blockResponseType === 'redirect' && config.blockRedirectUrl) {
		try {
			const blockUrl = new URL(config.blockRedirectUrl);
			if (blockUrl.hostname === url.hostname && blockUrl.pathname === url.pathname) {
				return proxyToOrigin(request, config, url, clientIp);
			}
		} catch {
			// Invalid BLOCK_REDIRECT_URL, ignore and continue normal processing.
		}
	}

	// The captcha page POSTs back to its own URL with this sentinel header, so
	// the plugin intercepts validation regardless of the configured route pattern.
	if (request.method === 'POST' && request.headers.get('X-MCL-Validate') === '1') {
		return validateWithPolicyApi(request, clientIp, config);
	}

	// Path scoping: only matching paths are challenged; the rest proxy straight
	// through. Fastly attaches whole domains to a service (no Cloudflare-style
	// route filtering), so the scoping must live here in the Compute bundle.
	if (!isProtectedPath(url.hostname, url.pathname, config.protectedPaths)) {
		return proxyToOrigin(request, config, url, clientIp);
	}

	// Single header read: validateCookie already fails fast on a missing cookie
	// (before any Secret Store read), so no separate presence parse is needed.
	const cookieHeader = request.headers.get('Cookie');
	if (cookieHeader && (await validateCookie(cookieHeader, clientIp, config))) {
		return proxyToOrigin(request, config, url, clientIp);
	}

	// Function replacements, NOT strings: string args treat `$&`, `$1`, `$$` as
	// special patterns, so a URL containing `$` (e.g. an OData `?$filter=` query)
	// would be corrupted in the redirect target, trapping the visitor in a
	// challenge loop. A function replacement inserts the value literally.
	const redirectJson = JSON.stringify(url.href);
	return new Response(
		captcha
			.replace('PUBLISHABLE_KEY', () => config.publishableKey)
			.replaceAll('REPLACE_REDIRECT', () => redirectJson),
		{
			headers: {
				'Content-Type': 'text/html',
				// The challenge is per-request and security-sensitive: never let a
				// browser or intermediary cache and re-serve a stale interstitial.
				'Cache-Control': 'no-store, no-cache, must-revalidate',
				Pragma: 'no-cache',
			},
		}
	);
}

/**
 * Picks the cache override from the cloned prefix rules; undefined means no
 * match, leaving Fastly's default readthrough caching (honour origin headers).
 * First match wins, so the web app that builds these rules must list
 * more-specific prefixes first (`/api/static` before `/api` before `/`), or
 * the broader rule shadows the narrower one.
 */
function cacheOverrideFor(pathname: string, rules: CacheRule[]): CacheOverride | undefined {
	const rule = rules.find(r => pathname.startsWith(r.prefix));
	if (!rule) return undefined;
	return new CacheOverride('override', {
		ttl: rule.ttl,
		swr: rule.swr,
		surrogateKey: rule.surrogateKey,
	});
}

/**
 * Proxies the incoming request to the customer's origin via the ORIGIN backend.
 *
 * The inbound Host is the PROTECTED domain, which points back at this service:
 * replayed verbatim, a host-routing origin (CDN, host-based vhost) sends the
 * request straight back to us, an infinite loop surfacing as a 502. Backend
 * `override_host` does not fix this because the guest's explicit Host header
 * wins, so we rewrite the outbound Host ourselves. Empty/undefined `originHost`
 * means "forward the visitor's Host unchanged" (faithful mode).
 *
 * `clientIp` (`event.client.address`) is forwarded explicitly because Compute,
 * unlike VCL, adds no client-IP headers to backend requests. Without it, a
 * chained Fastly service or the origin sees Monocle's egress IP instead of the
 * visitor, breaking bot verification and per-IP rate limiting on that hop.
 */
async function proxyToOrigin(
	request: Request,
	config: MonocleConfig,
	url: URL,
	clientIp: string | null
): Promise<Response> {
	try {
		// Rebuild the outbound request so its headers are mutable. Mutating the
		// caller's already-parsed `url` is safe (every caller returns immediately
		// after this) and avoids a second URL parse per proxied request.
		if (config.originHost) url.hostname = config.originHost;
		const originRequest = new Request(url.toString(), request);
		if (config.originHost) originRequest.headers.set('host', config.originHost);

		// OVERWRITE X-Forwarded-For, never append: Monocle is the edge trust
		// boundary, so inbound XFF is client-supplied and propagating it would let
		// a visitor spoof its IP past downstream rate limiting. When chaining, the
		// next Fastly hop re-stamps Fastly-Client-IP at its own ingress, so XFF's
		// leftmost entry is what survives; Fastly-Client-IP mainly serves a
		// non-Fastly origin in simple mode.
		if (clientIp) {
			originRequest.headers.set('X-Forwarded-For', clientIp);
			originRequest.headers.set('Fastly-Client-IP', clientIp);
		} else {
			// No real client IP to assert. Still strip any inbound values so a
			// client-supplied XFF/Fastly-Client-IP can never reach the origin.
			originRequest.headers.delete('X-Forwarded-For');
			originRequest.headers.delete('Fastly-Client-IP');
		}

		// Chaining headers are Monocle's to assert, never the client's: strip any
		// inbound value (including the legacy static-secret header), then set the
		// time-limited signature when chaining so the customer's existing service
		// can verify the request came through Monocle. Unlike the old static
		// secret, a captured signature expires in minutes instead of replaying
		// forever.
		originRequest.headers.delete(CHAIN_SECRET_HEADER);
		originRequest.headers.delete(CHAIN_AUTH_HEADER);
		if (config.chainSecret) {
			originRequest.headers.set(CHAIN_AUTH_HEADER, await buildChainAuthHeader(config.chainSecret));
		}
		const cacheOverride = cacheOverrideFor(url.pathname, config.cacheRules);
		return await fetch(originRequest, { backend: ORIGIN_BACKEND, cacheOverride });
	} catch (error: unknown) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error(`Origin proxy failed: ${message}`);
		return new Response('Bad Gateway', { status: 502 });
	}
}

async function parseBody(request: Request): Promise<{ captchaData: string } | Response> {
	let body: { captchaData: string };
	try {
		body = (await request.json()) as { captchaData: string };
	} catch {
		return new Response('Invalid request', { status: 400 });
	}
	if (!body.captchaData) {
		return new Response('Invalid request', { status: 400 });
	}
	return body;
}

async function validateWithPolicyApi(
	request: Request,
	clientIp: string | null,
	config: MonocleConfig
): Promise<Response> {
	const body = await parseBody(request);
	if (body instanceof Response) return body;

	try {
		const policyDecision = await evaluateAssessment(
			body.captchaData,
			await config.getSecretKey(),
			POLICY_BACKEND
		);

		// Before the allow/deny branch so both outcomes are captured. NOT called
		// on the fail-open catch paths below: no decision exists there. The helper
		// is a no-op unless LOG_ASSESSMENT is enabled and can never throw.
		logAssessment(config, policyDecision, body.captchaData.length);

		if (!policyDecision.allowed) {
			return config.blockResponseType
				? buildBlockResponse(config)
				: new Response('Blocked', { status: 403 });
		}

		const headers = await setSecureCookie(clientIp, config);
		return new Response('Captcha validated successfully', { status: 200, headers });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		// A 4xx (other than the transient ones below) means the API is REACHABLE
		// and rejected THIS request (undecryptable/invalid assessment, or a bad
		// SECRET_KEY). Never mint a cookie on that: it would wave through attackers
		// POSTing junk and silently disable the challenge site-wide on a
		// misconfigured key. Deny, so a systemic auth failure surfaces loudly.
		// 404 (no policy = allow), 408 (request timeout) and 429 (rate limited)
		// are transient/expected, so they stay fail-open below.
		if (
			error instanceof MonocleAPIError &&
			error.status >= 400 &&
			error.status < 500 &&
			![404, 408, 429].includes(error.status)
		) {
			console.error(`Policy API rejected the request (status ${error.status}); denying.`);
			return config.blockResponseType
				? buildBlockResponse(config)
				: new Response('Blocked', { status: 403 });
		}
		if (!(error instanceof MonocleAPIError && error.status === 404)) {
			console.error(`Validation failed, failing open: ${message}`);
		}
		// Genuine outage (network error, timeout, 5xx), no policy (404), or a
		// malformed 2xx body: fail open and CRITICALLY set the cookie. A 200
		// without it sends the visitor back cookieless into an endless
		// re-challenge loop for as long as the API is down.
		try {
			const headers = await setSecureCookie(clientIp, config);
			return new Response('Captcha validated successfully', { status: 200, headers });
		} catch (cookieError: unknown) {
			// Even the cookie could not be minted (e.g. secret store unavailable).
			// Still fail open for this request; the next request will retry.
			console.error(`Could not set fail-open cookie: ${String(cookieError)}`);
			return new Response('Captcha validated successfully', { status: 200 });
		}
	}
}

/**
 * A block-redirect target is customer config, but must still be a plain http(s)
 * URL with no control bytes: a `javascript:`/`data:` value would run in the
 * interstitial's `location.href`, and any control byte (NUL, CR, LF) would make
 * `new Response` throw on the header, routing a would-be block through the
 * verify catch's fail-open. An unsafe value falls back to the HTML block page.
 */
function isSafeRedirectUrl(url: string): boolean {
	if (/[\u0000-\u001f\u007f]/.test(url)) return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Builds the block response based on config.
 * Sets X-Block-Action header so the captcha page JS can handle it correctly:
 *   - "redirect:<url>" -> captcha JS navigates window.location
 *   - "html"           -> captcha JS replaces the document with the HTML body
 * Falls back to a plain 403 if blockResponseType is not set.
 */
function buildBlockResponse(config: MonocleConfig): Response {
	if (
		config.blockResponseType === 'redirect' &&
		config.blockRedirectUrl &&
		isSafeRedirectUrl(config.blockRedirectUrl)
	) {
		return new Response(null, {
			status: 403,
			headers: { 'X-Block-Action': `redirect:${config.blockRedirectUrl}` },
		});
	}

	// Already parsed and clamped in loadConfig; 403 when unset.
	const statusCode = config.blockStatusCode ?? 403;
	const title = escapeHtml(config.blockPageTitle ?? 'Access Denied');
	const body = escapeHtml(config.blockResponseBody ?? 'This request has been blocked');

	const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;color:#000}
    .container{text-align:center;max-width:500px;padding:2rem}
    h1{font-size:1.3rem;font-weight:300;margin:0}
    p{color:#6b7280}
    a{color:inherit;text-decoration:none}
    @media(prefers-color-scheme:dark){body{background:#000;color:#fff}}
  </style>
</head>
<body>
  <div class="container">
    <a href="https://spur.us" target="_blank" rel="noreferrer" style="display:inline-block;margin-bottom:25px;color:inherit">
      <svg width="103" height="31" viewBox="0 0 103 31" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19.7852 0C20.1147 5.07404 20.293 10.1515 20.293 15.2256C20.293 20.2996 20.114 25.3742 19.7852 30.4482H18.7705C18.4517 25.3742 18.2627 20.2996 18.2627 15.2256C18.2627 10.1515 18.4517 5.07404 18.7705 0H19.7852ZM15.7314 13.6963C16.0219 14.1289 16.2379 14.6054 16.2393 15.1055C16.2378 15.6054 16.0219 16.0541 15.7314 16.4873L8.12012 27.3975H7.10449C7.11677 27.3747 12.4345 17.501 13.4482 16.9941V16.2334C11.9258 16.2334 0 15.7256 0 15.7256V14.7109C0 14.7109 11.9258 14.2031 13.4482 14.2031V13.4424C12.4333 12.4274 7.10449 3.03906 7.10449 3.03906H8.12012L15.7314 13.6963ZM31.46 3.03906C31.46 3.03906 26.1312 12.4274 25.1162 13.4424V14.2031C26.6386 14.2031 38.5645 14.7109 38.5645 14.7109V15.7256C38.5645 15.7256 26.6386 16.2334 25.1162 16.2334V16.9941C26.1301 18.008 31.4485 27.3772 31.46 27.3975H30.4443L22.833 16.4873C22.5426 16.0541 22.3266 15.6054 22.3252 15.1055C22.3265 14.6055 22.5425 14.1289 22.833 13.6963L30.4443 3.03906H31.46Z" fill="currentColor"/>
        <path d="M55.1006 4.30478C57.3442 4.30478 59.1414 4.91644 60.3525 5.91415C61.4354 6.80621 62.0735 8.02574 62.1504 9.47177H60.7646C60.6621 8.28297 60.3506 7.26242 59.5117 6.53915C58.5822 5.7377 57.1174 5.40146 54.9531 5.40146C53.0971 5.40148 51.7113 5.68071 50.7871 6.37997C49.8259 7.10722 49.4668 8.20368 49.4668 9.55966C49.4668 10.6771 49.6973 11.5631 50.457 12.2403C51.1714 12.877 52.2923 13.2647 53.8721 13.6183V13.6192L57.4131 14.419H57.4141C59.2766 14.8373 60.549 15.4299 61.3525 16.1866C62.1365 16.9249 62.5136 17.8563 62.5137 19.0645C62.5137 20.7006 61.8356 22.1164 60.5938 23.1319C59.3448 24.1533 57.4945 24.793 55.1318 24.7931C52.7652 24.7931 50.8782 24.1665 49.6055 23.1349C48.4619 22.2078 47.7894 20.9337 47.7041 19.4112H49.0918C49.2128 20.6678 49.5676 21.7387 50.4658 22.4962C51.4547 23.3299 52.9937 23.6905 55.248 23.6905C57.2092 23.6905 58.6665 23.3959 59.6367 22.6778C60.6458 21.9309 61.0303 20.8054 61.0303 19.4151C61.0302 18.2689 60.7913 17.3773 60.0234 16.6974C59.3026 16.0592 58.175 15.6691 56.5977 15.3009H56.5967L52.9092 14.4464H52.9102C51.1363 14.0285 49.923 13.4509 49.1562 12.713C48.4086 11.9933 48.045 11.0821 48.0449 9.88583C48.0449 8.27841 48.7036 6.89983 49.8945 5.91415C51.0923 4.9229 52.8597 4.30484 55.1006 4.30478Z" fill="currentColor" stroke="currentColor"/>
        <path d="M66.499 10.6494V11.9268H67.7012C67.6543 11.9738 67.6077 12.0219 67.5635 12.0732C67.116 12.5936 66.8514 13.2894 66.6943 14.168C66.5373 15.0467 66.4795 16.1542 66.4795 17.5361C66.4795 18.918 66.5373 20.0263 66.6943 20.9072C66.8513 21.788 67.1149 22.4866 67.5615 23.0098C67.6145 23.0718 67.6707 23.1297 67.7275 23.1855H66.5L66.499 23.6855L66.4932 29.9424L65.4502 29.9385L65.4561 10.6494H66.499ZM72.5684 9.98438C74.5285 9.98441 76.0257 10.6369 77.043 11.8506C78.0714 13.0776 78.665 14.945 78.665 17.4736C78.665 19.9956 78.0376 21.9043 76.9824 23.1729C75.9365 24.4302 74.4272 25.1123 72.5371 25.1123C70.5635 25.1123 69.2779 24.5235 68.4463 23.6934C68.718 23.8297 69.0152 23.9335 69.3379 24.0078C70.0471 24.171 70.9049 24.2119 71.9121 24.2119C72.9204 24.2119 73.7816 24.1687 74.4961 24.0029C75.2225 23.8344 75.8272 23.5331 76.2881 23.001C76.7418 22.4771 77.0139 21.7786 77.1768 20.8975C77.3395 20.0169 77.4004 18.9113 77.4004 17.5361C77.4004 16.1533 77.3395 15.045 77.1768 14.165C77.0139 13.2847 76.7414 12.5888 76.2861 12.0693C75.8238 11.5418 75.2182 11.248 74.4932 11.085C73.7798 10.9246 72.9191 10.8848 71.9121 10.8848C70.9053 10.8848 70.0476 10.9244 69.3389 11.085C69.0375 11.1533 68.7582 11.2463 68.501 11.3682C69.364 10.5458 70.6765 9.98438 72.5684 9.98438Z" fill="currentColor" stroke="currentColor"/>
        <path d="M82.7783 10.6533V19.8164C82.7783 20.642 82.8128 21.3371 82.9316 21.9062C83.052 22.4823 83.2668 22.9693 83.6553 23.3408C84.0413 23.7099 84.5465 23.9146 85.1494 24.0312C85.7487 24.1472 86.4868 24.1846 87.3789 24.1846C88.4548 24.1846 89.343 24.1055 90.0479 23.8643C89.2365 24.5233 88.0898 25.0098 86.4258 25.0098C84.9127 25.0097 83.7482 24.6245 82.9629 23.8818C82.2511 23.2086 81.7888 22.1814 81.7129 20.7002V10.6533H82.7783ZM93.1328 24.6191H92.1523V23.2705H91.0791C91.1113 23.2407 91.1441 23.2113 91.1748 23.1797C91.9439 22.3864 92.0967 21.1426 92.0967 19.5215V10.6514L93.1328 10.6494V24.6191Z" fill="currentColor" stroke="currentColor"/>
        <path d="M97.4409 10.6504V11.9141H98.5288C98.5091 11.9318 98.4884 11.9484 98.4692 11.9668C97.6676 12.7364 97.483 13.9608 97.4829 15.5879L97.4429 24.6152H96.4106V10.6504H97.4409ZM102.5 11.0195H102.262C101.149 11.0195 100.228 11.0965 99.5015 11.3535C100.247 10.7126 101.197 10.1666 102.5 10.0215V11.0195Z" fill="currentColor" stroke="currentColor"/>
      </svg>
    </a>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;

	return new Response(html, {
		status: statusCode,
		headers: {
			'Content-Type': 'text/html',
			'X-Block-Action': 'html',
		},
	});
}
