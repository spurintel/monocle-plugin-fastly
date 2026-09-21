/** `fastly:secret-store` for tests, counting reads per key. */

const stores = new Map<string, Map<string, string>>();
export const secretReads = new Map<string, number>();

export function setSecretStore(name: string, entries: Record<string, string>): void {
	stores.set(name, new Map(Object.entries(entries)));
	secretReads.clear();
}

export class SecretStoreEntry {
	constructor(private readonly value: string) {}
	plaintext(): string {
		return this.value;
	}
}

export class SecretStore {
	constructor(private readonly name: string) {}
	async get(key: string): Promise<SecretStoreEntry | null> {
		secretReads.set(key, (secretReads.get(key) ?? 0) + 1);
		const value = stores.get(this.name)?.get(key);
		return value === undefined ? null : new SecretStoreEntry(value);
	}
}
