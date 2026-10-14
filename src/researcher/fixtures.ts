/** Synthetic only. No personal addresses, real journals/manuscripts or credentials. */
export function fixture(
  body: string,
  options: { id?: string; date?: string; subject?: string; extra?: string } = {},
): Buffer {
  return Buffer.from(
    `From: Synthetic Journal <editor@example.invalid>\r\nTo: reviewer@example.invalid\r\nDate: ${options.date ?? 'Mon, 12 Oct 2026 10:00:00 +0800'}\r\nMessage-ID: <${options.id ?? 'fixture'}@example.invalid>\r\nSubject: ${options.subject ?? 'Synthetic review'}\r\nMIME-Version: 1.0\r\n${options.extra ?? 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit'}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`,
    'utf8',
  );
}
export const accepted = fixture(
  'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-1234\nTitle: Synthetic Frequency Study\nThank you for agreeing to review this manuscript.\nYour review is due on 20 October 2026 UTC+8.',
  { id: 'accepted' },
);
export const invitation = fixture(
  'Journal: Synthetic Energy Journal\nManuscript ID: SEJ-2026-5555\nWe invite you to review this manuscript.\nPlease respond to this invitation by 2026-10-15 UTC+8.\nYour review deadline is 2026-10-25 UTC+8.',
  { id: 'invite' },
);
export const multipart = fixture(
  '--outer\nContent-Type: multipart/alternative; boundary=inner\n\n--inner\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n' +
    Buffer.from('审稿邀请：请核查稿件。').toString('base64') +
    '\n--inner\nContent-Type: text/html; charset=utf-8\n\n<p>审稿邀请</p><img src="https://example.invalid/tracker">\n--inner--\n--outer\nContent-Type: application/pdf; name="same.pdf"\nContent-Disposition: attachment; filename="same.pdf"\nContent-Transfer-Encoding: base64\n\nU3ludGhldGljIEF0dGFjaG1lbnQ=\n--outer\nContent-Type: application/pdf; name="same.pdf"\nContent-Disposition: attachment; filename="same.pdf"\nContent-Transfer-Encoding: base64\n\nU3ludGhldGljIEF0dGFjaG1lbnQgMg==\n--outer--',
  { id: 'mime', extra: 'Content-Type: multipart/mixed; boundary=outer' },
);
