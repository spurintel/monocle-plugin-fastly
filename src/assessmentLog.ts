import { Logger } from 'fastly:logger';
import { ASSESSMENT_LOG_ENDPOINT } from './constants';
import type { MonocleConfig } from './config';
import type { MonoclePolicyDecision } from './policy';

/**
 * Logs one JSON line with the raw policy decision for a verify, when (and only
 * when) `LOG_ASSESSMENT` is "true" in the Config Store (default OFF).
 *
 * The line always goes to `console.log`, so it shows up in Fastly's live log
 * tail with zero customer setup. It is ALSO written, best-effort, to the
 * optional customer-created `monocle_assessments` named log endpoint for
 * retention/streaming. That endpoint usually does not exist, so the Logger
 * write is wrapped separately and any failure is swallowed silently (no error
 * spam per request).
 *
 * This helper must be INCAPABLE of throwing: it runs inside the verify path
 * and a logging failure must never change the allow/deny response.
 */
export function logAssessment(
	config: MonocleConfig,
	decision: MonoclePolicyDecision,
	captchaLen?: number
): void {
	if (config.logAssessment !== true) return;
	// The policy API omits the assessment when the plan lacks the logging
	// entitlement, and a log line with no assessment in it is just noise.
	if (decision.assessment == null) return;
	try {
		const line = JSON.stringify({
			monocle: 'assessment',
			...(captchaLen === undefined ? {} : { captchaLen }),
			...decision,
		});
		console.log(line);
		try {
			new Logger(ASSESSMENT_LOG_ENDPOINT).log(line);
		} catch {
			// The named endpoint is optional and usually absent; swallow silently.
		}
	} catch {
		// Never let logging affect the verify response.
	}
}
