import type { ImapFlow } from 'imapflow';
import { describe, expect, it, vi } from 'vitest';
import ConnectionManager from '../connections/manager.js';
import type { IConnectionManager } from '../connections/types.js';
import ImapService from '../services/imap.service.js';
import SchedulerService from '../services/scheduler.service.js';
import SmtpService from '../services/smtp.service.js';
import { ConfigSchema } from './config.js';
import { accepted, fixture, invitation, multipart } from './fixtures.js';
import { attachmentContent, decodeSource, parseMail, sourceId } from './mail.js';
import { sendConfirmedDraft } from './policy.js';
import { readOnlyClient } from './readonly-client.js';
import { csvReport, markdown } from './report.js';
import { deadlineDate, type Event, extract, merge, type Scan } from './reviews.js';

const source = { account: 'synthetic', mailbox: 'INBOX', uidValidity: '10', uid: 1 };
async function event(raw: Buffer, uid = 1): Promise<Event> {
  const result = extract(await parseMail(raw, { ...source, uid }));
  if (!result) throw new Error('Missing event');
  return result;
}
describe('MIME and identity', () => {
  it('decodes GB18030 without UTF8 replacement', async () => {
    const raw = Buffer.from(
      'Subject: =?GB18030?B?yfO45Q==?=\r\nContent-Type: text/plain; charset=gb18030\r\nContent-Transfer-Encoding: base64\r\n\r\nyfO45Q==',
    );
    const mail = await parseMail(raw, source);
    expect(mail.subject).toBe('审稿');
    expect(mail.text.trim()).toBe('审稿');
  });
  it('decodes UTF8 nested multipart and duplicate attachment names', async () => {
    const mail = await parseMail(multipart, source);
    expect(mail.text).toContain('审稿邀请');
    expect(mail.attachments.map((a) => a.name)).toEqual(['same.pdf', 'same.pdf']);
    expect(mail.attachments[0].sha256).not.toBe(mail.attachments[1].sha256);
    expect((await attachmentContent(multipart, 1)).toString()).toContain('2');
  });
  it('decodes GBK base64 subject/body', async () => {
    const raw = Buffer.from(
      'From: editor@example.invalid\r\nSubject: =?GBK?B?yfO45Q==?=\r\nContent-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\nyfO45Q==',
    );
    const mail = await parseMail(raw, source);
    expect(mail.subject).toBe('审稿');
    expect(mail.text.trim()).toBe('审稿');
  });
  it('decodes quoted-printable', async () => {
    const mail = await parseMail(
      fixture('=E5=AE=A1=E7=A8=BF', {
        extra:
          'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable',
      }),
      source,
    );
    expect(mail.text.trim()).toBe('审稿');
  });
  it('HTML does not fetch external images and yields text', async () => {
    const mail = await parseMail(
      fixture('<p>审稿邀请</p><img src="https://example.invalid/no-fetch">', {
        extra: 'Content-Type: text/html; charset=utf-8',
      }),
      source,
    );
    expect(mail.text).toContain('审稿邀请');
    expect(mail.untrusted).toBe(true);
  });
  it('invalid dates remain null and truncation explicit', async () => {
    const mail = await parseMail(
      fixture('x'.repeat(5000), { date: 'not a date' }),
      source,
      [],
      100,
    );
    expect(mail.date).toBeNull();
    expect(mail.truncated).toBe(true);
    expect(mail.text.length).toBe(100);
  });
  it('identity includes account folder UIDVALIDITY and UID', () => {
    expect(decodeSource(sourceId(source))).toEqual(source);
    expect(sourceId(source)).not.toBe(sourceId({ ...source, uidValidity: '11' }));
    expect(() => decodeSource('bad')).toThrow();
  });
});
describe('review evidence', () => {
  it('separates invitation response and review deadlines', async () => {
    const e = await event(invitation);
    expect(e.status).toBe('邀请待响应');
    expect(e.deadlines.map((d) => [d.kind, d.date])).toEqual([
      ['邀请回复', '2026-10-15'],
      ['审稿', '2026-10-25'],
    ]);
  });
  it('accepted review has explicit due evidence', async () => {
    const task = merge([await event(accepted)])[0];
    expect(task.status).toBe('已接受待审');
    expect(task.deadline?.date).toBe('2026-10-20');
    expect(task.needsConfirmation).toBe(false);
  });
  it('keeps rounds and does not mark R1 submitted based on R0 receipt', async () => {
    const first = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nThank you for submitting your review.',
        { date: 'Tue, 13 Oct 2026 10:00:00 +0800' },
      ),
    );
    const second = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234.R1\nThank you for agreeing to review.\nYour review is due on 2026-11-05 UTC+8.',
        { date: 'Wed, 14 Oct 2026 10:00:00 +0800' },
      ),
      2,
    );
    const task = merge([first, second])[0];
    expect(task.round).toBe(1);
    expect(task.status).toBe('已接受待审');
    expect(task.evidence.length).toBe(3);
  });
  it('explicit extension supersedes older due dates but keeps history', async () => {
    const extension = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nYour review deadline has been extended to 2026-10-30 UTC+8.',
        { date: 'Tue, 13 Oct 2026 10:00:00 +0800' },
      ),
    );
    const task = merge([await event(accepted), extension])[0];
    expect(task.deadline?.date).toBe('2026-10-30');
    expect(task.deadlineHistory).toHaveLength(2);
    expect(task.needsConfirmation).toBe(false);
  });
  it('conflicting non-extension deadline needs confirmation', async () => {
    const conflict = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nYour review deadline is 2026-10-31 UTC+8.',
        { date: 'Tue, 13 Oct 2026 10:00:00 +0800' },
      ),
    );
    expect(merge([await event(accepted), conflict])[0].needsConfirmation).toBe(true);
  });
  it('reminder request is not submission; subsequent receipt closes task', async () => {
    const reminder = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nPlease submit your review. Your review has not been submitted.',
        { date: 'Tue, 13 Oct 2026 10:00:00 +0800' },
      ),
    );
    expect(merge([await event(accepted), reminder])[0].status).toBe('已接受待审');
    const receipt = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nWe have received your review.',
        { date: 'Wed, 14 Oct 2026 10:00:00 +0800' },
      ),
    );
    expect(merge([await event(accepted), reminder, receipt])[0].status).toBe('已提交');
  });
  it.each([
    'You have declined this review invitation.',
    'The review assignment was cancelled.',
  ])('recognizes declined/cancelled evidence: %s', async (line) => {
    const e = await event(
      fixture('Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\n' + line),
    );
    expect(e.status).toBe('拒绝/取消');
  });
  it('read flag/editor decision/local archive do not imply submission', async () => {
    const e = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nReview decision: accepted for publication. Local review archived.',
      ),
    );
    expect(e.status).toBe('待确认');
  });
  it('cross account duplicate evidence merges without losing source identity', async () => {
    const a = await event(accepted);
    const b = extract(await parseMail(accepted, { ...source, account: 'second' }))!;
    const task = merge([a, b])[0];
    expect(task.sources).toHaveLength(2);
    expect(task.evidence).toHaveLength(2);
  });
  it('different manuscript codes do not silently link', async () => {
    const a = await event(accepted);
    expect(merge([a, { ...a, manuscript: 'SEJ-2026-9999' }])).toHaveLength(2);
  });
  it('does not invent ambiguous/invalid dates or timezone', () => {
    expect(deadlineDate('due 10/11/2026').date).toBeNull();
    expect(deadlineDate('due 2026-02-31').date).toBeNull();
    expect(deadlineDate('due 2026年10月20日').timezone).toBeNull();
  });
  it('ignores quoted previous receipt and missing email date', async () => {
    const e = await event(
      fixture(
        'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nPlease submit your review.\n> Thank you for submitting your review.',
        { date: 'broken' },
      ),
    );
    expect(e.status).toBe('待确认');
    expect(merge([e])[0].needsConfirmation).toBe(true);
  });
});
describe('read-only defense', () => {
  it('config refuses plaintext passwords and insecure TLS', () => {
    expect(() =>
      ConfigSchema.parse({
        accounts: [
          {
            id: 'a',
            email: 'a@example.invalid',
            password: 'no',
            credentialRef: 'researcher-email-mcp/a',
            imap: { host: 'localhost', secure: false },
          },
        ],
      }),
    ).toThrow();
    expect(
      ConfigSchema.parse({
        accounts: [
          {
            id: 'a',
            email: 'a@example.invalid',
            credentialRef: 'researcher-email-mcp/a',
            imap: { host: 'localhost' },
          },
        ],
      }).accounts[0].smtp,
    ).toBeUndefined();
  });
  it('direct IMAP write calls are blocked even with mocked writable connections', async () => {
    const mock = { getImapClient: vi.fn() } as unknown as IConnectionManager;
    const imap = new ImapService(mock);
    await expect(imap.setFlags('a', '1', 'INBOX', 'read')).rejects.toThrow('READ_ONLY');
    await expect(imap.deleteEmail('a', '1', 'INBOX', true)).rejects.toThrow('READ_ONLY');
    expect(mock.getImapClient).not.toHaveBeenCalled();
  });
  it('SMTP and old scheduled queue cannot execute even directly', async () => {
    const mock = { getSmtpTransport: vi.fn() } as unknown as IConnectionManager;
    const smtp = new SmtpService(mock, {} as never, {} as never);
    await expect(
      smtp.sendEmail('a', { to: ['x@example.invalid'], subject: 'x', body: 'x' }),
    ).rejects.toThrow('READ_ONLY');
    const scheduler = new SchedulerService(smtp, {} as never);
    await expect(scheduler.checkAndSend()).rejects.toThrow('READ_ONLY');
    expect(mock.getSmtpTransport).not.toHaveBeenCalled();
    await expect(new ConnectionManager([]).getSmtpTransport('any')).rejects.toThrow('READ_ONLY');
    await expect(
      sendConfirmedDraft({ draftId: 'fake', sha256: 'x', confirmedAt: 'now' }),
    ).rejects.toThrow('READ_ONLY');
  });
  it('connection boundary forces read-only folder opens and rejects raw mutation', async () => {
    const raw = {
      getMailboxLock: vi.fn(async () => ({})),
      mailboxOpen: vi.fn(),
      messageFlagsAdd: vi.fn(),
    } as unknown as ImapFlow;
    const guarded = readOnlyClient(raw);
    await guarded.getMailboxLock('INBOX', { readOnly: false });
    expect(raw.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    await expect(guarded.messageFlagsAdd('1', ['\\Seen'])).rejects.toThrow('READ_ONLY');
    expect(raw.messageFlagsAdd).not.toHaveBeenCalled();
  });
  it('reports escape HTML and CSV formula injection', () => {
    const result = {
      generatedAt: 'synthetic',
      since: '2026-01-01',
      complete: false,
      tasks: [],
      coverage: [],
      errors: [{ account: '<script>', code: 'TEST' }],
      skipped: [],
    } as unknown as Scan;
    expect(markdown(result)).not.toContain('<script>');
    result.tasks = [
      { journal: '=CMD()', manuscript: 'x', round: 0, status: '待确认', sources: [] } as never,
    ];
    expect(csvReport(result)).toContain("'=CMD()");
  });
});
