import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow, type SearchObject } from 'imapflow';
import type { Account, Config } from './config.js';
import { localRoot } from './config.js';
import type { CredentialStore } from './credentials.js';
import {
  attachmentContent,
  decodeSource,
  type Mail,
  parseMail,
  type Source,
  sourceId,
} from './mail.js';
import { readOnlyClient } from './readonly-client.js';

export interface Query {
  since?: string;
  before?: string;
  text?: string;
  limit?: number;
  cursor?: string;
}
export interface Failure {
  account: string;
  mailbox?: string;
  sourceId?: string;
  code: string;
}
export interface Page {
  items: Mail[];
  nextCursor: string | null;
  matched: number;
  coverage: {
    account: string;
    mailbox: string;
    uidValidity: string;
    since: string | null;
    before: string | null;
    mode: string;
    limited: boolean;
  };
  errors: Failure[];
}
type ClientFactory = (account: Account, password: string) => ImapFlow;
export class Reader {
  private tails = new Map<string, Promise<void>>();
  constructor(
    readonly config: Config,
    private credentials: CredentialStore,
    private factory: ClientFactory = (a, p) =>
      new ImapFlow({
        host: a.imap.host,
        port: a.imap.port,
        secure: a.imap.secure,
        auth: { user: a.username ?? a.email, pass: p },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
        tls: { rejectUnauthorized: true },
      }),
  ) {}
  account(id: string): Account {
    const account = this.config.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Unknown account');
    return account;
  }
  async session<T>(id: string, action: (client: ImapFlow) => Promise<T>): Promise<T> {
    const account = this.account(id);
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(id, tail);
    await previous;
    try {
      const password = await this.credentials.read(account.credentialRef);
      let client: ImapFlow | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = readOnlyClient(this.factory(account, password));
        candidate.on('error', () => {});
        try {
          await candidate.connect();
          client = candidate;
          break;
        } catch {
          candidate.close();
          if (attempt === 1)
            throw new Error(
              'IMAP_CONNECT_FAILED: check application password, TLS and server locally',
            );
        }
      }
      try {
        return await action(client!);
      } finally {
        try {
          await client!.logout();
        } catch {
          client!.close();
        }
      }
    } finally {
      release();
      if (this.tails.get(id) === tail) this.tails.delete(id);
    }
  }
  async folders(id: string) {
    return this.session(id, async (c) =>
      (await c.list()).map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse ?? null,
        selectable: !f.flags.has('\\Noselect'),
      })),
    );
  }
  async raw(client: ImapFlow, uid: number): Promise<{ raw: Buffer; flags: string[] }> {
    const info = await client.fetchOne(String(uid), { size: true, flags: true }, { uid: true });
    if (!info) throw new Error('MAIL_NOT_FOUND');
    if (info.size === undefined || info.size > this.config.maxMessageBytes)
      throw new Error('MESSAGE_TOO_LARGE_OR_SIZE_UNKNOWN');
    // ImapFlow uses BODY.PEEK for source fetch. Never add STORE, markRead or \Seen.
    const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('MAIL_NOT_FOUND');
    if (msg.source.length > this.config.maxMessageBytes) throw new Error('MESSAGE_TOO_LARGE');
    return { raw: msg.source, flags: Array.from(msg.flags ?? []) };
  }
  validity(client: ImapFlow): string {
    if (!client.mailbox || !client.mailbox.uidValidity) throw new Error('UIDVALIDITY_MISSING');
    return String(client.mailbox.uidValidity);
  }
  async get(id: string): Promise<Mail> {
    const source = decodeSource(id);
    return this.session(source.account, async (c) => {
      const lock = await c.getMailboxLock(source.mailbox, { readOnly: true });
      try {
        if (this.validity(c) !== source.uidValidity)
          throw new Error('UIDVALIDITY_CHANGED: rescan mailbox');
        const { raw, flags } = await this.raw(c, source.uid);
        return parseMail(raw, source, flags, this.config.maxBodyChars);
      } finally {
        lock.release();
      }
    });
  }
  async batch(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => this.get(id)));
    return {
      items: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
      errors: results.flatMap((r, i) =>
        r.status === 'rejected' ? [{ sourceId: ids[i], code: safeError(r.reason) }] : [],
      ),
    };
  }
  async page(account: string, mailbox: string, query: Query = {}): Promise<Page> {
    return this.session(account, async (c) => {
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const uidValidity = this.validity(c);
        const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
        const search: SearchObject = { all: true };
        if (query.since) search.since = validDate(query.since);
        if (query.before) search.before = validDate(query.before);
        const scope = createHash('sha256')
          .update(
            JSON.stringify([
              account,
              mailbox,
              uidValidity,
              query.since ?? null,
              query.before ?? null,
              query.text ?? null,
            ]),
          )
          .digest('hex');
        let last = Number.MAX_SAFE_INTEGER;
        let ceiling = Number.MAX_SAFE_INTEGER;
        if (query.cursor) {
          try {
            const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
            if (
              cursor.scope !== scope ||
              !Number.isSafeInteger(cursor.last) ||
              cursor.last < 1 ||
              !Number.isSafeInteger(cursor.ceiling) ||
              cursor.ceiling < 1
            )
              throw new Error();
            last = cursor.last;
            ceiling = cursor.ceiling;
          } catch {
            throw new Error('CURSOR_SCOPE_CHANGED: restart pagination');
          }
        }
        let mode = 'server';
        let candidates: number[];
        try {
          const found = await c.search(query.text ? { ...search, text: query.text } : search, {
            uid: true,
          });
          if (found === false) throw new Error('IMAP_SEARCH_FAILED');
          candidates = found;
        } catch {
          if (!query.text) throw new Error('IMAP_SEARCH_FAILED');
          const found = await c.search(search, { uid: true });
          if (found === false) throw new Error('IMAP_SEARCH_FAILED');
          candidates = found;
          mode = 'bounded-local-fallback';
        }
        candidates = candidates.filter((uid) => uid <= ceiling).sort((a, b) => b - a);
        if (!query.cursor && candidates.length) ceiling = candidates[0];
        const matched = candidates.length;
        const limited = matched > this.config.maxFolderMessages;
        // Cap the same fixed initial candidate window across pages, not each page independently.
        candidates = candidates.slice(0, this.config.maxFolderMessages).filter((uid) => uid < last);
        const items: Mail[] = [];
        const errors: Failure[] = [];
        let consumed = 0;
        const maxAttempts = mode === 'server' ? limit : Math.min(200, candidates.length);
        for (const uid of candidates) {
          if (consumed >= maxAttempts || items.length >= limit) break;
          consumed++;
          const source: Source = { account, mailbox, uidValidity, uid };
          try {
            const { raw, flags } = await this.raw(c, uid);
            const mail = await parseMail(raw, source, flags, this.config.maxBodyChars);
            if (
              mode === 'server' ||
              !query.text ||
              `${mail.subject}\n${mail.from}\n${mail.text}`
                .toLocaleLowerCase()
                .includes(query.text.toLocaleLowerCase())
            )
              items.push(mail);
          } catch (error) {
            errors.push({ account, mailbox, sourceId: sourceId(source), code: safeError(error) });
          }
        }
        const hasMore = consumed < candidates.length;
        return {
          items,
          nextCursor: hasMore
            ? Buffer.from(
                JSON.stringify({ scope, last: candidates[consumed - 1], ceiling }),
              ).toString('base64url')
            : null,
          matched,
          coverage: {
            account,
            mailbox,
            uidValidity,
            since: query.since ?? null,
            before: query.before ?? null,
            mode,
            limited,
          },
          errors,
        };
      } finally {
        lock.release();
      }
    });
  }
  async attachment(
    id: string,
    index: number,
  ): Promise<{ path: string; bytes: number; sha256: string }> {
    const source = decodeSource(id);
    const raw = await this.session(source.account, async (c) => {
      const lock = await c.getMailboxLock(source.mailbox, { readOnly: true });
      try {
        if (this.validity(c) !== source.uidValidity) throw new Error('UIDVALIDITY_CHANGED');
        return (await this.raw(c, source.uid)).raw;
      } finally {
        lock.release();
      }
    });
    const content = await attachmentContent(raw, index);
    const hash = createHash('sha256').update(content).digest('hex');
    const dir = path.join(localRoot(), 'attachments');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Do not use attacker-controlled MIME filenames or destination paths.
    const target = path.join(dir, `${hash}-${index}.bin`);
    await fs.writeFile(target, content, { mode: 0o600 });
    return { path: target, bytes: content.length, sha256: hash };
  }
  async snapshot(account: string, mailbox: string) {
    return this.session(account, async (c) => {
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const state = await c.status(mailbox, {
          messages: true,
          unseen: true,
          uidValidity: true,
          uidNext: true,
        });
        const found = await c.search({ all: true }, { uid: true });
        if (found === false) throw new Error('IMAP_SEARCH_FAILED');
        const uids = found.slice(-this.config.maxFolderMessages);
        const flags: { uid: number; flags: string[] }[] = [];
        if (uids.length)
          for await (const m of c.fetch(uids.join(','), { uid: true, flags: true }, { uid: true }))
            flags.push({ uid: m.uid, flags: Array.from(m.flags ?? []).sort() });
        return {
          messages: state.messages,
          unseen: state.unseen,
          uidValidity: String(state.uidValidity),
          uidNext: state.uidNext,
          flags: flags.sort((a, b) => a.uid - b.uid),
          limited: (found || []).length > uids.length,
        };
      } finally {
        lock.release();
      }
    });
  }
}
function validDate(date: string): Date {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error('Use valid YYYY-MM-DD');
  return new Date(date + 'T00:00:00Z');
}
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  return /^[A-Z_]+(:|$)/.test(text) ? text.split(':')[0] : 'READ_FAILED';
}
