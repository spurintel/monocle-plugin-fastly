import {
	assembleRuntime,
	createHmacSealer,
	type CidrSet,
	type Runtime,
	type Sealer,
} from '@spur.us/monocle-edge-core';

import { ConfigUnavailable, type Protection, type Secrets } from './config';

/**
 * The cookie sealer, built before the pipeline runs.
 *
 * It used to be built on first use, which kept the Secret Store off the hot path but put
 * the failure in the wrong place: `open` swallowed a bad key and read every cookie as
 * absent, while `seal` threw from inside the pipeline, where a throw is a 503 rather than
 * a pass-through. A store missing COOKIE_SECRET_VALUE therefore answered 503 to every
 * enforced path and to verify, for as long as it stayed missing. Reading it here costs one
 * Secret Store lookup per request and turns that outage into the marked pass-through every
 * other unusable config value already gets.
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

/** Every request compiles its own runtime; nothing survives between requests on Compute. */
export function buildRuntime(
	protection: Protection,
	secrets: Secrets,
	crawlerRanges: CidrSet,
	/** Only the endpoints call Policy; every other request leaves the Secret Store alone. */
	needsSecretKey: boolean
): Promise<Runtime> {
	return (async () =>
		assembleRuntime({
			config: protection.config,
			deploymentId: protection.deploymentId,
			clearanceVersion: protection.clearanceVersion,
			publishableKey: protection.publishableKey,
			secretKey: needsSecretKey ? await secrets.secretKey() : '',
			sealer: await buildSealer(secrets.cookieSecret),
			crawlerRanges,
			exclusions: protection.exclusions,
			routeIndex: protection.routeIndex,
		}))();
}
