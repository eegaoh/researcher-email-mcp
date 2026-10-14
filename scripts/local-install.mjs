// Machine-local registration only. Never commits configuration or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=process.env.RESEARCHER_LOCAL_AI;
if(!runtimeRoot || !path.isAbsolute(runtimeRoot)) throw new Error('Set RESEARCHER_LOCAL_AI');
const privateRoot=path.join(runtimeRoot,'projects','researcher-email-mcp');
await fs.mkdir(path.join(privateRoot,'backups'),{recursive:true,mode:0o700});
const [command,arg]=process.argv.slice(2);
const hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
if(command==='codex') {
  if(!arg || !path.isAbsolute(arg))throw new Error('Pass installed codex executable absolute path');
  const codexRoot=process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME,'.codex');
  const target=path.join(codexRoot,'config.toml');
  const original=await fs.readFile(target,'utf8');const before=parse(original);
  if(before.mcp_servers?.researcher_email)throw new Error('Registration already exists; inspect before updating');
  const backup=path.join(privateRoot,'backups',`codex-config-${Date.now()}.toml`);await fs.copyFile(target,backup);
  const result=spawnSync(arg,['mcp','add','researcher_email','--env',`RESEARCHER_LOCAL_AI=${runtimeRoot}`,'--',process.execPath,path.join(appRoot,'dist','researcher','main.js'),'stdio'],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error('Codex registration failed; backup retained locally');
  const registered=parse(await fs.readFile(target,'utf8'));const added=registered.mcp_servers?.researcher_email;
  // CLI serializers may omit old explicit defaults such as args=[]. Keep original text intact.
  added.startup_timeout_sec=30;added.tool_timeout_sec=600;
  await fs.writeFile(target,original+'\n'+stringify({mcp_servers:{researcher_email:added}})+'\n');
  const after=parse(await fs.readFile(target,'utf8'));delete after.mcp_servers.researcher_email;
  if(!before.mcp_servers && Object.keys(after.mcp_servers).length===0)delete after.mcp_servers;
  if(canonical(before)!==canonical(after))throw new Error('Unexpected config difference; inspect local backup before continuing');
  console.log(JSON.stringify({registered:true,existingConfigPreserved:true,name:'researcher_email',node:added.command,entry:added.args,backup}));
} else if(command==='manifest') {
  const sharedRoot=process.env.RESEARCHER_SHARED_TOOLS ?? path.join(process.env.LOCALAPPDATA,'ResearcherTools');
  const target=path.join(sharedRoot,'registry','software-manifest.json');
  const data=JSON.parse(await fs.readFile(target,'utf8'));await fs.copyFile(target,path.join(privateRoot,'backups',`software-manifest-${Date.now()}.json`));
  const ghExe=path.join(sharedRoot,'apps','github-cli','2.102.0','bin','gh.exe');
  const ghArchive=path.join(sharedRoot,'installers','gh_2.102.0_windows_amd64.zip');
  const records=[
    {id:'researcher-email-mcp',name:'Researcher Email MCP',version:'0.1.0',architecture:process.arch,installType:'github-fork-source',actualPath:appRoot,executable:path.join(appRoot,'dist','researcher','main.js'),source:'https://github.com/eegaoh/researcher-email-mcp',upstreamCommit:'99ce431aa81dd4cafc2879bd35b6ee3acd0f2d74',lockSHA256:await hash(path.join(appRoot,'package-lock.json')),purpose:'Strictly read-only IMAP and local review evidence reports',verificationStatus:'built-and-synthetic-unit-integration-tested; real accounts pending'},
    {id:'github-cli-2.102.0-x64',name:'GitHub CLI',version:'2.102.0',architecture:'x64',installType:'official-portable-zip',actualPath:path.dirname(ghExe),executable:ghExe,source:'https://github.com/cli/cli/releases/tag/v2.102.0',installerSHA256:await hash(ghArchive),executableSHA256:await hash(ghExe),purpose:'User-authorized Fork and PR creation',verificationStatus:'official-checksum-matched; authenticated-by-user'},
    {id:'nodejs-24.15.0-x64',name:'Node.js',version:process.version.slice(1),architecture:process.arch,installType:'reused-existing-system-runtime',actualPath:path.dirname(process.execPath),executable:process.execPath,source:'https://nodejs.org/',executableSHA256:await hash(process.execPath),purpose:'Reused runtime for local Researcher Email MCP',verificationStatus:'version-probed-and-build-tested'},
  ];
  for(const record of records) {const entry={...record,verifiedAt:new Date().toISOString()};const index=data.assets.findIndex(a=>a.id===record.id);if(index>=0)data.assets[index]=entry;else data.assets.push(entry);}
  data.updatedAt=new Date().toISOString();await fs.writeFile(target+'.tmp',JSON.stringify(data,null,2)+'\n');await fs.rename(target+'.tmp',target);
  console.log(JSON.stringify({registered:records.map(r=>r.id),manifest:target}));
} else throw new Error('Use local-install.mjs codex <exe> | manifest');
