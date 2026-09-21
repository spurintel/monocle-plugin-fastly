/** The handler end to end in Node, against the store, cache and rewriter doubles. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRAWLER_FEEDS, FAILURE_THRESHOLD } from '@spur.us/monocle-edge-core';

import { crawlerBackendName } from '../src/backends';
import { handle } from '../src/handler';
import { cachedValue, SimpleCache } from './doubles/cache';
import { setConfigStore } from './doubles/config-store';
import { secretReads } from './doubles/secret-store';
import { Backends, CLIENT_IP, cookiesFrom, fakeEvent, request, seedStores } from './helpers';

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

	it.each<Record<string, string>>([{ cfgn: '2' }, { enfn: '2' }, { 'enf.0': '{"v":9}' }])('treats a torn publish %j as unreadable', async (items) => {
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
		expect(await state.json()).toMatchObject({ hint: { verdict: null }, degraded: false, ip: CLIENT_IP });
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

	it('reads the Policy key only for the endpoints', async () => {
		backends.origin('GET', `${ORIGIN}/page`, 200, 'served');
		await run(request('/page'));
		expect(secretReads.get('SECRET_KEY')).toBeUndefined();
		await mintClearance();
		expect(secretReads.get('SECRET_KEY')).toBe(1);
	});
});

describe('hosts and schemes', () => {
	it('forwards a host the deployment does not name, unassessed', async () => {
		const origin = backends.origin('GET', 'https://other.example/members/page', 200, 'served');
		const response = await run(request('/members/page', { navigation: true, origin: 'https://other.example' }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('served');
		expect(origin.calls[0]!.request.headers.get('X-Monocle-Skip')).toBeNull();
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

describe('the breaker in the POP cache', () => {
	it('survives between requests: enforced traffic serves open once Policy has failed enough', async () => {
		for (let i = 0; i < FAILURE_THRESHOLD; i++) {
			backends.on('monocle_policy', () => new Response('down', { status: 503 }));
			const response = await run(
				request('/__mcl/verify', { method: 'POST', body: JSON.stringify({ captchaData: 'bundle' }) })
			);
			expect(response.status).toBe(503);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		expect(cachedValue('mcl:brk')).toContain('"status":"open"');
		const origin = backends.origin('POST', `${ORIGIN}/api/cart/add`, 200, 'served open');
		const response = await run(request('/api/cart/add', { method: 'POST', body: '{}' }));
		expect(response.status).toBe(200);
		expect(origin.calls[0]!.request.headers.get('X-Monocle-Degraded')).toBe('1');
	});
});

it('names a crawler backend from its feed host', () => {
	expect(crawlerBackendName('developers.google.com')).toBe('crawler_developers_google_com');
});
