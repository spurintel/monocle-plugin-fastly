import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logAssessment } from '../src/assessmentLog';
import { ASSESSMENT_LOG_ENDPOINT } from '../src/constants';
import type { MonocleConfig } from '../src/config';
import type { MonoclePolicyDecision } from '../src/policy';

// vi.mock factories are hoisted above imports, so the spies they close over
// must be hoisted too.
const h = vi.hoisted(() => ({
	ctor: vi.fn<(endpoint: string) => void>(),
	logFn: vi.fn<(line: string) => void>(),
}));

vi.mock('fastly:logger', () => ({
	Logger: class {
		constructor(endpoint: string) {
			h.ctor(endpoint);
		}
		log(line: string) {
			h.logFn(line);
		}
	},
}));

const assessment = { vpn: false, anon: false, cc: 'US', id: 'test-assessment-id' };
const decision: MonoclePolicyDecision = { allowed: false, reason: 'bot-detected', assessment };

function configWith(logAssessmentFlag: boolean): MonocleConfig {
	return { logAssessment: logAssessmentFlag } as MonocleConfig;
}

let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	h.ctor.mockReset();
	h.logFn.mockReset();
});

describe('logAssessment', () => {
	it('is a no-op when disabled (the default)', () => {
		logAssessment(configWith(false), decision, 42);
		// Absent key: only the exact string "true" in the Config Store enables it,
		// so a config built without the flag must behave like "off" too.
		logAssessment({} as MonocleConfig, decision, 42);

		expect(consoleLog).not.toHaveBeenCalled();
		expect(h.ctor).not.toHaveBeenCalled();
		expect(h.logFn).not.toHaveBeenCalled();
	});

	it('when enabled, console.logs ONE JSON line and writes it to the named endpoint', () => {
		logAssessment(configWith(true), decision, 42);

		const expected = JSON.stringify({ monocle: 'assessment', captchaLen: 42, ...decision });
		expect(consoleLog).toHaveBeenCalledTimes(1);
		expect(consoleLog).toHaveBeenCalledWith(expected);
		// Same line goes to the customer-created endpoint, by its exact name.
		expect(h.ctor).toHaveBeenCalledWith(ASSESSMENT_LOG_ENDPOINT);
		expect(h.logFn).toHaveBeenCalledWith(expected);
		// The line parses back and carries the full raw decision.
		expect(JSON.parse(consoleLog.mock.calls[0][0] as string)).toEqual({
			monocle: 'assessment',
			captchaLen: 42,
			allowed: false,
			reason: 'bot-detected',
			assessment,
		});
	});

	it('logs nothing when the policy API withholds the assessment', () => {
		// An org without the logging entitlement gets a decision with no
		// assessment, so there is nothing worth writing a line about.
		logAssessment(configWith(true), { allowed: true, reason: 'ok' }, 42);

		expect(consoleLog).not.toHaveBeenCalled();
		expect(h.ctor).not.toHaveBeenCalled();
		expect(h.logFn).not.toHaveBeenCalled();
	});

	it('omits captchaLen when not provided', () => {
		logAssessment(configWith(true), decision);
		expect(consoleLog).toHaveBeenCalledWith(JSON.stringify({ monocle: 'assessment', ...decision }));
	});

	it('swallows a Logger construction failure (endpoint does not exist) silently', () => {
		// The usual production case: the customer never created the endpoint.
		h.ctor.mockImplementation(() => {
			throw new Error('no such log endpoint');
		});
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => logAssessment(configWith(true), decision, 7)).not.toThrow();

		// console.log still happened (live tail keeps working), and no error spam.
		expect(consoleLog).toHaveBeenCalledTimes(1);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('swallows a Logger.log() write failure silently', () => {
		h.logFn.mockImplementation(() => {
			throw new Error('write failed');
		});
		expect(() => logAssessment(configWith(true), decision, 7)).not.toThrow();
		expect(consoleLog).toHaveBeenCalledTimes(1);
	});

	it('never throws even if the decision cannot be stringified', () => {
		const circular: Record<string, unknown> = { allowed: true };
		circular.self = circular;
		expect(() =>
			logAssessment(configWith(true), circular as MonoclePolicyDecision, 7)
		).not.toThrow();
	});
});
