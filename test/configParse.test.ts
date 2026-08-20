import { describe, it, expect } from 'vitest';
import { parseCacheRules, parseProtectedPaths } from '../src/configParse';

describe('parseCacheRules', () => {
	it('parses a valid rule array', () => {
		expect(parseCacheRules('[{"prefix":"/","ttl":60,"swr":30}]')).toEqual([
			{ prefix: '/', ttl: 60, swr: 30 },
		]);
	});

	it('drops entries without a string prefix', () => {
		expect(parseCacheRules('[{"ttl":60},{"prefix":"/api"}]')).toEqual([{ prefix: '/api' }]);
	});

	it('strips a string ttl but keeps the rule (a bad ttl must never reach CacheOverride)', () => {
		expect(parseCacheRules('[{"prefix":"/","ttl":"60"}]')).toEqual([{ prefix: '/' }]);
	});

	it('strips negative and non-finite ttl/swr values', () => {
		expect(parseCacheRules('[{"prefix":"/","ttl":-1,"swr":-0.5}]')).toEqual([{ prefix: '/' }]);
		// JSON.parse turns 1e999 into Infinity; NaN cannot appear in valid JSON,
		// so a literal NaN fails the parse and yields no rules.
		expect(parseCacheRules('[{"prefix":"/","ttl":1e999}]')).toEqual([{ prefix: '/' }]);
		expect(parseCacheRules('[{"prefix":"/","ttl":NaN}]')).toEqual([]);
	});

	it('strips a non-string or empty surrogateKey but keeps the rule', () => {
		expect(parseCacheRules('[{"prefix":"/","surrogateKey":42}]')).toEqual([{ prefix: '/' }]);
		expect(parseCacheRules('[{"prefix":"/","surrogateKey":""}]')).toEqual([{ prefix: '/' }]);
	});

	it('keeps a valid rule alongside an invalid one', () => {
		expect(parseCacheRules('[{"prefix":"/api","ttl":"bad"},{"prefix":"/img","ttl":300}]')).toEqual([
			{ prefix: '/api' },
			{ prefix: '/img', ttl: 300 },
		]);
	});

	it('yields no rules for missing/invalid JSON or a non-array (never throws)', () => {
		expect(parseCacheRules(undefined)).toEqual([]);
		expect(parseCacheRules('')).toEqual([]);
		expect(parseCacheRules('not json')).toEqual([]);
		expect(parseCacheRules('{"prefix":"/"}')).toEqual([]);
	});
});

describe('parseProtectedPaths', () => {
	it('parses a host→patterns map and lower-cases the host', () => {
		expect(parseProtectedPaths('{"WWW.Example.com":["/login*","/api/*"]}')).toEqual({
			'www.example.com': ['/login*', '/api/*'],
		});
	});

	it('drops patterns that do not start with "/"', () => {
		expect(parseProtectedPaths('{"a.com":["/ok","bad","/also-ok"]}')).toEqual({
			'a.com': ['/ok', '/also-ok'],
		});
	});

	it('fails SAFE (returns undefined = everything protected) on bad/empty input', () => {
		// undefined must mean "protect everything", never "protect nothing".
		expect(parseProtectedPaths(undefined)).toBeUndefined();
		expect(parseProtectedPaths('not json')).toBeUndefined();
		expect(parseProtectedPaths('["/login*"]')).toBeUndefined(); // array, not object
		expect(parseProtectedPaths('{"a.com":[]}')).toBeUndefined(); // no valid patterns
		expect(parseProtectedPaths('{"a.com":["no-slash"]}')).toBeUndefined();
	});
});
