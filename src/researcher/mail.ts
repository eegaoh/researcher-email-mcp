import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
export interface Source {
  account: string;
  mailbox: string;
  uidValidity: string;
  uid: number;
}
export function sourceId(source: Source): string {
  return Buffer.from(
    JSON.stringify([source.account, source.mailbox, source.uidValidity, source.uid]),
  ).toString('base64url');
}
export function decodeSource(id: string): Source {
  try {
    const p: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      !Array.isArray(p) ||
      p.length !== 4 ||
      p.slice(0, 3).some((x) => typeof x !== 'string' || !x) ||
      !Number.isSafeInteger(p[3]) ||
      p[3] < 1
    )
      throw new Error();
    return { account: p[0], mailbox: p[1], uidValidity: p[2], uid: p[3] };
  } catch {
    throw new Error('Invalid source identifier');
  }
}
export interface Mail {
  source: Source;
  sourceId: string;
  messageId: string | null;
  date: string | null;
  subject: string;
  from: string;
  to: string;
  text: string;
  truncated: boolean;
  untrusted: true;
  flags: string[];
  rawBytes: number;
  sha256: string;
  attachments: { id: number; name: string; type: string; bytes: number; sha256: string }[];
  warnings: string[];
}
export async function parseMail(
  raw: Buffer,
  source: Source,
  flags: string[] = [],
  maxBodyChars = 40000,
): Promise<Mail> {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    maxHtmlLengthToParse: 2_000_000,
  });
  let text = parsed.text ?? '';
  // Some multipart senders provide a whitespace-only text part with a usable HTML part.
  // Force a local HTML-only conversion rather than silently dropping that evidence.
  if (!text.trim() && typeof parsed.html === 'string' && parsed.html.length <= 2_000_000) {
    const fallback = await simpleParser(
      Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${parsed.html}`),
      {
        skipImageLinks: true,
        skipTextToHtml: true,
        maxHtmlLengthToParse: 2_000_000,
      },
    );
    text = fallback.text ?? '';
  }
  // mailparser may substitute "now" for an invalid Date. Never adopt that fallback.
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerText = raw
    .subarray(0, headerEnd >= 0 ? headerEnd : Math.min(raw.length, 65536))
    .toString('latin1')
    .replace(/\r?\n[ \t]+/g, ' ');
  const dateHeader = headerText.match(/^Date:\s*(.+)$/im)?.[1]?.trim();
  const timestamp = dateHeader ? Date.parse(dateHeader) : NaN;
  const validDate = Number.isFinite(timestamp);
  return {
    source,
    sourceId: sourceId(source),
    messageId: parsed.messageId ?? null,
    date: validDate ? new Date(timestamp).toISOString() : null,
    subject: parsed.subject ?? '',
    from: parsed.from?.text ?? '',
    to: Array.isArray(parsed.to)
      ? parsed.to.map((a) => a.text).join(', ')
      : (parsed.to?.text ?? ''),
    text: text.slice(0, maxBodyChars),
    truncated: text.length > maxBodyChars,
    untrusted: true,
    flags,
    rawBytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    attachments: parsed.attachments.map((a, id) => ({
      id,
      name: a.filename ?? `attachment-${id + 1}`,
      type: a.contentType,
      bytes: a.size,
      sha256: createHash('sha256').update(a.content).digest('hex'),
    })),
    warnings: [
      ...(!validDate ? ['Missing or malformed Date header; no date invented'] : []),
      ...(text.length > maxBodyChars ? ['Body truncated; evidence may be incomplete'] : []),
    ],
  };
}
export async function attachmentContent(raw: Buffer, id: number): Promise<Buffer> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const item = parsed.attachments[id];
  if (!item) throw new Error('Attachment not found');
  return item.content;
}
