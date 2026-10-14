import type { ImapFlow } from 'imapflow';
import { denyWrite } from './policy.js';

const writes = new Set([
  'append',
  'messageFlagsAdd',
  'messageFlagsRemove',
  'messageFlagsSet',
  'messageMove',
  'messageCopy',
  'messageDelete',
  'mailboxCreate',
  'mailboxRename',
  'mailboxDelete',
  'mailboxSubscribe',
  'mailboxUnsubscribe',
  'setFlagColor',
  'setQuota',
]);
/** Defense at the connection boundary, in addition to service/tool policy. */
export function readOnlyClient(client: ImapFlow): ImapFlow {
  return new Proxy(client, {
    get(target, key) {
      if (typeof key === 'string' && writes.has(key)) return async () => denyWrite();
      if (key === 'getMailboxLock')
        return (mailbox: string, options: Record<string, unknown> = {}) =>
          target.getMailboxLock(mailbox, { ...options, readOnly: true });
      if (key === 'mailboxOpen')
        return (mailbox: string, options: Record<string, unknown> = {}) =>
          target.mailboxOpen(mailbox, { ...options, readOnly: true });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
