import { HTMLRewritingStream } from 'fastly:html-rewriter';
import type { HtmlRewriteOps } from '@spur.us/monocle-edge-core';

/** Every meta CSP, then the tag at the end of the body. A document with no body gets it at the end. */
export async function rewriteHtml(html: Uint8Array, ops: HtmlRewriteOps): Promise<Uint8Array<ArrayBuffer>> {
	let injected = false;
	let unsupported: unknown;
	const rewriter = new HTMLRewritingStream()
		.onElement('meta[http-equiv]', (element) => {
			if (element.getAttribute('http-equiv')?.toLowerCase() !== 'content-security-policy') return;
			try {
				element.setAttribute('content', ops.metaCsp(element.getAttribute('content') ?? ''));
			} catch (error) {
				unsupported = error;
			}
		})
		.onElement('body', (element) => {
			if (injected) return;
			element.append(ops.tag, { escapeHTML: false });
			injected = true;
		});
	const rewritten = new Uint8Array(
		await new Response(new Response(html).body!.pipeThrough(rewriter)).arrayBuffer()
	);
	if (unsupported) throw unsupported;
	if (injected) return rewritten;
	const tag = new TextEncoder().encode(ops.tag);
	const joined = new Uint8Array(rewritten.length + tag.length);
	joined.set(rewritten);
	joined.set(tag, rewritten.length);
	return joined;
}
