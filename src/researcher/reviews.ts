import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { Account } from './config.js';
import { localRoot } from './config.js';
import type { Mail } from './mail.js';
import { type Failure, type Page, type Reader, safeError } from './reader.js';

export type Status = '邀请待响应' | '已接受待审' | '已提交' | '拒绝/取消' | '待确认';
export interface Evidence {
  id: string;
  sourceId: string;
  date: string | null;
  excerpt: string;
  kind: string;
  untrusted: true;
}
export interface Deadline {
  kind: '邀请回复' | '审稿';
  date: string | null;
  raw: string;
  timezone: string | null;
  needsConfirmation: boolean;
  extension: boolean;
  evidence: Evidence;
}
export interface Event {
  journal: string;
  manuscript: string;
  round: number;
  identityUncertain: boolean;
  status: Status;
  statusEvidence: Evidence | null;
  deadlines: Deadline[];
  sourceId: string;
  date: string | null;
  messageId: string | null;
  title: string | null;
  warnings: string[];
}
export interface Task {
  id: string;
  journal: string;
  manuscript: string;
  round: number;
  status: Status;
  needsConfirmation: boolean;
  deadline: Deadline | null;
  deadlineHistory: Deadline[];
  evidence: Evidence[];
  sources: string[];
  warnings: string[];
  localArchive: { reviewId: string; path: string; localStatus: string } | null;
  title: string | null;
}
export interface Scan {
  generatedAt: string;
  since: string;
  tasks: Task[];
  coverage: Page['coverage'][];
  errors: Failure[];
  skipped: { account: string; mailbox: string; reason: string }[];
  olderLookup: boolean;
  complete: boolean;
}

function evidence(mail: Mail, kind: string, line: string): Evidence {
  return {
    id: `${mail.sourceId}:${kind}:${Buffer.from(line).toString('base64url').slice(0, 64)}`,
    sourceId: mail.sourceId,
    date: mail.date,
    excerpt: line.slice(0, 600),
    kind,
    untrusted: true,
  };
}
function unquoted(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  for (const line of lines) {
    if (/^-{2,}.*(?:Original|Forwarded)|^On .{5,}wrote:|^发件人[:：]/i.test(line)) break;
    if (!/^\s*>/.test(line)) result.push(line.trim());
  }
  // Join wrapped paragraphs while keeping sentences independently attributable.
  return result
    .join('\n')
    .split(/\n|(?<=[.!?。！？])\s+/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const months: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
export function deadlineDate(line: string): {
  date: string | null;
  raw: string;
  timezone: string | null;
} {
  const iso =
    line.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/) ??
    line.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日?/);
  const en1 = line.match(/\b(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s]+,?\s*(20\d{2})\b/);
  const en2 = line.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/);
  const ambiguous = line.match(/\b\d{1,2}\/\d{1,2}\/20\d{2}\b/);
  let year = 0,
    month = 0,
    day = 0,
    raw = line;
  if (iso) {
    year = +iso[1];
    month = +iso[2];
    day = +iso[3];
    raw = iso[0];
  } else if (en1) {
    day = +en1[1];
    month = months[en1[2].slice(0, 3).toLowerCase()] ?? 0;
    year = +en1[3];
    raw = en1[0];
  } else if (en2) {
    month = months[en2[1].slice(0, 3).toLowerCase()] ?? 0;
    day = +en2[2];
    year = +en2[3];
    raw = en2[0];
  } else if (ambiguous) raw = ambiguous[0];
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const test = new Date(date + 'T00:00:00Z');
  const valid =
    year > 0 && !Number.isNaN(test.getTime()) && test.toISOString().slice(0, 10) === date;
  const timezone =
    line.match(/\b(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?\b|北京时间|China Standard Time/i)?.[0] ??
    null;
  return { date: valid ? date : null, raw, timezone };
}
export function extract(mail: Mail): Event | null {
  const lines = unquoted(mail.text);
  const text = [mail.subject, ...lines].join('\n');
  // Require labelled manuscript identity or an unmistakable manuscript code.
  const idMatch =
    text.match(
      /(?:Manuscript\s*(?:ID\b|Number\b|No\.?\b|#)|Paper\s*(?:ID\b|Number\b|No\.?\b|#)|稿件(?:编号|号)|稿号)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,80})/i,
    ) ??
    text.match(/\b([A-Z]{2,12}-D-\d{2}-\d{3,8}(?:[._-]?R\d+)?)\b/) ??
    text.match(/\b([A-Z]{2,12}[-.]\d{4}(?:[-.]\d{2})?[-.]\d{3,8}(?:[._-]?R\d+)?)\b/) ??
    text.match(/\b([A-Z]{2,12}-\d{3,8}-20\d{2}(?:[._-]?R\d+)?)\b/);
  if (!idMatch || !/review|referee|审稿|评审|复审|送审/i.test(text)) return null;
  const raw = idMatch[1].replace(/[.,;]+$/, '').toUpperCase();
  const suffix = raw.match(/[._-]?R(\d+)$/);
  const round = suffix
    ? +suffix[1]
    : /second (?:round|review)|二审|第二轮/i.test(text)
      ? 1
      : /third (?:round|review)|三审|第三轮/i.test(text)
        ? 2
        : /复审|re-review|revised manuscript/i.test(text)
          ? 1
          : 0;
  const manuscript = raw.replace(/[._-]?R\d+$/, '');
  const explicitJournal = text.match(/(?:^|\n)(?:Journal|期刊)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
  const namedJournal = text.match(/IEEE Transactions on [A-Za-z &]+/)?.[0]?.trim();
  const journal = explicitJournal ?? namedJournal ?? manuscript.split(/[-.]/)[0];
  const identityUncertain = !explicitJournal && !namedJournal;
  const title =
    text.match(/(?:^|\n)(?:Title|Manuscript Title|题名|题目)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim() ??
    null;
  let status: Status = '待确认';
  let statusEvidence: Evidence | null = null;
  const deadlines: Deadline[] = [];
  const warnings = [...mail.warnings];
  if (
    !suffix &&
    /复审|re-review|revised manuscript/i.test(text) &&
    !/second (?:round|review)|二审|第二轮|third (?:round|review)|三审|第三轮/i.test(text)
  )
    warnings.push('复审具体轮次未明：仅暂按至少R1归组，需核实是否更高轮次');
  for (const line of lines) {
    if (
      /\b(?:not|haven't|have not|has not|yet to|please|must|need to|required to|will)\b.{0,35}(?:submit|submitted)|未提交|请提交|尚未提交/i.test(
        line,
      )
    ) {
      // Requests/promises are not submission receipts.
    } else if (
      /thank you for (?:submitting|completing).{0,80}(?:review|report)|(?:review|report).{0,30}(?:has been|was|successfully) submitted|we (?:have )?received your (?:review|report)|审稿意见.{0,12}(?:已成功提交|已收到)|感谢您.{0,12}(?:提交|完成).{0,12}审稿/i.test(
        line,
      )
    ) {
      status = '已提交';
      statusEvidence = evidence(mail, '提交回执', line);
    }
    if (
      /(?:you (?:have )?accepted|thank you for (?:agreeing|accepting)|I accept (?:the|this) invitation|agreed to review|感谢您接受|您已接受|我接受.{0,12}审稿)/i.test(
        line,
      ) &&
      status !== '已提交'
    ) {
      status = '已接受待审';
      statusEvidence = evidence(mail, '接受审稿', line);
    }
    if (
      /(?:invitation to review|invite you to (?:review|serve as a reviewer)|please (?:accept or decline|respond to).{0,40}invitation|邀请您.{0,12}审稿)/i.test(
        line,
      ) &&
      status === '待确认'
    ) {
      status = '邀请待响应';
      statusEvidence = evidence(mail, '审稿邀请', line);
    }
    if (
      /(?:review invitation|review assignment).{0,30}(?:cancelled|canceled|withdrawn)|you (?:have )?declined|I (?:must )?decline.{0,35}(?:review|invitation)|审稿(?:邀请|任务).{0,10}(?:取消|撤回)|您已拒绝/i.test(
        line,
      )
    ) {
      status = '拒绝/取消';
      statusEvidence = evidence(mail, '拒绝或取消', line);
    }
    const due = /due|deadline|no later than|by\s+(?:\d|[A-Z][a-z]+\s+\d)|截止|期限|延期至/i.test(
      line,
    );
    if (due) {
      if (
        /extend|extension|延期|延长/i.test(line) &&
        /request|could|would|can you|申请|请求|能否/i.test(line)
      ) {
        warnings.push('发现延期申请但没有获批证据：不替代当前期限，需核实');
        continue;
      }
      const kind =
        /respond|response|accept or decline|reply.{0,30}invitation|回复.{0,10}邀请|邀请回复/i.test(
          line,
        )
          ? '邀请回复'
          : '审稿';
      // Author revision deadlines are not reviewer deadlines; leave them out of the reviewer timeline.
      if (
        /your (?:revised manuscript|revision)|submit.{0,25}revised (?:paper|manuscript)|作者.{0,12}(?:修回|修改)|修回截止/i.test(
          line,
        )
      )
        continue;
      const parsed = deadlineDate(line);
      const extension =
        /(?:has been|is|was) extended|(?:new|revised) (?:review )?deadline|延期(?:已获批准|至)|延长至|新的截止/i.test(
          line,
        ) && !/request|could|would|can you|申请|请求|能否/i.test(line);
      deadlines.push({
        kind,
        ...parsed,
        needsConfirmation: !parsed.date || !parsed.timezone,
        extension,
        evidence: evidence(mail, kind + '期限', line),
      });
    }
  }
  if (!mail.date) warnings.push('邮件日期缺失：不用于自动时序推断');
  if (identityUncertain) warnings.push('期刊身份由稿号前缀暂定，需确认');
  return {
    journal,
    manuscript,
    round,
    identityUncertain,
    status,
    statusEvidence,
    deadlines,
    sourceId: mail.sourceId,
    date: mail.date,
    messageId: mail.messageId,
    title,
    warnings,
  };
}
export function merge(events: Event[]): Task[] {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const key = `${event.journal.toLowerCase().replace(/\s+/g, ' ')}:${event.manuscript}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([id, group]) => {
    const round = Math.max(...group.map((e) => e.round));
    const current = group.filter((e) => e.round === round);
    const ordered = current.filter((e) => e.date).sort((a, b) => a.date!.localeCompare(b.date!));
    const statuses = ordered.filter((e) => e.statusEvidence);
    const latest = statuses.at(-1);
    const deadlineHistory = current
      .flatMap((e) => e.deadlines)
      .sort((a, b) => (a.evidence.date ?? '').localeCompare(b.evidence.date ?? ''));
    const kind = latest?.status === '邀请待响应' ? '邀请回复' : '审稿';
    const relevant = deadlineHistory.filter((d) => d.kind === kind);
    const extensionIndex = relevant.findLastIndex((d) => d.extension && d.evidence.date !== null);
    const active = extensionIndex >= 0 ? relevant.slice(extensionIndex) : relevant;
    const dated = active.filter((d) => d.date);
    const values = new Set(dated.map((d) => d.date));
    const conflict = values.size > 1;
    const deadline = dated.at(-1) ?? active.at(-1) ?? null;
    const undated = current.some((e) => !e.date && e.statusEvidence);
    const simultaneous =
      latest && statuses.some((e) => e.date === latest.date && e.status !== latest.status);
    // A later unnumbered re-review cannot be closed by an earlier numbered-round receipt.
    const uncertainRound = group.some(
      (e) =>
        e.warnings.some((w) => w.startsWith('复审具体轮次未明')) &&
        (!e.date || !latest?.date || e.date >= latest.date),
    );
    const warnings = [...new Set(group.flatMap((e) => e.warnings))];
    if (conflict) warnings.push('截止日期证据冲突：未检测到可解释的延期');
    if (undated || simultaneous) warnings.push('状态时序无法确定或同日证据冲突');
    const ev = group.flatMap((e) => [
      ...(e.statusEvidence ? [e.statusEvidence] : []),
      ...e.deadlines.map((d) => d.evidence),
    ]);
    const unique = [...new Map(ev.map((e) => [`${e.kind}:${e.date}:${e.excerpt}`, e])).values()];
    return {
      id,
      journal: group[0].journal,
      manuscript: group[0].manuscript,
      round,
      status: undated || simultaneous || uncertainRound ? '待确认' : (latest?.status ?? '待确认'),
      needsConfirmation:
        conflict ||
        undated ||
        uncertainRound ||
        !!simultaneous ||
        group.some((e) => e.identityUncertain || e.warnings.length > 0) ||
        !latest ||
        (!['已提交', '拒绝/取消'].includes(latest.status) &&
          (!deadline || deadline.needsConfirmation)),
      deadline: deadline
        ? { ...deadline, needsConfirmation: deadline.needsConfirmation || conflict }
        : null,
      deadlineHistory,
      evidence: unique,
      sources: [...new Set(group.map((e) => e.sourceId))],
      warnings,
      localArchive: null,
      title: group.find((e) => e.title)?.title ?? null,
    };
  });
}
export async function associateIndex(tasks: Task[], indexPath?: string): Promise<void> {
  if (!indexPath) return;
  const rows = parse(await fs.readFile(indexPath, 'utf8'), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  for (const task of tasks) {
    // Existing index has no reliable manuscript field. Only explicit ID columns or exact full title are accepted.
    const matches = rows.filter(
      (r) =>
        (r.manuscript_id &&
          r.manuscript_id.toUpperCase() === task.manuscript &&
          r.venue_or_type === task.journal) ||
        (task.title && r.title?.trim() === task.title.trim()),
    );
    if (matches.length === 1) {
      const row = matches[0];
      task.localArchive = {
        reviewId: row.review_id,
        path: row.current_path,
        localStatus: row.status,
      };
    } else if (matches.length > 1) {
      task.warnings.push('本地审稿索引匹配不唯一，未关联');
      task.needsConfirmation = true;
    }
  }
}
export async function scan(
  reader: Reader,
  options: { since?: string; olderLookup?: boolean } = {},
): Promise<Scan> {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const since = options.since ?? start.toISOString().slice(0, 10);
  const result: Scan = {
    generatedAt: new Date().toISOString(),
    since,
    tasks: [],
    coverage: [],
    errors: [],
    skipped: [],
    olderLookup: options.olderLookup ?? false,
    complete: false,
  };
  const eventsBySource = new Map<string, Event>();
  let truncated = false;
  const addPage = async (page: Page) => {
    for (const mail of page.items) {
      const event = extract(mail);
      if (event) eventsBySource.set(mail.sourceId, event);
      truncated ||= mail.truncated;
    }
    result.errors.push(...page.errors);
    result.coverage.push(page.coverage);
    result.tasks = merge([...eventsBySource.values()]);
    await saveScan(result); // Partial checkpoint remains explicitly incomplete.
  };
  const foldersByAccount = new Map<string, string[]>();
  // Accounts are independent; one failed account never prevents others from being scanned.
  const scanAccount = async (account: Account) => {
    let folders: Awaited<ReturnType<Reader['folders']>>;
    try {
      folders = await reader.folders(account.id);
    } catch (error) {
      result.errors.push({ account: account.id, code: safeError(error) });
      return;
    }
    const selected: string[] = [];
    for (const folder of folders) {
      const skip =
        !folder.selectable ||
        /\\(?:Junk|Trash|Drafts)/i.test(folder.specialUse ?? '') ||
        /(?:^|\/)(?:junk|spam|trash|deleted items|drafts|垃圾邮件|垃圾箱|已删除|草稿)(?:$|\/)/i.test(
          folder.path,
        );
      if (skip || (account.folders && !account.folders.includes(folder.path))) {
        result.skipped.push({
          account: account.id,
          mailbox: folder.path,
          reason: skip ? '垃圾/删除/草稿/不可选' : '不在用户配置范围',
        });
        continue;
      }
      selected.push(folder.path);
      try {
        let cursor: string | null = null;
        do {
          const page = await reader.page(account.id, folder.path, {
            since,
            limit: 100,
            cursor: cursor ?? undefined,
          });
          await addPage(page);
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        result.errors.push({ account: account.id, mailbox: folder.path, code: safeError(error) });
      }
    }
    foldersByAccount.set(account.id, selected);
    if (!selected.length) result.errors.push({ account: account.id, code: 'NO_SELECTED_FOLDERS' });
    for (const configured of account.folders ?? [])
      if (!folders.some((f) => f.path === configured))
        result.errors.push({
          account: account.id,
          mailbox: configured,
          code: 'CONFIGURED_FOLDER_MISSING',
        });
  };
  let nextAccount = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, reader.config.accounts.length) }, async () => {
      while (nextAccount < reader.config.accounts.length) {
        const account = reader.config.accounts[nextAccount++];
        await scanAccount(account);
      }
    }),
  );
  if (options.olderLookup) {
    const ids = [...new Set([...eventsBySource.values()].map((e) => e.manuscript))].slice(0, 100);
    for (const [account, folders] of foldersByAccount)
      for (const mailbox of folders)
        for (const id of ids) {
          try {
            let cursor: string | null = null;
            do {
              const page = await reader.page(account, mailbox, {
                before: since,
                text: id,
                limit: 100,
                cursor: cursor ?? undefined,
              });
              await addPage(page);
              cursor = page.nextCursor;
            } while (cursor);
          } catch (error) {
            result.errors.push({ account, mailbox, code: safeError(error) });
          }
        }
    if (ids.length >= 100) result.errors.push({ account: 'all', code: 'OLDER_LOOKUP_ID_LIMIT' });
  }
  result.tasks = merge([...eventsBySource.values()]);
  try {
    await associateIndex(result.tasks, reader.config.reviewIndex);
  } catch {
    result.errors.push({ account: 'local', code: 'REVIEW_INDEX_READ_FAILED' });
  }
  result.complete =
    result.errors.length === 0 &&
    !result.coverage.some((c) => c.limited) &&
    !truncated &&
    reader.config.accounts.length > 0;
  await saveScan(result);
  return result;
}
export async function saveScan(result: Scan): Promise<void> {
  await fs.mkdir(localRoot(), { recursive: true, mode: 0o700 });
  const target = path.join(localRoot(), 'reviews.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
  await fs.rename(temporary, target);
}
export async function loadScan(): Promise<Scan> {
  try {
    return JSON.parse(await fs.readFile(path.join(localRoot(), 'reviews.json'), 'utf8')) as Scan;
  } catch {
    throw new Error('No review scan yet; run scan_review_mail');
  }
}
