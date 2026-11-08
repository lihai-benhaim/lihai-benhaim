import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isTerminal, type Draft, type PlatformId } from "@studio/core";
import type { LinkedAccount } from "@studio/publishers";
import type { Secrets } from "./secrets.ts";

/**
 * State for a single-owner studio: drafts and linked accounts in one JSON
 * file on the NAS volume. Writes are atomic (temp file + rename) and
 * serialised. Tokens are encrypted before they touch disk.
 *
 * Swap for Postgres when there is more than one user (docs/roadmap.md).
 */
interface PersistedState {
  version: 1;
  drafts: Draft[];
  accounts: { ownerId: string; platform: PlatformId; sealed: string }[];
}

export class StateStore {
  private drafts = new Map<string, Draft>();
  private accounts = new Map<string, LinkedAccount>();
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string | null;
  private readonly secrets: Secrets;

  private constructor(file: string | null, secrets: Secrets) {
    this.file = file;
    this.secrets = secrets;
  }

  /** In-memory store, for tests. */
  static memory(secrets: Secrets): StateStore {
    return new StateStore(null, secrets);
  }

  static async open(file: string, secrets: Secrets): Promise<StateStore> {
    const store = new StateStore(file, secrets);
    try {
      const state = JSON.parse(await readFile(file, "utf8")) as PersistedState;
      for (const d of state.drafts) store.drafts.set(d.id, d);
      for (const a of state.accounts) store.accounts.set(key(a.ownerId, a.platform), JSON.parse(secrets.decrypt(a.sealed)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return store;
  }

  // Drafts

  getDraft(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  listDrafts(ownerId: string): Draft[] {
    return [...this.drafts.values()].filter((d) => d.ownerId === ownerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The newest draft that is still in progress, if any. */
  activeDraft(ownerId: string): Draft | undefined {
    return this.listDrafts(ownerId).find((d) => !isTerminal(d.status));
  }

  async saveDraft(draft: Draft): Promise<void> {
    this.drafts.set(draft.id, draft);
    await this.persist();
  }

  // Accounts

  getAccount(ownerId: string, platform: PlatformId): LinkedAccount | undefined {
    return this.accounts.get(key(ownerId, platform));
  }

  listAccounts(ownerId: string): LinkedAccount[] {
    return [...this.accounts.entries()].filter(([k]) => k.startsWith(`${ownerId}:`)).map(([, a]) => a);
  }

  async saveAccount(ownerId: string, account: LinkedAccount): Promise<void> {
    this.accounts.set(key(ownerId, account.platform), account);
    await this.persist();
  }

  async removeAccount(ownerId: string, platform: PlatformId): Promise<boolean> {
    const removed = this.accounts.delete(key(ownerId, platform));
    if (removed) await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    this.writing = this.writing.then(async () => {
      const state: PersistedState = {
        version: 1,
        drafts: [...this.drafts.values()],
        accounts: [...this.accounts.entries()].map(([k, a]) => ({
          ownerId: k.slice(0, k.lastIndexOf(":")),
          platform: a.platform,
          sealed: this.secrets.encrypt(JSON.stringify(a)),
        })),
      };
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, file);
    });
    return this.writing;
  }
}

function key(ownerId: string, platform: PlatformId): string {
  return `${ownerId}:${platform}`;
}
