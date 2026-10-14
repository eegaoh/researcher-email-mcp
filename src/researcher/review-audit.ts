/** Reusable, read-only administrative evidence workflow. No user-specific assignments. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { localRoot } from './config.js';
import { decodeSource, type Mail, sourceId } from './mail.js';
import { type Failure, type Reader, safeError } from './reader.js';
import { csvReport, markdown } from './report.js';
import { associateIndex, extract, merge, type Scan } from './reviews.js';

const sourceSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((id) => {
    try {
      decodeSource(id);
      return true;
    } catch {
      return false;
    }
  });
const headerSchema = z
  .object({
    sourceId: sourceSchema,
    date: z.string().nullable(),
    subject: z.string().max(10000),
    candidate: z.boolean(),
  })
  .strict();
const coverageSchema = z
  .object({
    account: z.string(),
    mailbox: z.string(),
    uidValidity: z.string(),
    since: z.string().nullable(),
    before: z.string().nullable(),
    mode: z.string(),
    limited: z.boolean(),
  })
  .strict();
const failureSchema = z
  .object({
    account: z.string(),
    mailbox: z.string().optional(),
    sourceId: sourceSchema.optional(),
    code: z.string(),
  })
  .strict();
const skippedSchema = z
  .object({ account: z.string(), mailbox: z.string(), reason: z.string() })
  .strict();
export const HeaderIndexSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    since: z.string(),
    before: z.string().optional(),
    headers: z.array(headerSchema).max(200000),
    coverage: z.array(coverageSchema),
    errors: z.array(failureSchema),
    skipped: z.array(skippedSchema),
    complete: z.boolean(),
  })
  .strict();
export type HeaderIndex = z.infer<typeof HeaderIndexSchema>;
const evidenceSchema = z
  .object({
    sourceId: sourceSchema,
    date: z.string().nullable(),
    subject: z.string(),
    text: z.string().max(40000),
    truncated: z.boolean(),
    warnings: z.array(z.string()),
    untrusted: z.literal(true),
  })
  .strict();
export const EvidenceBundleSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    since: z.string(),
    messages: z.array(evidenceSchema).max(200000),
    coverage: z.array(coverageSchema),
    errors: z.array(failureSchema),
    skipped: z.array(skippedSchema),
    selectedSources: z.array(sourceSchema).max(200000),
    complete: z.boolean(),
    selection: z.enum(['header-candidates', 'explicit-sources']),
  })
  .strict();
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** Defense in depth, not anonymization: titles and source identities remain private. */
export function sanitizeReviewText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, '[链接已省略]')
    .replace(
      /^[^\n]*(?:密码|口令|授权码|用户名|password|passcode|authorization\s*code|user\s*(?:name|id)|access[_ -]?token|api[_ -]?key|bearer\s+)[^\n]*$/gim,
      '[登录提示已省略]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱地址已省略]');
}
export function administrativeText(
  text: string,
  limit = 14000,
): { text: string; truncated: boolean } {
  const admin = text.split(
    /\n\s*(?:ABSTRACT\s*[:：]?|COMMENTS TO (?:THE )?AUTHOR|Reviewer:\s*\d|审稿意见如下|摘要\s*[:：])/i,
  )[0];
  const clean = sanitizeReviewText(admin);
  return {
    text: clean.slice(0, limit),
    truncated: admin.length !== text.length || clean.length > limit,
  };
}
export function reviewHeaderCandidate(
  subject: string,
  include: string[] = [],
  exclude: string[] = [],
): boolean {
  const normalized = subject.toLocaleLowerCase();
  return (
    !exclude.some((s) => normalized.includes(s.toLocaleLowerCase())) &&
    (/review|referee|审稿|评审|审阅|复审|送审|稿件|manuscript|invitation|延期|延长|deadline|\b[A-Z]{2,12}-(?:D-)?(?:\d{2}-\d{3,8}|\d{3,8}-20\d{2}|20\d{2}-\d{2}-\d{3,8})/i.test(
      subject,
    ) ||
      include.some((s) => normalized.includes(s.toLocaleLowerCase())))
  );
}
export function auditDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error('INVALID_DATE');
  return date;
}
export async function indexReviewHeaders(
  reader: Reader,
  options: {
    since?: string;
    before?: string;
    include?: string[];
    exclude?: string[];
    excludeFolders?: string[];
  } = {},
): Promise<HeaderIndex> {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const since = options.since ?? start.toISOString().slice(0, 10);
  const sinceDate = auditDate(since);
  const beforeDate = options.before ? auditDate(options.before) : undefined;
  if (beforeDate && beforeDate <= sinceDate) throw new Error('INVALID_DATE_RANGE');
  const result: HeaderIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    since,
    before: options.before,
    headers: [],
    coverage: [],
    errors: [],
    skipped: [],
    complete: false,
  };
  await Promise.all(
    reader.config.accounts.map(async (account) => {
      try {
        const folders = await reader.folders(account.id);
        for (const name of account.folders ?? []) {
          if (!folders.some((f) => f.path === name && f.selectable))
            result.errors.push({
              account: account.id,
              mailbox: name,
              code: 'CONFIGURED_FOLDER_MISSING',
            });
        }
        for (const folder of folders) {
          const reason = !folder.selectable
            ? 'Not selectable'
            : /\\(?:Junk|Trash|Drafts)/i.test(folder.specialUse ?? '') ||
                /junk|spam|trash|deleted|draft|virus|垃圾|草稿|已删除/i.test(folder.path)
              ? 'Junk/trash/drafts excluded'
              : account.folders && !account.folders.includes(folder.path)
                ? 'Outside configured folders'
                : options.excludeFolders?.includes(folder.path)
                  ? 'Explicitly excluded folder'
                  : null;
          if (reason) {
            result.skipped.push({ account: account.id, mailbox: folder.path, reason });
            continue;
          }
          try {
            await reader.session(account.id, async (client) => {
              const lock = await client.getMailboxLock(folder.path, { readOnly: true });
              try {
                const validity = reader.validity(client);
                const found = await client.search(
                  { since: sinceDate, ...(beforeDate ? { before: beforeDate } : {}) },
                  { uid: true },
                );
                if (found === false) throw new Error('IMAP_SEARCH_FAILED');
                const uids = found.sort((a, b) => b - a).slice(0, reader.config.maxFolderMessages);
                result.coverage.push({
                  account: account.id,
                  mailbox: folder.path,
                  uidValidity: validity,
                  since,
                  before: options.before ?? null,
                  mode: 'bounded-headers-only',
                  limited: found.length > uids.length,
                });
                const seen = new Set<number>();
                for (let i = 0; i < uids.length; i += 100) {
                  for await (const message of client.fetch(
                    uids.slice(i, i + 100).join(','),
                    { envelope: true, uid: true },
                    { uid: true },
                  )) {
                    seen.add(message.uid);
                    const subject = message.envelope?.subject ?? '';
                    const date = message.envelope?.date;
                    if (!message.envelope) {
                      result.errors.push({
                        account: account.id,
                        mailbox: folder.path,
                        code: 'HEADER_ENVELOPE_MISSING',
                      });
                      continue;
                    }
                    result.headers.push({
                      sourceId: sourceId({
                        account: account.id,
                        mailbox: folder.path,
                        uidValidity: validity,
                        uid: message.uid,
                      }),
                      date: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
                      subject: sanitizeReviewText(subject),
                      candidate: reviewHeaderCandidate(subject, options.include, options.exclude),
                    });
                  }
                }
                if (seen.size !== uids.length)
                  result.errors.push({
                    account: account.id,
                    mailbox: folder.path,
                    code: 'HEADER_FETCH_INCOMPLETE',
                  });
              } finally {
                lock.release();
              }
            });
          } catch (error) {
            result.errors.push({
              account: account.id,
              mailbox: folder.path,
              code: safeError(error),
            });
          }
        }
      } catch (error) {
        result.errors.push({ account: account.id, code: safeError(error) });
      }
    }),
  );
  result.headers.sort(
    (a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.sourceId.localeCompare(b.sourceId),
  );
  result.complete =
    reader.config.accounts.length > 0 &&
    result.errors.length === 0 &&
    !result.coverage.some((c) => c.limited);
  return result;
}

export async function collectReviewEvidence(
  reader: Reader,
  input: HeaderIndex,
  explicitSources?: string[],
): Promise<EvidenceBundle> {
  const index = HeaderIndexSchema.parse(input);
  const selectedSources = [
    ...new Set(explicitSources ?? index.headers.filter((h) => h.candidate).map((h) => h.sourceId)),
  ];
  z.array(sourceSchema).max(200000).parse(selectedSources);
  const known = new Set(index.headers.map((h) => h.sourceId));
  if (selectedSources.some((id) => !known.has(id))) throw new Error('SOURCE_OUTSIDE_HEADER_INDEX');
  const result: EvidenceBundle = {
    version: 1,
    generatedAt: new Date().toISOString(),
    since: index.since,
    selectedSources,
    selection: explicitSources ? 'explicit-sources' : 'header-candidates',
    messages: [],
    coverage: index.coverage,
    errors: [...index.errors],
    skipped: index.skipped,
    complete: false,
  };
  await Promise.all(
    reader.config.accounts.map(async (account) => {
      for (const id of selectedSources.filter((s) => decodeSource(s).account === account.id)) {
        try {
          const mail = await reader.get(id); // Enforces UIDVALIDITY; uses BODY.PEEK and read-only lock.
          const admin = administrativeText(mail.text);
          result.messages.push({
            sourceId: id,
            date: mail.date,
            subject: sanitizeReviewText(mail.subject),
            text: admin.text,
            truncated: mail.truncated || admin.truncated,
            warnings: mail.warnings.map(sanitizeReviewText),
            untrusted: true,
          });
        } catch (error) {
          result.errors.push({ account: account.id, sourceId: id, code: safeError(error) });
        }
      }
    }),
  );
  for (const id of selectedSources) {
    const account = decodeSource(id).account;
    if (!reader.config.accounts.some((a) => a.id === account))
      result.errors.push({ account, sourceId: id, code: 'ACCOUNT_NOT_CONFIGURED' });
  }
  result.messages.sort(
    (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.sourceId.localeCompare(b.sourceId),
  );
  result.complete =
    index.complete &&
    result.errors.length === 0 &&
    result.messages.length === selectedSources.length &&
    index.headers.filter((h) => h.candidate).every((h) => selectedSources.includes(h.sourceId)) &&
    !result.messages.some((m) => m.truncated);
  return result;
}

export async function auditReviewEvidence(
  input: EvidenceBundle,
  reviewIndex?: string,
): Promise<{ scan: Scan; gaps: string[] }> {
  const bundle = EvidenceBundleSchema.parse(input);
  const events = [];
  const gaps = [];
  for (const item of bundle.messages) {
    const mail: Mail = {
      ...item,
      subject: sanitizeReviewText(item.subject),
      text: sanitizeReviewText(item.text),
      source: decodeSource(item.sourceId),
      messageId: null,
      from: '',
      to: '',
      flags: [],
      rawBytes: 0,
      sha256: '',
      attachments: [],
      warnings: [
        ...item.warnings.map(sanitizeReviewText),
        ...(item.truncated ? ['Administrative evidence truncated'] : []),
      ],
    };
    const event = extract(mail);
    if (event) events.push(event);
    else gaps.push(item.sourceId);
  }
  const tasks = merge(events);
  await associateIndex(tasks, reviewIndex);
  return {
    scan: {
      generatedAt: new Date().toISOString(),
      since: bundle.since,
      tasks,
      coverage: bundle.coverage,
      errors: bundle.errors as Failure[],
      skipped: bundle.skipped,
      olderLookup: false,
      complete:
        bundle.complete &&
        gaps.length === 0 &&
        !bundle.messages.some((m) => m.truncated) &&
        bundle.errors.length === 0,
    },
    gaps,
  };
}

/** Bounded JSON inputs only; no loading config, executing scripts or contacting links. */
export async function readAuditJson(file: string): Promise<unknown> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('AUDIT_INPUT_TOO_LARGE');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
export async function writeAuditArtifact(
  name: 'headers' | 'evidence' | 'audit',
  data: unknown,
): Promise<string> {
  const root = path.join(localRoot(), 'review-audits');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(root, `${name}-`));
  const file = path.join(dir, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  return file;
}
export async function writeAuditReport(audit: { scan: Scan; gaps: string[] }): Promise<string[]> {
  const file = await writeAuditArtifact('audit', audit);
  const dir = path.dirname(file);
  const md = path.join(dir, '审稿候选.md');
  const csv = path.join(dir, '审稿候选.csv');
  await fs.writeFile(
    md,
    markdown(audit.scan) +
      `\n未识别证据邮件：${audit.gaps.length}；标题筛选可能漏检，结果仍是候选，不代表全部未完成审稿。\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await fs.writeFile(csv, csvReport(audit.scan), { mode: 0o600, flag: 'wx' });
  return [file, md, csv];
}
