/** Offline pre-publication guard. Never prints matched private content. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function publicationProblems(name, content) {
  const problems = [];
  const normalized = name.replaceAll('\\', '/');
  if (/(?:^|\/)(?:config\.json|reviews\.json|review-evidence[^/]*\.json|recent-review-evidence\.json|review-mail-index\.json|review-scan-gaps\.json|validation-summary\.json|readonly-verification\.json|\.env(?:\..*)?)$/i.test(normalized) ||
      /(?:^|\/)(?:private|state|review-audits|acceptance|attachments|config-backups)\//i.test(normalized) ||
      /\.(?:pst|ost|pfx|pem|key)$/i.test(normalized)) problems.push('private-file-path');
  if (/\.(?:eml|msg|pdf|zip)$/i.test(normalized) && !normalized.startsWith('src/researcher/fixtures/')) problems.push('mail-or-attachment-file');
  if (/(?:[A-Z]:[\\/](?:Users|ResearcherLocalAI)[\\/])|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/i.test(content)) problems.push('credential-or-local-path');
  for (const address of content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
    const domain = address.split('@').at(-1).toLowerCase();
    if (!/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test|localhost)$/.test(domain)) {
      problems.push('non-synthetic-email-address'); break;
    }
  }
  const assignments = /\b(?:password|passcode|authorizationCode|accessToken|apiKey)\s*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi;
  for (const match of content.matchAll(assignments)) {
    if (!/^(?:synthetic|test|fixture|example|placeholder|<|\$\{)|^(?:no|x|now|fake)$/i.test(match[1])) problems.push('literal-credential-value');
  }
  // Decode provenance identifiers as well: base64 is not a privacy boundary.
  for (const token of content.match(/[A-Za-z0-9_-]{24,}/g) ?? []) {
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      if (Array.isArray(decoded) && decoded.length === 4 && typeof decoded[0] === 'string' &&
          !/^(?:synthetic|test|fixture)(?:[_-].*)?$/.test(decoded[0])) problems.push('non-synthetic-source-identifier');
    } catch { /* Not an encoded source identifier. */ }
  }
  return [...new Set(problems)];
}

export function checkPublication(argv = process.argv.slice(2)) {
  const staged = argv.includes('--staged');
  const baseIndex = argv.indexOf('--base');
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] :
    baseIndex >= 0 ? ['diff', '--name-only', '--diff-filter=ACMR', '-z', argv[baseIndex + 1], 'HEAD'] :
    ['ls-files', '-z', 'src/researcher', 'scripts', 'docs/review-audit.md', 'examples'];
  const names = execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).split('\0').filter(Boolean);
  const failures = [];
  for (const name of names) {
    const content = staged ? execFileSync('git', ['show', `:${name}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : fs.readFileSync(name, 'utf8');
    const problems = publicationProblems(name, content);
    if (problems.length) failures.push({ path: name, problems });
  }
  console.log(JSON.stringify({ checkedFiles: names.length, failures, note: 'Heuristic guard; manual synthetic-data and secret review is still required.' }));
  if (failures.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) checkPublication();
