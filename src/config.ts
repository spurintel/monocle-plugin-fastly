/** The deployment as the dashboard published it to the Config Store and the Secret Store. */

import { ConfigStore } from 'fastly:config-store';
import { SecretStore } from 'fastly:secret-store';
import {
	compileConfig,
	compileExclusions,
	parseRouteIndex,
	type CompiledConfig,
	type DeploymentConfig,
	type Exclusion,
	type RouteIndex,
} from '@spur.us/monocle-edge-core';

import { parseCacheRules, type CacheRule } from './cacheRules';
import { CONFIG_STORE_NAME, SECRET_STORE_NAME } from './constants';

/** What reaching the customer's origin needs. Read best-effort: a request is forwarded even when it cannot be protected. */
export interface OriginSettings {
	/** Host to send the origin; undefined forwards the visitor's own. */
	host?: string;
	/** Shared secret of the chained service, when chaining. */
	chainSecret?: string;
	cacheRules: CacheRule[];
	/** One more header the client address is stamped into, for an origin that reads its own. */
	clientIpHeader?: string;
}

/** What the shared pipeline runs on. */
export interface Protection {
	config: CompiledConfig;
	deploymentId: string;
	clearanceVersion: string;
	publishableKey: string;
	exclusions: Exclusion[];
	/** Enforcement as the dashboard published it: lookups, never patterns compiled here. */
	routeIndex: RouteIndex;
}

/** Secret Store reads, each made once and only when a request needs it. */
export interface Secrets {
	secretKey(): Promise<string>;
	cookieSecret(): Promise<string>;
}

export class ConfigUnavailable extends Error {}

const MAX_CHUNKS = 500;
const CLEARANCE_VERSION = /^[a-f0-9]{64}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function item(store: ConfigStore, key: string): string | undefined {
	const value = store.get(key);
	return value === null || value === '' ? undefined : value;
}

export function loadOriginSettings(store = new ConfigStore(CONFIG_STORE_NAME)): OriginSettings {
	const header = item(store, 'CLIENT_IP_HEADER');
	return {
		host: item(store, 'ORIGIN_HOST'),
		chainSecret: item(store, 'CHAIN_SECRET'),
		cacheRules: parseCacheRules(item(store, 'CACHE_RULES')),
		clientIpHeader: header && HEADER_NAME.test(header) ? header : undefined,
	};
}

/** Throws `ConfigUnavailable` on anything short of a complete, valid deployment. */
export function loadProtection(store = new ConfigStore(CONFIG_STORE_NAME)): Protection {
	if (item(store, 'v') !== '2') throw new ConfigUnavailable('edge contract version');
	const deploymentId = item(store, 'id');
	const clearanceVersion = item(store, 'cv');
	const publishableKey = item(store, 'PUBLISHABLE_KEY');
	if (!deploymentId || !clearanceVersion || !CLEARANCE_VERSION.test(clearanceVersion) || !publishableKey)
		throw new ConfigUnavailable('deployment keys');

	let raw: DeploymentConfig;
	try {
		raw = JSON.parse(chunked(store, 'cfg')) as DeploymentConfig;
	} catch {
		throw new ConfigUnavailable('config JSON');
	}
	let config: CompiledConfig;
	try {
		config = compileConfig(raw);
	} catch (error) {
		throw new ConfigUnavailable(error instanceof Error ? error.message : 'config');
	}
	const routeIndex = parseRouteIndex(chunked(store, 'enf'));
	if (!routeIndex) throw new ConfigUnavailable('route index');
	return {
		config,
		deploymentId,
		clearanceVersion,
		publishableKey,
		exclusions: compileExclusions(parseList(item(store, 'x'))),
		routeIndex,
	};
}

/** `<key>n` chunks under `<key>.0` … `<key>.n-1`, joined. A missing chunk is a torn publish. */
function chunked(store: ConfigStore, key: string): string {
	const chunks = Number(item(store, `${key}n`));
	if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) throw new ConfigUnavailable(`${key}n`);
	let value = '';
	for (let i = 0; i < chunks; i++) {
		const chunk = store.get(`${key}.${i}`);
		if (chunk === null) throw new ConfigUnavailable(`${key}.${i}`);
		value += chunk;
	}
	return value;
}

function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
	} catch {
		return [];
	}
}

export function loadSecrets(store = new SecretStore(SECRET_STORE_NAME)): Secrets {
	const read = async (key: string) => (await store.get(key))?.plaintext() ?? '';
	let secretKey: Promise<string> | undefined;
	let cookieSecret: Promise<string> | undefined;
	return {
		secretKey: () => (secretKey ??= read('SECRET_KEY')),
		cookieSecret: () => (cookieSecret ??= read('COOKIE_SECRET_VALUE')),
	};
}
