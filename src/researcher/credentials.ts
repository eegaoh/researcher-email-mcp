import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CredentialStore {
  read(reference: string): Promise<string>;
  writeInteractive(reference: string): Promise<void>;
}
const helper = fileURLToPath(new URL('../../scripts/windows-credential.ps1', import.meta.url));
function validate(reference: string): void {
  if (!/^researcher-email-mcp\/[a-zA-Z0-9_-]{1,48}$/.test(reference))
    throw new Error('Invalid credential reference');
}
export class WindowsCredentials implements CredentialStore {
  async read(reference: string): Promise<string> {
    validate(reference);
    if (process.platform !== 'win32')
      throw new Error(
        'Windows Credential Manager is required; supply another CredentialStore for Linux',
      );
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helper,
          'read',
          reference,
        ],
        { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      let size = 0;
      child.stdout.on('data', (b: Buffer) => {
        size += b.length;
        if (size > 65536) child.kill();
        else output += b.toString('utf8');
      });
      child.stderr.resume();
      child.on('error', () => reject(new Error('Credential helper unavailable')));
      child.on('close', (code) => {
        if (code !== 0)
          reject(
            new Error('Credential missing or inaccessible; run account add/credential locally'),
          );
        else {
          try {
            const data = JSON.parse(output);
            if (typeof data.secret !== 'string' || !data.secret) throw new Error();
            resolve(data.secret);
          } catch {
            reject(new Error('Credential helper failed'));
          }
        }
      });
    });
  }
  async writeInteractive(reference: string): Promise<void> {
    validate(reference);
    if (process.platform !== 'win32') throw new Error('Windows only');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, 'write', reference],
        { windowsHide: true, stdio: 'inherit' },
      );
      child.on('error', () => reject(new Error('Credential helper unavailable')));
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Credential not saved')),
      );
    });
  }
}
