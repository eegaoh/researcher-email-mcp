import { describe, expect, it } from 'vitest';
import { publicationProblems } from './check-publication.mjs';
describe('offline publication guard', () => {
  it('accepts reserved synthetic addresses', () => {
    expect(publicationProblems('src/researcher/synthetic.test.ts', 'editor@example.invalid')).toEqual([]);
  });
  it('blocks personal addresses without printing their contents', () => {
    const address = ['synthetic-private', 'qq.com'].join('@');
    expect(publicationProblems('new-script.mjs', address)).toContain('non-synthetic-email-address');
  });
  it.each(['config.json', 'private/data.json', 'review-audits/scan.json', 'mail.pst', 'capture.eml'])('blocks private artifact path %s', (name) => {
    expect(publicationProblems(name, '{}').length).toBeGreaterThan(0);
  });
  it('decodes non-synthetic source identifiers', () => {
    const id = Buffer.from(JSON.stringify(['personal', 'INBOX', '123', 9])).toString('base64url');
    expect(publicationProblems('script.mjs', id)).toContain('non-synthetic-source-identifier');
  });
  it('rejects literal secrets without displaying the match', () => {
    const sample = ['password', ': ', JSON.stringify('not-a-placeholder')].join('');
    expect(publicationProblems('script.mjs', sample)).toContain('literal-credential-value');
    expect(publicationProblems('script.mjs', 'password: "synthetic-test-only"')).toEqual([]);
  });
});
