import { hmacSha256, toHex } from '@spur.us/monocle-edge-core';

/**
 * Builds the time-limited chaining signature sent to the customer's existing
 * service: `<unix seconds>.0x<hmac-sha256 hex>`. The HMAC is keyed with the
 * UTF-8 bytes of the shared secret STRING (not hex-decoded), because the VCL
 * guard recomputes it as `digest.hmac_sha256("<secret>", timestamp)`, which
 * keys on the literal string. The `0x` prefix and lowercase hex likewise match
 * VCL's output so the guard can compare the values directly.
 *
 * Signed with edge-core's HMAC rather than `crypto.subtle.sign`, which js-compute
 * gets wrong on most calls after the first in an instance.
 *
 * `nowSeconds` is injectable for tests; production callers omit it.
 */
export async function buildChainAuthHeader(
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
	const timestamp = String(nowSeconds);
	const mac = await hmacSha256(new TextEncoder().encode(secret), new TextEncoder().encode(timestamp));
	return `${timestamp}.0x${toHex(mac)}`;
}
