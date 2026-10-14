import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const client=new Client({name:'local-registration-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist','researcher','main.js'),'stdio'],env:{...process.env},stderr:'pipe'});
await client.connect(transport);
try {const tools=(await client.listTools()).tools;const accounts=await client.callTool({name:'list_accounts',arguments:{}});if(tools.length!==9 || tools.some(t=>!t.annotations?.readOnlyHint))throw new Error('Wrong registry');console.log(JSON.stringify({stdioHandshake:true,tools:tools.map(t=>t.name),accounts:accounts.structuredContent?.result,readOnly:true}));} finally {await client.close();}
