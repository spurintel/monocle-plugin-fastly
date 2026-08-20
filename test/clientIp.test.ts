import { describe, expect, it } from 'vitest';
import { setClientIpHeaders } from '../src/clientIp';

describe('setClientIpHeaders', () => {
	it('overwrites the standard headers with the client IP', () => {
		const headers = new Headers({
			'X-Forwarded-For': '198.51.100.99, 203.0.113.1',
			'Fastly-Client-IP': '198.51.100.99',
		});

		setClientIpHeaders(headers, '203.0.113.7');

		expect(headers.get('X-Forwarded-For')).toBe('203.0.113.7');
		expect(headers.get('Fastly-Client-IP')).toBe('203.0.113.7');
	});

	it('overwrites a forged custom header when one is configured', () => {
		const headers = new Headers({ 'X-Spur-Client-IP': '198.51.100.99' });

		setClientIpHeaders(headers, '203.0.113.7', 'X-Spur-Client-IP');

		expect(headers.get('X-Spur-Client-IP')).toBe('203.0.113.7');
	});

	it('strips all client-IP headers when no client IP is available', () => {
		const headers = new Headers({
			'X-Forwarded-For': '198.51.100.99',
			'Fastly-Client-IP': '198.51.100.99',
			'X-Spur-Client-IP': '198.51.100.99',
		});

		setClientIpHeaders(headers, null, 'X-Spur-Client-IP');

		expect(headers.get('X-Forwarded-For')).toBeNull();
		expect(headers.get('Fastly-Client-IP')).toBeNull();
		expect(headers.get('X-Spur-Client-IP')).toBeNull();
	});

	it('leaves a forged custom header alone when none is configured', () => {
		// Without CLIENT_IP_HEADER config the plugin does not know the name, so the
		// header passes through exactly as before this feature (non-SFCC apps).
		const headers = new Headers({ 'X-Spur-Client-IP': '198.51.100.99' });

		setClientIpHeaders(headers, '203.0.113.7');

		expect(headers.get('X-Spur-Client-IP')).toBe('198.51.100.99');
	});
});
