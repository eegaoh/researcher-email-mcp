/** Loopback-only synthetic protocol server; not a production IMAP implementation. */

import { once } from 'node:events';
import net from 'node:net';
export class SyntheticImapServer {
  commands: string[] = [];
  uidValidity = 777;
  rejectUnicodeSearch = false;
  readonly flags = new Map<number, Set<string>>();
  private sockets = new Set<net.Socket>();
  private server = net.createServer((socket) => {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Synthetic mail server\r\n');
    let buffer = '';
    let selected = 'INBOX';
    let authTag: string | null = null;
    let literalSearchTag: string | null = null;
    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (literalSearchTag) {
          const tag = literalSearchTag;
          literalSearchTag = null;
          if (this.rejectUnicodeSearch && Array.from(line).some((c) => c.charCodeAt(0) > 127))
            socket.write(`${tag} NO Unicode search unsupported\r\n`);
          else {
            const ids =
              selected === 'INBOX'
                ? this.messages
                    .map((_m, i) => i + 1)
                    .filter((uid) => this.messages[uid - 1].toString('utf8').includes(line))
                : [];
            socket.write(`* SEARCH ${ids.join(' ')}\r\n${tag} OK done\r\n`);
          }
          continue;
        }
        if (authTag) {
          socket.write(authTag + ' OK authenticated\r\n');
          authTag = null;
          continue;
        }
        const [tag, verb, ...rest] = line.split(' ');
        const args = rest.join(' ');
        const upper = verb?.toUpperCase();
        this.commands.push(['LOGIN', 'AUTHENTICATE'].includes(upper) ? upper : line);
        const ok = (extra = '') => socket.write(`${tag} OK ${extra || 'done'}\r\n`);
        if (upper === 'CAPABILITY') {
          socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
          ok();
        } else if (upper === 'AUTHENTICATE') {
          if (rest.length > 1) ok();
          else {
            authTag = tag;
            socket.write('+ \r\n');
          }
        } else if (upper === 'LOGIN' || upper === 'NOOP') ok();
        else if (upper === 'LIST' || upper === 'LSUB') {
          if (args.endsWith('""')) socket.write('* LIST (\\Noselect) "/" ""\r\n');
          else
            socket.write(
              '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n* LIST (\\HasNoChildren \\Junk) "/" "Junk"\r\n',
            );
          ok();
        } else if (upper === 'STATUS') {
          const folder = args.match(/^"([^"]+)"/)?.[1] ?? args.split(' ')[0];
          socket.write(
            `* STATUS "${folder}" (MESSAGES ${folder === 'INBOX' ? this.messages.length : 0} UNSEEN ${this.messages.length} UIDNEXT ${this.messages.length + 1} UIDVALIDITY ${this.uidValidity})\r\n`,
          );
          ok();
        } else if (upper === 'EXAMINE') {
          selected = args.match(/^"([^"]+)"/)?.[1] ?? args.split(' ')[0];
          socket.write(
            `* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* ${selected === 'INBOX' ? this.messages.length : 0} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${this.uidValidity}] validity\r\n* OK [UIDNEXT ${this.messages.length + 1}] next\r\n`,
          );
          ok('[READ-ONLY] examined');
        } else if (upper === 'SELECT') socket.write(`${tag} NO must use EXAMINE\r\n`);
        else if (upper === 'UID' && /^SEARCH\b/i.test(args)) {
          if (/\{\d+\+?\}$/.test(args)) {
            literalSearchTag = tag;
            if (!/\+\}$/.test(args)) socket.write('+ continue\r\n');
            continue;
          }
          if (this.rejectUnicodeSearch && Array.from(args).some((c) => c.charCodeAt(0) > 127)) {
            socket.write(`${tag} NO Unicode search unsupported\r\n`);
            continue;
          }
          let ids = selected === 'INBOX' ? this.messages.map((_m, i) => i + 1) : [];
          const query = args.match(/\bTEXT\s+"([^"]+)"/i)?.[1];
          if (query)
            ids = ids.filter((uid) => this.messages[uid - 1].toString('utf8').includes(query));
          socket.write(`* SEARCH ${ids.join(' ')}\r\n`);
          ok();
        } else if (upper === 'UID' && /^FETCH\b/i.test(args)) {
          const set = args.split(' ')[1];
          const requested = args.slice(args.indexOf(set) + set.length);
          const ids = this.messages
            .map((_m, i) => i + 1)
            .filter((uid) =>
              set.split(',').some((part) => {
                if (part.includes(':')) {
                  const [a, b] = part.split(':');
                  return uid >= Number(a) && uid <= (b === '*' ? this.messages.length : Number(b));
                }
                return uid === Number(part);
              }),
            );
          for (const uid of ids) {
            const raw = this.messages[uid - 1];
            const flags = [...(this.flags.get(uid) ?? [])].join(' ');
            const header = raw.toString('utf8').split(/\r?\n\r?\n/)[0];
            const quote = (value: string) =>
              '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
            const envelope = /ENVELOPE/i.test(requested)
              ? ` ENVELOPE (${quote(header.match(/^Date:\s*(.*)$/im)?.[1]?.trim() ?? '')} ${quote(header.match(/^Subject:\s*(.*)$/im)?.[1]?.trim() ?? '')} NIL NIL NIL NIL NIL NIL NIL NIL)`
              : '';
            const fields = `UID ${uid} FLAGS (${flags}) RFC822.SIZE ${raw.length}${envelope}`;
            if (/BODY(?:\.PEEK)?\[\]/i.test(requested)) {
              if (!/BODY\.PEEK\[\]/i.test(requested)) this.flags.get(uid)!.add('\\Seen');
              socket.write(`* ${uid} FETCH (${fields} BODY[] {${raw.length}}\r\n`);
              socket.write(raw);
              socket.write(')\r\n');
            } else socket.write(`* ${uid} FETCH (${fields})\r\n`);
          }
          ok();
        } else if (/STORE|APPEND|COPY|MOVE|EXPUNGE|DELETE|CREATE|RENAME/.test(`${upper} ${args}`))
          socket.write(`${tag} NO read-only test server\r\n`);
        else if (upper === 'LOGOUT') {
          socket.write('* BYE closing\r\n');
          ok();
          socket.end();
        } else socket.write(`${tag} BAD Unsupported ${upper}\r\n`);
      }
    });
  });
  constructor(readonly messages: Buffer[]) {
    messages.forEach((_m, i) => {
      this.flags.set(i + 1, new Set());
    });
  }
  async start(): Promise<number> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    return (this.server.address() as net.AddressInfo).port;
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
