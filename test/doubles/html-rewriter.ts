/**
 * `fastly:html-rewriter` for tests: the two selectors the plugin registers, over the buffered
 * document. Good enough to prove the plugin wires the rewriter; not an HTML parser.
 */

type Handler = (element: Element) => void;

export class Element {
	private appended = '';
	constructor(
		private tag: string,
		readonly tagName: string
	) {}
	getAttribute(name: string): string | null {
		const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(this.tag);
		return match ? match[1]! : null;
	}
	setAttribute(name: string, value: string): void {
		this.tag = this.tag.replace(
			new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`, 'i'),
			(_match, before: string, after: string) => `${before}${value}${after}`
		);
	}
	append(content: string): void {
		this.appended += content;
	}
	rendered(): { tag: string; appended: string } {
		return { tag: this.tag, appended: this.appended };
	}
}

export class HTMLRewritingStream extends TransformStream<Uint8Array, Uint8Array> {
	private readonly handlers: { selector: string; handler: Handler }[];

	constructor() {
		const handlers: { selector: string; handler: Handler }[] = [];
		const chunks: Uint8Array[] = [];
		super({
			transform(chunk) {
				chunks.push(chunk);
			},
			flush(controller) {
				let text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
				for (const { selector, handler } of handlers) text = apply(text, selector, handler);
				controller.enqueue(new TextEncoder().encode(text));
			},
		});
		this.handlers = handlers;
	}

	onElement(selector: string, handler: Handler): this {
		this.handlers.push({ selector, handler });
		return this;
	}
}

function apply(text: string, selector: string, handler: Handler): string {
	if (selector === 'meta[http-equiv]') {
		return text.replace(/<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, (tag) => {
			const element = new Element(tag, 'meta');
			handler(element);
			return element.rendered().tag;
		});
	}
	if (selector === 'body') {
		const open = /<body\b[^>]*>/i.exec(text);
		if (!open) return text;
		const element = new Element(open[0], 'body');
		handler(element);
		const { appended } = element.rendered();
		const close = text.toLowerCase().lastIndexOf('</body>');
		return close >= 0 ? text.slice(0, close) + appended + text.slice(close) : text + appended;
	}
	throw new Error(`Test rewriter has no support for selector ${selector}`);
}
