import { COOKIE_NAME } from './constants';
import type { MonocleConfig } from './config';

/**
 * The cookie payload (`<clientIp>|<expiryUnixSeconds>`) is not secret; it only
 * needs to be tamper-proof so a client cannot forge or extend it. We therefore
 * sign it with HMAC-SHA256 rather than encrypt it.
 *
 * Note: the Cloudflare worker uses AES-GCM, but Fastly's Compute runtime does
 * not implement AES-GCM in SubtleCrypto (only HMAC / RSASSA sign+verify). Since
 * each edge issues and validates its own cookie with its own COOKIE_SECRET,
 * using HMAC here has no cross-provider impact.
 */
async function importHmacKey(hexSecret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		hexToBuf(hexSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
}

/**
 * Issues a signed cookie binding the client IP (event.client.address) with a
 * 1-hour expiry. If no client IP is available (rare), the cookie is issued
 * WITHOUT an IP binding rather than bound to an unmatchable value: a cookie
 * that can never validate would trap the visitor in an endless challenge
 * loop. Signature and expiry still apply.
 */
export async function setSecureCookie(clientIp: string | null, config: MonocleConfig): Promise<Headers> {
	if (!clientIp) {
		console.error('No client IP available on the request context; issuing an IP-unbound cookie.');
	}
	const expiryTime = Math.floor(Date.now() / 1000) + 3600;
	const payloadBytes = new TextEncoder().encode(`${clientIp ?? ''}|${expiryTime}`);

	const key = await importHmacKey(await config.getCookieSecret());
	const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);

	const cookieValue = `${bufToHex(payloadBytes)}.${bufToHex(new Uint8Array(signature))}`;

	const headers = new Headers();
	// Intentionally a session cookie (no Max-Age/Expires): the signed payload's
	// own expiry is the authority, and the browser dropping it on restart just
	// triggers a fresh challenge. Keeping it session-scoped also stops a
	// shared/kiosk browser from carrying a verified session across users.
	headers.append(
		'Set-Cookie',
		`${COOKIE_NAME}=${cookieValue}; Secure; HttpOnly; Path=/; SameSite=Lax`
	);
	return headers;
}

/**
 * Validates the signed cookie: verifies the HMAC, then checks the bound client
 * IP and expiry.
 */
export async function validateCookie(
	cookieHeader: string | null,
	clientIp: string | null,
	config: MonocleConfig
): Promise<boolean> {
	if (!cookieHeader) {
		return false;
	}

	const cookies = cookieHeader.split(';').map(c => c.trim());
	const mclValidCookie = cookies.find(c => c.startsWith(`${COOKIE_NAME}=`));
	if (!mclValidCookie) {
		return false;
	}

	const cookieValue = mclValidCookie.slice(`${COOKIE_NAME}=`.length);
	const [payloadHex, signatureHex] = cookieValue.split('.');
	if (!payloadHex || !signatureHex) {
		return false;
	}

	const payloadBytes = hexToBuf(payloadHex);

	// Key import and verify both run inside the try: a bad/empty cookie secret or
	// malformed signature bytes must fail the cookie (re-challenge), never throw
	// out of here and surface as a 500.
	let valid: boolean;
	try {
		const key = await importHmacKey(await config.getCookieSecret());
		valid = await crypto.subtle.verify('HMAC', key, hexToBuf(signatureHex), payloadBytes);
	} catch (error) {
		console.error(`Error verifying cookie signature: ${error}`);
		return false;
	}
	if (!valid) {
		return false;
	}

	const [clientIpAddress, expiryTime] = new TextDecoder().decode(payloadBytes).split('|');

	// An empty stored IP means the cookie was issued without an IP binding (no
	// client IP was available at issue time); skip the comparison rather than
	// failing a cookie that could never match anything.
	if (clientIpAddress !== '' && clientIp !== clientIpAddress) {
		// Deliberately does not log either IP: this fires routinely (mobile/CGNAT
		// clients rotate IPs mid-session) and visitor IPs do not belong in logs.
		console.error('Cookie client IP mismatch; re-challenging.');
		return false;
	}

	if (Math.floor(Date.now() / 1000) >= parseInt(expiryTime ?? '0', 10)) {
		console.error('Cookie has expired.');
		return false;
	}

	return true;
}

function bufToHex(buffer: Uint8Array): string {
	return Array.prototype.map.call(buffer, (x: number) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
	// Reject odd-length or non-hex input rather than coercing a trailing nibble or
	// non-hex chars into bytes: an empty buffer fails the HMAC check and
	// re-challenges. Valid secrets and payloads are always even-length hex.
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return new Uint8Array();
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}
