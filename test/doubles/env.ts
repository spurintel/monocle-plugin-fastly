/** `fastly:env` for tests: a production-shaped host, so plain HTTP is not rewritten. */
export function env(name: string): string {
	return name === 'FASTLY_HOSTNAME' ? 'cache-lhr7345-LHR' : '';
}
