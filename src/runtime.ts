import {
	assembleRuntime,
	createHmacSealer,
	type CidrSet,
	type Runtime,
	type Sealer,
} from '@spur.us/monocle-edge-core';

import { ConfigUnavailable, type Protection, type Secrets } from './config';

/**
 * The cookie sealer, built before the pipeline runs, so a missing or malformed key is a config
 * failure and passes the request through marked. Built on first use instead, `open` would read
 * every cookie as absent and `seal` would throw inside the pipeline, where a throw is a 503 on
 * every enforced path and on verify. The cost is one Secret Store lookup per request.
 */
async function buildSealer(cookieSecret: () => Promise<string>): Promise<Sealer> {
	let key: string;
	try {
		key = await cookieSecret();
	} catch {
		throw new ConfigUnavailable('cookie secret');
	}
	try {
		return createHmacSealer(key);
	} catch {
		throw new ConfigUnavailable('cookie secret');
	}
}

/**
 * Every request compiles its own runtime; nothing survives between requests on Compute. The
 * Policy key is read by verify itself, only when it asks Policy, so every other request leaves
 * the Secret Store's key alone.
 */
export function buildRuntime(protection: Protection, secrets: Secrets, crawlerRanges: CidrSet): Promise<Runtime> {
	return (async () =>
		assembleRuntime({
			config: protection.config,
			deploymentId: protection.deploymentId,
			clearanceVersion: protection.clearanceVersion,
			publishableKey: protection.publishableKey,
			secretKey: secrets.secretKey,
			sealer: await buildSealer(secrets.cookieSecret),
			crawlerRanges,
			exclusions: protection.exclusions,
			routeIndex: protection.routeIndex,
		}))();
}
