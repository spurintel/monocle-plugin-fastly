/**
 * Stamps the client-IP headers on an origin-bound request. Monocle is the edge
 * trust boundary, so every one of these headers is OVERWRITTEN from the edge's
 * own view of the connection, never appended to or passed through: an inbound
 * client-supplied value must never reach the origin as a spoofed identity.
 * When no client IP is available the headers are stripped for the same reason.
 *
 * `clientIpHeader` is the optional custom header name some origins read the
 * visitor IP from (e.g. Salesforce Commerce Cloud's Client IP Header Name,
 * which rejects the standard headers). It follows the exact same rules.
 */
export function setClientIpHeaders(
	headers: Headers,
	clientIp: string | null,
	clientIpHeader?: string
): void {
	const names = ['X-Forwarded-For', 'Fastly-Client-IP'];
	if (clientIpHeader) names.push(clientIpHeader);

	for (const name of names) {
		if (clientIp) {
			headers.set(name, clientIp);
		} else {
			headers.delete(name);
		}
	}
}
