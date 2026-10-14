import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Never inherit a real mailbox configuration into a public synthetic smoke test.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'researcher-stdio-test-'));
const client = new Client({ name: 'synthetic-registration-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'researcher', 'main.js'), 'stdio'],
  env: { ...process.env, RESEARCHER_LOCAL_AI: temp },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
  const values = accounts.structuredContent?.result;
  if (tools.length !== 9 || tools.some((t) => !t.annotations?.readOnlyHint) || !Array.isArray(values) || values.length !== 0)
    throw new Error('Wrong synthetic registry');
  console.log(JSON.stringify({ stdioHandshake: true, tools: tools.map((t) => t.name), accountCount: values.length, syntheticOnly: true, readOnly: true }));
} finally {
  await client.close();
  if (path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('researcher-stdio-test-'))
    await fs.rm(temp, { recursive: true, force: true });
}
