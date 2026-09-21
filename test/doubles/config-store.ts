/** `fastly:config-store` for tests: named stores seeded per test. */

const stores = new Map<string, Map<string, string>>();

export function setConfigStore(name: string, entries: Record<string, string>): void {
	stores.set(name, new Map(Object.entries(entries)));
}

export class ConfigStore {
	constructor(private readonly name: string) {}
	get(key: string): string | null {
		return stores.get(this.name)?.get(key) ?? null;
	}
}
