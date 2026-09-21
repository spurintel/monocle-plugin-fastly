import {
	assembleRuntime,
	createHmacSealer,
	type CidrSet,
	type Runtime,
	type Sealer,
} from '@spur.us/monocle-edge-core';

import type { Protection, Secrets } from './config';

/** Reads the cookie secret the first time a request seals or opens anything. */
function lazySealer(cookieSecret: () => Promise<string>): Sealer {
	let inner: Promise<Sealer> | undefined;
	const sealer = () => (inner ??= cookieSecret().then(createHmacSealer));
	return {
		seal: async (plaintext) => (await sealer()).seal(plaintext),
		open: async (sealed) => {
			try {
				return await (await sealer()).open(sealed);
			} catch {
				return null;
			}
		},
	};
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
			sealer: lazySealer(secrets.cookieSecret),
			crawlerRanges,
			exclusions: protection.exclusions,
			routeIndex: protection.routeIndex,
		}))();
}
