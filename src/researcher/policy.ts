/** V1 policy cannot be overridden by config, CLI, message content or environment. */
export class ReadOnlyError extends Error {
  constructor() {
    super('READ_ONLY: sending and mailbox changes are disabled in this release');
  }
}
export function denyWrite(): never {
  throw new ReadOnlyError();
}
export function assertNoWrite(): void {
  denyWrite();
}
export const policy = Object.freeze({ readOnly: true, allowSend: false, allowMailboxWrite: false });
/** Retained extension point. Future approval must bind a digest to a concrete local draft. */
export interface ConfirmedDraft {
  draftId: string;
  sha256: string;
  confirmedAt: string;
}
export async function sendConfirmedDraft(_draft: ConfirmedDraft): Promise<never> {
  return denyWrite();
}
export function sealWrites(instance: object, methods: readonly string[]): void {
  for (const method of methods) {
    Object.defineProperty(instance, method, {
      value: async () => denyWrite(),
      configurable: false,
    });
  }
}
