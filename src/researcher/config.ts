import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const AccountSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
    email: z.email(),
    username: z.string().optional(),
    label: z.string().optional(),
    credentialRef: z.string().regex(/^researcher-email-mcp\/[a-zA-Z0-9_-]{1,48}$/),
    imap: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(993),
      secure: z.literal(true).default(true),
    }),
    smtp: z.object({ host: z.string(), port: z.number().int(), secure: z.boolean() }).optional(),
    folders: z.array(z.string()).optional(),
  })
  .strict();
export const ConfigSchema = z
  .object({
    accounts: z.array(AccountSchema).max(20).default([]),
    reviewIndex: z.string().optional(),
    maxMessageBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    maxBodyChars: z.number().int().min(1000).max(200000).default(40000),
    maxFolderMessages: z.number().int().min(1).max(10000).default(2000),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.accounts.map((a) => a.id)).size !== config.accounts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate account id' });
  });
export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export const presets = Object.freeze({
  qq: {
    imap: { host: 'imap.qq.com', port: 993, secure: true as const },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
  },
  zju: {
    imap: { host: 'imap.zju.edu.cn', port: 993, secure: true as const },
    smtp: { host: 'smtp.zju.edu.cn', port: 994, secure: true },
  },
});
export function localRoot(): string {
  const root = process.env.RESEARCHER_LOCAL_AI;
  if (!root || !path.isAbsolute(root))
    throw new Error('Set absolute RESEARCHER_LOCAL_AI before starting');
  return path.join(root, 'projects', 'researcher-email-mcp');
}
export async function load(): Promise<Config> {
  try {
    return ConfigSchema.parse(
      JSON.parse(await fs.readFile(path.join(localRoot(), 'config.json'), 'utf8')),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ConfigSchema.parse({});
    throw new Error('Invalid local config; check config.json (no plaintext credentials allowed)');
  }
}
export async function save(config: Config): Promise<void> {
  const checked = ConfigSchema.parse(config);
  await fs.mkdir(localRoot(), { recursive: true, mode: 0o700 });
  const target = path.join(localRoot(), 'config.json');
  await fs.writeFile(target + '.tmp', JSON.stringify(checked, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(target + '.tmp', target);
}
