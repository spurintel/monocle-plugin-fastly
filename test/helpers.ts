/** Stores seeded per test, a fetch that dispatches on the named backend, and a FetchEvent. */

import { expect, vi } from 'vitest';

import { SimpleCache, resetSimpleCache } from './doubles/cache';
import { setConfigStore } from './doubles/config-store';
import { setSecretStore } from './doubles/secret-store';

export const CLIENT_IP = '93.184.216.34';
export const KEY = '0123456789abcdef'.repeat(4);
export const CV = 'a'.repeat(64);
export const DEPLOYMENT = 'deploy-1';
export const POLICY_URL = 'https://decrypt.mcl.spur.us/api/v1/policy';

/** hosts=[example.com], allow_ips 203.0.113.0/24; enforcement is the published index. */
export const BASE_CONFIG = { hosts: ['example.com'], assess: ['/*'], allow_ips: ['203.0.113.0/24'] };
/** Enforce /api/cart/add (action) and /members/* (content), as the dashboard publishes them. */
export const BASE_INDEX = { v: 1, p: { '/api/cart/add': 1 }, s: { '/members': 1 } };

export function seedStores(
	options: {
		config?: object;
		index?: object;
		items?: Record<string, string>;
		exclusions?: string[];
		secrets?: Record<string, string>;
	} = {}
): void {
	setConfigStore('monocle_config', {
		v: '2',
		id: DEPLOYMENT,
		cv: CV,
		cfgn: '1',
		'cfg.0': JSON.stringify(options.config ?? BASE_CONFIG),
		enfn: '1',
		'enf.0': JSON.stringify(options.index ?? BASE_INDEX),
		PUBLISHABLE_KEY: 'pk_live_123',
		...(options.exclusions && { x: JSON.stringify(options.exclusions) }),
		...options.items,
	});
	setSecretStore('monocle_secrets', { SECRET_KEY: 'sk_test', COOKIE_SECRET_VALUE: KEY, ...options.secrets });
	resetSimpleCache();
	// A current, empty snapshot: no exemptions, and no refresh scheduled behind the test.
	SimpleCache.set(
		'mcl:bots',
		JSON.stringify({ v: 2, source: 'https://feeds.example', expiresAt: Math.floor(Date.now() / 1000) + 3600, ranges: [] }),
		3600
	);
}

type Init = RequestInit & { backend?: string; cacheOverride?: unknown };
type Responder = (request: Request, init: Init) => Response | Promise<Response>;
interface Reply {
	backend: string;
	method?: string;
	url?: string;
	respond: Responder;
	calls: { request: Request; init: Init }[];
}

/** Every expected outbound request is registered on its backend first; anything else fails the test. */
export class Backends {
	private readonly replies: Reply[] = [];
	readonly unexpected: string[] = [];

	on(backend: string, respond: Responder, match: { method?: string; url?: string } = {}): Reply {
		const reply: Reply = { backend, respond, calls: [], ...match };
		this.replies.push(reply);
		return reply;
	}

	origin(method: string, url: string, status: number, body: BodyInit | null, init: ResponseInit = {}): Reply {
		return this.on('origin', () => new Response(status === 204 ? null : body, { ...init, status }), { method, url });
	}

	policy(allowed: boolean, ip = CLIENT_IP): Reply {
		return this.on('monocle_policy', () => policyResponse(allowed, ip));
	}

	install(): void {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: Init) => {
				const request = input instanceof Request ? input : new Request(input, init);
				const backend = init?.backend;
				const index = this.replies.findIndex(
					(reply) =>
						reply.backend === backend &&
						(!reply.method || reply.method === request.method) &&
						(!reply.url || reply.url === request.url)
				);
				if (index < 0) {
					this.unexpected.push(`${backend} ${request.method} ${request.url}`);
					throw new Error('Unexpected outbound request');
				}
				const reply = this.replies.splice(index, 1)[0]!;
				reply.calls.push({ request, init: init ?? {} });
				return reply.respond(request, init ?? {});
			})
		);
	}

	assertQuiet(): void {
		expect(this.unexpected).toEqual([]);
	}
}

export function policyResponse(allowed: boolean, ip = CLIENT_IP): Response {
	return new Response(
		JSON.stringify({
			allowed,
			decisionId: 'decision',
			assessment: { id: 'assessment', ip, ipv6: '', ts: new Date().toISOString(), complete: true },
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

export function request(
	path: string,
	options: {
		method?: string;
		navigation?: boolean;
		cookie?: string;
		body?: string;
		headers?: Record<string, string>;
		origin?: string;
	} = {}
): Request {
	const origin = options.origin ?? 'https://example.com';
	const headers = new Headers(options.headers ?? {});
	if (!headers.has('Origin')) headers.set('Origin', origin);
	if (options.navigation) headers.set('Sec-Fetch-Mode', 'navigate');
	if (options.cookie) headers.set('Cookie', options.cookie);
	if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
	return new Request(`${origin}${path}`, { method: options.method ?? 'GET', headers, body: options.body });
}

export interface FakeEvent {
	event: FetchEvent;
	/** Work scheduled with waitUntil, awaited by the test when it matters. */
	settled(): Promise<void>;
}

export function fakeEvent(req: Request, ip: string | null = CLIENT_IP): FakeEvent {
	const tasks: Promise<unknown>[] = [];
	const event = {
		request: req,
		client: { address: ip ?? '' },
		waitUntil: (task: Promise<unknown>) => {
			tasks.push(task);
		},
		respondWith: () => {},
	} as unknown as FetchEvent;
	return { event, settled: async () => void (await Promise.all(tasks)) };
}

/** The Cookie header value a browser would send back. */
export function cookiesFrom(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((sc) => sc.split(';')[0]!)
		.join('; ');
}
