/** The handler end to end in Node, against the store, cache and rewriter doubles. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOW_TTL_SECONDS, CRAWLER_FEEDS, FAILURE_THRESHOLD, UNVERIFIED_PASS_SECONDS } from '@spur.us/monocle-edge-core';

import { crawlerBackendName } from '../src/backends';
import { handle } from '../src/handler';
import { cachedValue, SimpleCache } from './doubles/cache';
import { setConfigStore } from './doubles/config-store';
import { handoffs, resetHandoffs } from './doubles/websocket';
import { secretReads } from './doubles/secret-store';
import { Backends, CLIENT_IP, cookiesFrom, fakeEvent, KEY, request, seedStores } from './helpers';

let backends: Backends;
const ORIGIN = 'https://example.com';
const HTML = { headers: { 'Content-Type': 'text/html' } };

beforeEach(() => {
	seedStores();
	backends = new Backends();
	backends.install();
});
afterEach(() => {
	backends.assertQuiet();
	vi.unstubAllGlobals();
});

const run = (req: Request, ip: string | null = CLIENT_IP) => handle(fakeEvent(req, ip).event);

async function mintClearance(allowed = true): Promise<string> {
	backends.policy(allowed);
	const response = await run(
		request('/__mcl/verify', { method: 'POST', body: JSON.stringify({ captchaData: 'bundle' }) })
	);
	expect(response.status).toBe(allowed ? 200 : 403);
	return cookiesFrom(response);
}

describe('when the deployment cannot be read', () => {
	it('forwards the request unprotected and marked, with the origin settings that could be read', async () => {
		setConfigStore('monocle_config', { ORIGIN_HOST: 'origin.internal', PUBLISHABLE_KEY: 'pk' });
		const origin = backends.origin('GET', 'https://origin.internal/page', 200, 'served');
		const response = await run(request('/page', { cookie: '__Host-mcl_c=x; cart=7' }));
		expect(response.status).toBe(200);
		const sent = origin.calls[0]!.request;
		expect(sent.headers.get('X-Monocle-Skip')).toBe('config');
		expect(sent.headers.get('Host')).toBe('origin.internal');
		expect(sent.headers.get('Cookie')).toBe('cart=7');
	});

	// A chained service refuses anything unsigned, so a pass-through without the signature
	// would turn our outage into a 403 for every visitor.
	it('still signs for a chained service when it forwards unprotected', async () => {
		setConfigStore('monocle_config', {
			ORIGIN_HOST: 'monocle-example.global.ssl.fastly.net',
			CHAIN_SECRET: 'chainsecret',
			PUBLISHABLE_KEY: 'pk',
		});
		const origin = backends.origin('GET', 'https://monocle-example.global.ssl.fastly.net/page', 200, 'served');
		await run(request('/page'));
		const sent = origin.calls[0]!.request;
		expect(sent.headers.get('X-Monocle-Skip')).toBe('config');
		expect(sent.headers.get('X-Monocle-Chain-Auth')).toMatch(/^\d{10}\.0x[0-9a-f]{64}$/);
	});

	it.each<Record<string, string>>([
		{ cfgn: '2' },
		{ enfn: '2' },
		{ 'enf.0': '{"v":9}' },
		// Read as "nothing excluded", this would start protecting what the customer excluded.
		{ x: '["/hooks/*"' },
		{ x: '{"/hooks/*":1}' },
	])('treats a torn publish %j as unreadable', async (items) => {
		seedStores({ items });
		const origin = backends.origin('GET', `${ORIGIN}/page`, 200, 'served');
		await run(request('/page'));
		expect(origin.calls[0]!.request.headers.get('X-Monocle-Skip')).toBe('config');
	});
});

describe('protection', () => {
	it('challenges a cold navigation on an enforced page and answers state', async () => {
		const challenge = await run(request('/members/page', { navigation: true }));
		expect(challenge.status).toBe(503);
		expect(await challenge.text()).toContain('/__mcl/verify');
		const state = await run(request('/__mcl/state'));
		expect(state.status).toBe(200);
		expect(await state.json()).toMatchObject({ hint: { verdict: null }, ip: CLIENT_IP });
	});

	it('mints through the Policy backend, then serves the cleared page injected through the rewriter', async () => {
		const cookie = await mintClearance();
		expect(cookie).toContain('__Host-mcl_c=');
		backends.origin('GET', `${ORIGIN}/members/page`, 200, '<html><head></head><body><p>secret</p></body></html>', HTML);
		const page = await run(request('/members/page', { navigation: true, cookie }));
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('<p>secret</p>');
		expect(html).toMatch(/<script src="\/__mcl\/[0-9a-f]{16}\/mcl\.js" defer nonce="[0-9a-f]{32}"><\/script><\/body>/);
		expect(page.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('refuses a cookieless action and serves a blocked verdict its page', async () => {
		const refused = await run(request('/api/cart/add', { method: 'POST' }));
		expect(refused.status).toBe(403);
		expect(refused.headers.get('X-Monocle-Challenge-Required')).toBe('1');
		const cookie = await mintClearance(false);
		const blocked = await run(request('/members/page', { navigation: true, cookie }));
		expect(blocked.status).toBe(403);
		expect(await blocked.text()).toContain('Access denied');
	});

	it('passes an excluded path untouched, even one the config enforces', async () => {
		seedStores({ exclusions: ['/api/*'] });
		const origin = backends.origin('POST', `${ORIGIN}/api/cart/add`, 200, 'added');
		const response = await run(request('/api/cart/add', { method: 'POST', cookie: '__Host-mcl_c=x', body: '{}' }));
		expect(response.status).toBe(200);
		expect(origin.calls[0]!.request.headers.get('Cookie')).toBeNull();
		expect((await run(request('/members/page', { navigation: true }))).status).toBe(503);
	});

	it('reads the Policy key only when verify asks Policy', async () => {
		backends.origin('GET', `${ORIGIN}/page`, 200, 'served');
		await run(request('/page'));
		expect(secretReads.get('SECRET_KEY')).toBeUndefined();
		await mintClearance();
		expect(secretReads.get('SECRET_KEY')).toBe(1);
	});

	// How a request spells verify must never decide whether Policy is asked: an empty key is
	// our outage, which passes the visitor.
	it.each(['/__mcl/v%65rify', '/%5f_mcl/verify', '/__MCL/verify'])(
		'asks Policy for verify spelled %s',
		async (path) => {
			backends.policy(true);
			const response = await run(request(path, { method: 'POST', body: JSON.stringify({ captchaData: 'bundle' }) }));
			expect(response.status).toBe(200);
			// Policy's own allow, not the unverified pass an empty key would have minted.
			expect(response.headers.getSetCookie().join()).toContain(`Max-Age=${ALLOW_TTL_SECONDS}`);
			expect(secretReads.get('SECRET_KEY')).toBe(1);
		}
	);
});

describe('hosts and schemes', () => {
	// Fastly delivers only the domains attached to this service, and they all reach the
	// same origin. Forwarding an unnamed one unassessed, with the chain signature
	// attached, was a route around every enforced path.
	it('assesses a host the deployment does not name as the site', async () => {
		const response = await run(request('/members/page', { navigation: true, origin: 'https://other.example' }));
		expect(response.status).toBe(503);
		expect(await response.text()).toContain('/__mcl/verify');
	});

	it('sends plain HTTP to HTTPS rather than serving it', async () => {
		const response = await run(request('/members/page', { origin: 'http://example.com' }));
		expect(response.status).toBe(301);
		expect(response.headers.get('Location')).toBe('https://example.com/members/page');
	});
});

describe('the origin leg', () => {
	it('rewrites the host, asserts the client address and signs for the chained service', async () => {
		seedStores({ items: { ORIGIN_HOST: 'monocle-example.global.ssl.fastly.net', CHAIN_SECRET: 'chainsecret', CLIENT_IP_HEADER: 'True-Client-IP' } });
		const origin = backends.origin('GET', 'https://monocle-example.global.ssl.fastly.net/page', 200, 'served');
		await run(
			request('/page', {
				headers: { 'X-Forwarded-For': '198.51.100.1', 'True-Client-IP': '198.51.100.1', 'X-Monocle-Chain-Auth': 'forged', 'X-Monocle-Chain-Secret': 'forged' },
			})
		);
		const sent = origin.calls[0]!.request;
		expect(sent.headers.get('Host')).toBe('monocle-example.global.ssl.fastly.net');
		expect(sent.headers.get('X-Forwarded-For')).toBe(CLIENT_IP);
		expect(sent.headers.get('Fastly-Client-IP')).toBe(CLIENT_IP);
		expect(sent.headers.get('True-Client-IP')).toBe(CLIENT_IP);
		expect(sent.headers.get('X-Monocle-Chain-Auth')).toMatch(/^\d{10}\.0x[0-9a-f]{64}$/);
		expect(sent.headers.get('X-Monocle-Chain-Secret')).toBeNull();
	});

	it('strips the client-address headers when the platform offers no address', async () => {
		const origin = backends.origin('GET', `${ORIGIN}/page`, 200, 'served');
		await run(request('/page', { headers: { 'X-Forwarded-For': '198.51.100.1' } }), null);
		expect(origin.calls[0]!.request.headers.get('X-Forwarded-For')).toBeNull();
	});

	it('applies the first matching cloned cache rule', async () => {
		seedStores({ items: { CACHE_RULES: JSON.stringify([{ prefix: '/static', ttl: 60, swr: 30 }]) } });
		const asset = backends.origin('GET', `${ORIGIN}/static/app.css`, 200, 'body{}');
		await run(request('/static/app.css'));
		expect(asset.calls[0]!.init.cacheOverride).toMatchObject({ mode: 'override', init: { ttl: 60, swr: 30 } });
		const page = backends.origin('GET', `${ORIGIN}/page`, 200, 'served');
		await run(request('/page'));
		expect(page.calls[0]!.init.cacheOverride).toBeUndefined();
	});

	it('answers 502 when the origin cannot be reached', async () => {
		backends.on('origin', () => {
			throw new Error('connection refused');
		});
		expect((await run(request('/page'))).status).toBe(502);
	});
});

describe('the crawler snapshot', () => {
	const CRAWLER_IP = '66.249.66.1';

	it('is refreshed off the hot path through the feed backends, and exempts a verified crawler afterwards', async () => {
		SimpleCache.purge('mcl:bots');
		for (const feed of CRAWLER_FEEDS) {
			backends.on(crawlerBackendName(new URL(feed).hostname), () =>
				Response.json({ prefixes: [{ ipv4Prefix: '66.249.64.0/19' }] })
			);
		}
		const first = fakeEvent(request('/members/page', { navigation: true }), CRAWLER_IP);
		expect((await handle(first.event)).status).toBe(503);
		await first.settled();
		expect(cachedValue('mcl:bots')).toContain('66.249.64.0/19');

		backends.origin('GET', `${ORIGIN}/members/page`, 200, 'indexed');
		const second = await run(request('/members/page', { navigation: true }), CRAWLER_IP);
		expect(second.status).toBe(200);
	});

	// A snapshot is valid for a day. Cached for an hour, it vanished every hour and the
	// request that noticed exempted nobody until the refresh landed.
	it('keeps exempting from a snapshot due for refresh while the refresh runs', async () => {
		const now = Math.floor(Date.now() / 1000);
		SimpleCache.set(
			'mcl:bots',
			JSON.stringify({ v: 2, source: 'https://feeds.example', expiresAt: now + 7200, ranges: ['66.249.64.0/19'] }),
			7200
		);
		for (const feed of CRAWLER_FEEDS) {
			backends.on(crawlerBackendName(new URL(feed).hostname), () =>
				Response.json({ prefixes: [{ ipv4Prefix: '66.249.64.0/19' }] })
			);
		}
		backends.origin('GET', `${ORIGIN}/members/page`, 200, 'indexed');
		const event = fakeEvent(request('/members/page', { navigation: true }), CRAWLER_IP);
		expect((await handle(event.event)).status).toBe(200);
		await event.settled();
		expect(JSON.parse(cachedValue('mcl:bots')!).expiresAt).toBeGreaterThan(now + 86_000);
	});

	it('does not stampede: one refresh per lease', async () => {
		SimpleCache.purge('mcl:bots');
		let fetches = 0;
		for (const feed of CRAWLER_FEEDS) {
			backends.on(crawlerBackendName(new URL(feed).hostname), () => {
				fetches++;
				return Response.json({ prefixes: [{ ipv4Prefix: '66.249.64.0/19' }] });
			});
		}
		const events = [fakeEvent(request('/__mcl/state')), fakeEvent(request('/__mcl/state'))];
		await Promise.all(events.map((e) => handle(e.event)));
		await Promise.all(events.map((e) => e.settled()));
		expect(fetches).toBe(CRAWLER_FEEDS.length);
	});
});

describe('when Policy cannot answer', () => {
	const verify = () =>
		run(request('/__mcl/verify', { method: 'POST', body: JSON.stringify({ captchaData: 'bundle' }) }));

	// Our failure never answers the visitor: they are passed, briefly, and asked again soon.
	it('passes the visitor for ten minutes', async () => {
		backends.on('monocle_policy', () => new Response('down', { status: 503 }));
		const response = await verify();
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie().join()).toContain(`Max-Age=${UNVERIFIED_PASS_SECONDS}`);
	});

	// The breaker lives in the POP cache, so it survives between requests. It only decides
	// whether verify asks Policy: no Policy reply is registered for the last verify.
	it('stops asking a Policy that keeps failing, but never opens enforcement', async () => {
		for (let i = 0; i < FAILURE_THRESHOLD; i++) {
			backends.on('monocle_policy', () => new Response('down', { status: 503 }));
			await verify();
		}
		expect(cachedValue('mcl:brk')).toContain('"status":"open"');
		expect((await verify()).status).toBe(200);
		expect((await run(request('/api/cart/add', { method: 'POST', body: '{}' }))).status).toBe(403);
	});
});

it('names a crawler backend from its feed host', () => {
	expect(crawlerBackendName('developers.google.com')).toBe('crawler_developers_google_com');
});

describe('failures of ours reach the origin, never the visitor', () => {
	// The sealer used to be built on first use, so a missing key threw from inside
	// the pipeline, where a throw is a 503. Every enforced path and verify answered
	// 503 for as long as the key stayed missing.
	it.each([
		['missing', undefined],
		['too short', KEY.slice(0, 63)],
		['not hex', 'z'.repeat(64)],
	])('passes traffic marked when the cookie secret is %s', async (_label, value) => {
		seedStores({ secrets: { COOKIE_SECRET_VALUE: value as string } });
		const reply = backends.origin('GET', `${ORIGIN}/members/page`, 200, 'ok');
		const response = await run(request('/members/page', { navigation: true }));
		expect(response.status).toBe(200);
		expect(reply.calls[0]!.request.headers.get('X-Monocle-Skip')).toBe('config');
	});

	it('answers verify without a 503 when the cookie secret is missing', async () => {
		seedStores({ secrets: { COOKIE_SECRET_VALUE: undefined as unknown as string } });
		backends.origin('POST', `${ORIGIN}/__mcl/verify`, 200, 'ok');
		const response = await run(
			request('/__mcl/verify', { method: 'POST', body: JSON.stringify({ captchaData: 'bundle' }) })
		);
		expect(response.status).not.toBe(503);
	});
});

describe('a host we name, arriving with a port', () => {
	// The adapter used to treat a URL carrying a port as "not our host" and forward it, so
	// `Host: example.com:8443` walked straight past every enforced path. Core drops the port,
	// so this is the ordinary challenge. No origin reply is registered, so the backends double
	// fails the test if the request is forwarded.
	it('is challenged like the host it names', async () => {
		const response = await run(
			new Request('https://example.com:8443/members/page', { headers: { 'Sec-Fetch-Mode': 'navigate' } })
		);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain('/__mcl/verify');
	});

	it('assesses an unnamed host arriving with a port as the site too', async () => {
		const response = await run(
			new Request('https://other.example:8443/members/page', { headers: { 'Sec-Fetch-Mode': 'navigate' } })
		);
		expect(response.status).toBe(503);
	});
});

describe('the POP cache never holds an enforced response', () => {
	it('passes the cache on an enforced path and keeps the cloned rule elsewhere', async () => {
		seedStores({ items: { CACHE_RULES: JSON.stringify([{ prefix: '/', ttl: 600 }]) } });
		const cookie = await mintClearance();
		const enforced = backends.origin('GET', `${ORIGIN}/members/page`, 200, 'ok', HTML);
		await run(request('/members/page', { cookie, navigation: true }));
		expect(enforced.calls[0]!.init.cacheOverride).toMatchObject({ mode: 'pass' });

		const open = backends.origin('GET', `${ORIGIN}/public/page`, 200, 'ok', HTML);
		await run(request('/public/page', { cookie, navigation: true }));
		expect(open.calls[0]!.init.cacheOverride).toMatchObject({ mode: 'override', init: { ttl: 600 } });
	});

	// The pipeline says whether the route was enforced, and an excluded path never is,
	// so the customer's cache rules apply to it even inside an enforced section.
	it('keeps the cache override on a path excluded from an enforced section', async () => {
		seedStores({
			items: { CACHE_RULES: JSON.stringify([{ prefix: '/', ttl: 600 }]) },
			exclusions: ['/members/public*'],
		});
		const reply = backends.origin('GET', `${ORIGIN}/members/public`, 200, 'ok', HTML);
		await run(request('/members/public', { navigation: true }));
		expect(reply.calls[0]!.init.cacheOverride).toBeDefined();
	});

	// The fail-open path has no deployment to ask which paths are enforced, so it must
	// not cache: a personalised page stored during an outage outlives it.
	it('caches nothing while the deployment cannot be read', async () => {
		setConfigStore('monocle_config', {
			ORIGIN_HOST: 'example.com',
			CACHE_RULES: JSON.stringify([{ prefix: '/', ttl: 600 }]),
		});
		const reply = backends.origin('GET', `${ORIGIN}/members/page`, 200, 'ok', HTML);
		await run(request('/members/page', { navigation: true }));
		expect(reply.calls[0]!.init.cacheOverride).toMatchObject({ mode: 'pass' });
	});
});

describe('WebSockets', () => {
	const upgrade = (path: string) => request(path, { headers: { Upgrade: 'websocket' } });

	beforeEach(() => resetHandoffs());

	// The origin leg cannot carry a socket, so a proxied upgrade reached the origin and
	// its 101 could not be relayed: every WebSocket on the domain answered 502.
	it('hands an assessed path to Fastly to proxy, never through the origin leg', async () => {
		const response = await run(upgrade('/public/live'));
		expect(response.status).toBe(101);
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]!.backend).toBe('origin');
	});

	// A long-lived connection into a protected action must not open without clearance.
	it('leaves an enforced path to the pipeline, which refuses it', async () => {
		const response = await run(upgrade('/members/live'));
		expect(response.status).toBe(403);
		expect(handoffs).toHaveLength(0);
	});

	// Refusing every enforced upgrade refused visitors with clearance, allow-listed
	// addresses and everyone during an outage, on the Upgrade header alone. The pipeline
	// decides an upgrade as it decides anything else; only the transport is Fastly's.
	it('hands off an enforced upgrade that carries clearance', async () => {
		const cookie = await mintClearance();
		const response = await run(
			request('/members/live', { cookie, headers: { Upgrade: 'websocket' } })
		);
		expect(response.status).toBe(101);
		expect(handoffs).toHaveLength(1);
	});

	it('hands off an enforced upgrade from an allow-listed address', async () => {
		const response = await run(upgrade('/members/live'), '203.0.113.9');
		expect(response.status).toBe(101);
	});

	it('hands off an excluded path inside an enforced section, untouched', async () => {
		seedStores({ exclusions: ['/members/live'] });
		const response = await run(upgrade('/members/live'));
		expect(response.status).toBe(101);
	});

	// The handoff does not go through the origin leg, so it has to repeat its
	// obligations: a chained service refuses anything without the signature, and the
	// visitor's own cookies and headers must not travel with a connection we then lose
	// sight of.
	it('signs the chain and strips the visitor before handing off', async () => {
		seedStores({ items: { CHAIN_SECRET: 'chain-secret', ORIGIN_HOST: 'internal.example' } });
		const response = await run(
			request('/public/live', {
				cookie: '__Host-mcl_c=forged; cart=keep',
				headers: { Upgrade: 'websocket', 'X-Monocle-Skip': 'spoofed', 'X-Real-IP': '1.2.3.4' },
			})
		);
		expect(response.status).toBe(101);
		const sent = handoffs[0]!.request;
		expect(sent.headers.get('X-Monocle-Chain-Auth')).toMatch(/^\d+\.0x[0-9a-f]{64}$/);
		expect(sent.headers.get('Cookie')).toBe('cart=keep');
		expect(sent.headers.get('X-Monocle-Skip')).toBeNull();
		expect(sent.headers.get('X-Real-IP')).toBeNull();
		expect(sent.headers.get('X-Forwarded-For')).toBe(CLIENT_IP);
		expect(sent.headers.get('host')).toBe('internal.example');
	});

	it('leaves an ordinary request alone', async () => {
		backends.origin('GET', `${ORIGIN}/public/page`, 200, 'ok', HTML);
		await run(request('/public/page'));
		expect(handoffs).toHaveLength(0);
	});
});
