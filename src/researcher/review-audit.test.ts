import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';
import { fixture } from './fixtures.js';
import { parseMail, sourceId } from './mail.js';
import type { Reader } from './reader.js';
import {
  administrativeText,
  auditDate,
  auditReviewEvidence,
  collectReviewEvidence,
  type HeaderIndex,
  indexReviewHeaders,
  readAuditJson,
  reviewHeaderCandidate,
  sanitizeReviewText,
  writeAuditArtifact,
  writeAuditReport,
} from './review-audit.js';
import { deadlineDate, extract, merge } from './reviews.js';

const source = { account: 'synthetic', mailbox: 'INBOX', uidValidity: '1', uid: 1 };
const id = sourceId(source);
const body =
  'Journal: Synthetic Journal\nManuscript ID: SYN-D-27-54321.R2\nThank you for agreeing to review.\nYour review is due by 21-Jan-2027 UTC.';
const headerIndex = (): HeaderIndex => ({
  version: 1,
  generatedAt: '2027-01-01',
  since: '2026-01-01',
  headers: [{ sourceId: id, date: null, subject: 'Review invitation', candidate: true }],
  coverage: [],
  errors: [],
  skipped: [],
  complete: true,
});
const initialRoot = process.env.RESEARCHER_LOCAL_AI;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (
      path.dirname(dir) === os.tmpdir() &&
      path.basename(dir).startsWith('researcher-audit-test-')
    )
      await fs.rm(dir, { recursive: true, force: true });
  }
  if (initialRoot === undefined) delete process.env.RESEARCHER_LOCAL_AI;
  else process.env.RESEARCHER_LOCAL_AI = initialRoot;
});
async function mockReader(text = body): Promise<Reader> {
  const mail = await parseMail(
    fixture(text, { subject: 'Review administrative notification' }),
    source,
  );
  return {
    config: ConfigSchema.parse({
      accounts: [
        {
          id: 'synthetic',
          email: 'a@example.invalid',
          credentialRef: 'researcher-email-mcp/synthetic',
          imap: { host: 'localhost' },
        },
      ],
    }),
    get: async () => mail,
  } as unknown as Reader;
}
describe('administrative evidence helpers', () => {
  it('removes credential hints, URLs and addresses while preserving deadlines', () => {
    const clean = sanitizeReviewText(
      'Password: synthetic-test-only\n用户名：synthetic\nReview due 21-Jan-2027\nhttps://example.invalid/login?token=synthetic\neditor@example.invalid',
    );
    expect(clean).not.toMatch(/synthetic-test-only|token=|editor@/);
    expect(clean).toContain('21-Jan-2027');
  });
  it('stops before manuscript abstracts or reviewer reports and marks truncation', () => {
    const result = administrativeText(
      'Review due 2027-01-21\nAbstract: private manuscript content',
    );
    expect(result.text).not.toContain('private manuscript');
    expect(result.truncated).toBe(true);
    expect(administrativeText('x'.repeat(20), 10).truncated).toBe(true);
  });
  it('detects unlabelled manuscript subjects and permits literal include/exclude overrides', () => {
    expect(reviewHeaderCandidate('SYN-D-27-54321')).toBe(true);
    expect(reviewHeaderCandidate('复审通知')).toBe(true);
    expect(reviewHeaderCandidate('Custom phrase', ['custom'])).toBe(true);
    expect(reviewHeaderCandidate('Review special issue', [], ['special issue'])).toBe(false);
    expect(reviewHeaderCandidate('anything', ['.*'])).toBe(false);
  });
  it('rejects malformed dates and reversed ranges before connecting', async () => {
    expect(() => auditDate('2027-02-30')).toThrow('INVALID_DATE');
    await expect(
      indexReviewHeaders(await mockReader(), { since: '2027-02-01', before: '2027-01-01' }),
    ).rejects.toThrow('INVALID_DATE_RANGE');
  });
  it('does not promote a new install with no accounts into complete coverage', async () => {
    const reader = { config: ConfigSchema.parse({}) } as Reader;
    expect((await indexReviewHeaders(reader)).complete).toBe(false);
  });
  it('deduplicates sources, redacts evidence and never reads attachments', async () => {
    const reader = await mockReader(
      `${body}\nPassword: synthetic-test-only\nhttps://example.invalid/auth`,
    );
    const evidence = await collectReviewEvidence(reader, headerIndex(), [id, id]);
    expect(evidence.messages).toHaveLength(1);
    expect(evidence.messages[0].text).not.toContain('synthetic-test-only');
    expect(evidence.messages[0].untrusted).toBe(true);
    expect((await auditReviewEvidence(evidence)).scan.tasks[0].round).toBe(2);
  });
  it('allows an explicit title-filter omission to be read from the same index', async () => {
    const index = headerIndex();
    index.headers[0].candidate = false;
    expect((await collectReviewEvidence(await mockReader(), index)).messages).toHaveLength(0);
    expect((await collectReviewEvidence(await mockReader(), index, [id])).messages).toHaveLength(1);
    await expect(
      collectReviewEvidence(await mockReader(), index, [sourceId({ ...source, uid: 2 })]),
    ).rejects.toThrow('SOURCE_OUTSIDE_HEADER_INDEX');
  });
  it('isolates stale validity failures and suppresses private server errors', async () => {
    const reader = await mockReader();
    reader.get = async () => {
      throw new Error('UIDVALIDITY_CHANGED: synthetic-private-context');
    };
    const evidence = await collectReviewEvidence(reader, headerIndex());
    expect(evidence.complete).toBe(false);
    expect(evidence.errors[0].code).toBe('UIDVALIDITY_CHANGED');
    expect(JSON.stringify(evidence)).not.toContain('synthetic-private-context');
  });
  it('unconfigured account sources are visible as failures, not silently dropped', async () => {
    const reader = await mockReader();
    reader.config.accounts = [];
    const evidence = await collectReviewEvidence(reader, headerIndex());
    expect(evidence.errors[0].code).toBe('ACCOUNT_NOT_CONFIGURED');
    expect(evidence.complete).toBe(false);
  });
  it('unrecognized/truncated evidence remains incomplete with a gap source', async () => {
    const evidence = await collectReviewEvidence(
      await mockReader('Review invitation without a manuscript identity'),
      headerIndex(),
    );
    const result = await auditReviewEvidence(evidence);
    expect(result.gaps).toEqual([id]);
    expect(result.scan.complete).toBe(false);
    const cropped = await collectReviewEvidence(
      await mockReader(body + '\nAbstract: omitted'),
      headerIndex(),
    );
    expect(cropped.messages[0].truncated).toBe(true);
    expect(cropped.complete).toBe(false);
  });
  it('writes unique private artifacts and reports without overwriting input files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'researcher-audit-test-'));
    dirs.push(root);
    process.env.RESEARCHER_LOCAL_AI = root;
    const first = await writeAuditArtifact('headers', headerIndex());
    const second = await writeAuditArtifact('headers', headerIndex());
    expect(first).not.toBe(second);
    expect(await readAuditJson(first)).toMatchObject({ version: 1 });
    const audit = await auditReviewEvidence(
      await collectReviewEvidence(await mockReader(), headerIndex()),
    );
    const files = await writeAuditReport(audit);
    expect(files).toHaveLength(3);
    expect(await fs.readFile(files[1], 'utf8')).toContain('候选');
    expect(files.every((f) => f.startsWith(path.join(root, 'projects')))).toBe(true);
  });
  it('actual CLI audits synthetic evidence offline without credentials or mail in stdout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'researcher-audit-test-'));
    dirs.push(root);
    process.env.RESEARCHER_LOCAL_AI = root;
    const bundle = await collectReviewEvidence(await mockReader(), headerIndex());
    const input = await writeAuditArtifact('evidence', bundle);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/researcher/main.ts', 'review-audit', '--evidence', input],
      { env: { ...process.env, RESEARCHER_LOCAL_AI: root }, timeout: 15000 },
    );
    const summary = JSON.parse(stdout);
    expect(summary.tasks).toBe(1);
    expect(summary.files).toHaveLength(3);
    expect(stdout).not.toContain('SYN-D-27-54321');
    expect(stdout).not.toContain('Thank you');
  });
});
describe('synthetic review parsing regressions', () => {
  it('converts a whitespace text part with HTML administrative evidence', async () => {
    const raw = fixture(
      '--x\r\nContent-Type: text/plain\r\n\r\n \r\n--x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Review due 21-Jan-2027</p><img src="https://example.invalid/no-fetch">\r\n--x--',
      { extra: 'Content-Type: multipart/alternative; boundary=x' },
    );
    expect((await parseMail(raw, source)).text).toContain('21-Jan-2027');
  });
  it.each([
    'SYN-D-27-54321R1',
    'SYN-D-27-54321.R1',
    'SYN-2027-01-1234_R1',
  ])('preserves revised identity: %s', async (code) => {
    const mail = await parseMail(
      fixture(`Thank you for agreeing to review.`, { subject: code }),
      source,
    );
    expect(extract(mail)?.round).toBe(1);
    expect(extract(mail)?.manuscript).not.toMatch(/R1$/);
  });
  it('unknown Chinese re-review round requires confirmation rather than assuming first review', async () => {
    const event = extract(
      await parseMail(
        fixture('稿号：20270101001\n复审通知\n请于截止日期2027年1月21日完成审稿。'),
        source,
      ),
    )!;
    expect(event.round).toBe(1);
    expect(merge([event])[0].needsConfirmation).toBe(true);
    expect(event.warnings.join()).toContain('具体轮次未明');
  });
  it('a later unnumbered re-review cannot be closed by an old R2 receipt', async () => {
    const receipt = extract(
      await parseMail(
        fixture('Manuscript ID: SYN-D-27-54321.R2\nThank you for submitting your review.', {
          date: 'Mon, 12 Oct 2026 10:00:00 +0800',
        }),
        source,
      ),
    )!;
    const next = extract(
      await parseMail(
        fixture('Manuscript ID: SYN-D-27-54321\n复审通知：请继续审稿。', {
          date: 'Tue, 13 Oct 2026 10:00:00 +0800',
        }),
        { ...source, uid: 2 },
      ),
    )!;
    expect(merge([receipt, next])[0].status).toBe('待确认');
  });
  it('supports DD-Mon-YYYY without inventing a timezone', () => {
    expect(deadlineDate('due 21-Jan-2027')).toEqual({
      date: '2027-01-21',
      raw: '21-Jan-2027',
      timezone: null,
    });
  });
  it('extension requests do not become an approved extension', async () => {
    const event = extract(
      await parseMail(
        fixture(body + '\nCould you extend the review deadline to 2027-02-01 UTC?'),
        source,
      ),
    )!;
    expect(event.deadlines.at(-1)?.extension).toBe(false);
    expect(merge([event])[0].needsConfirmation).toBe(true);
  });
  it('author revision deadlines do not replace reviewer deadlines', async () => {
    const event = extract(
      await parseMail(
        fixture(body + '\nPlease submit your revised manuscript by 2027-02-01 UTC.'),
        source,
      ),
    )!;
    expect(event.deadlines).toHaveLength(1);
    expect(event.deadlines[0].date).toBe('2027-01-21');
  });
});
