# 通用审稿扫描与证据核对

本模块将本机临时脚本中的可复用流程整理为正式 CLI：标题索引、按来源读取行政证据、脱敏、规则抽取及遗漏清单。没有搬入任何真实账号、邮件、稿件清单、授权码或人工整理的真实结论。旧本机脚本保留，不覆盖私人报告。

旧临时 JSON 的格式不等同于新接口，不直接导入或覆盖；新流程重新生成独立产物。旧手工核对结果仍按原私有报告使用，不自动升级为通用规则的结论。

## 使用方法

在程序源码目录完成 `npm ci --ignore-scripts`、`npm run build`；按中文指南设置本机 `RESEARCHER_LOCAL_AI` 和凭据管理器。以下日期仅为示例，应按需要设置。

```powershell
node dist/researcher/main.js review-index --since 2026-01-01 --before 2027-01-01
# 把上一步返回的 file 填入 --index，不要传邮箱配置文件。
node dist/researcher/main.js review-evidence --index '<headers.json 的本机路径>'
# 把第二步返回的 file 填入 --evidence；此步骤只分析本机 JSON，不连接邮箱。
node dist/researcher/main.js review-audit --evidence '<evidence.json 的本机路径>'
```

所有新产物写入 `RESEARCHER_LOCAL_AI/projects/researcher-email-mcp/review-audits/` 的独立目录，不覆盖旧文件，不写入仓库。控制台仅显示路径、数量及覆盖状态，不打印邮件正文、标题或密码；退出码 1 也可能表示部分结果，先检查本机 JSON 的 errors、coverage、gaps，而不是直接解释为程序没有结果。

第一步只读取 IMAP ENVELOPE，不下载正文或附件。默认最近12个月，`--before` 为不含当天的上界。遵守账号 folders 白名单，排除垃圾箱/草稿/已删除；每个文件夹上限使用 maxFolderMessages，并逐文件夹报告截断及失败。账号失败不阻止其他账号。标题筛选是召回候选，不是完整的语义判断。

可重复使用 `--include '自定义题名片段'`、`--exclude '非审稿通知片段'`、`--exclude-folder '投稿目录'`；均为字面匹配而不是执行正则或代码。默认不硬编码某个期刊、邮箱账号或用户目录。

第二步按候选来源读取正文，仍使用只读锁、BODY.PEEK 和 UIDVALIDITY 校验。可提供 `--sources '<本机JSON路径>'`，文件内容为第一步索引内 sourceId 的 JSON 数组；这样能补读标题筛选漏掉的通知。索引外标识会被拒绝，旧 UIDVALIDITY 失效会列入错误。来源 ID 包含账号和文件夹（只是编码，不是匿名化），同样属于私有数据。

行政证据在摘要、评审意见段落前停止；移除链接、邮箱地址和常见登录提示，再限制到14000字符。截取或上游截断会显式标记，不能称为已覆盖全文。脱敏是防御措施而不是匿名化保证：题名、稿号、来源标识以及无法穷尽的敏感表述仍可能存在，所有输出必须留在本机，不可直接公开。

第三步仅依据证据生成候选 JSON、中文 Markdown、CSV，并记录未识别邮件 gaps。已提交只接受明确回执；本地归档/编辑决定不是提交。首审与 R1/R2 分开，复审具体轮次不明须确认；延期申请不视为获批，作者修回期限不作为审稿期限。缺日期/时区、日期冲突或不支持的措辞仍需人工核对，不复制某次真实审稿的手工结论。缺年或相对期限暂不自动推算，保留原文供核实。

## 发布前检查

```powershell
npm run typecheck
npm run lint
npm run build
npm test
npm run privacy:check
# 只暂存逐个审核过的源码、合成测试和文档后，再检查将要提交的实际内容：
node scripts/check-publication.mjs --staged
```

检查器不联网、不上传文件，仅输出问题路径与类别；扫描邮件地址、私人路径、常见令牌、编码来源标识及禁止的数据文件。默认检查受管理的 Researcher 源码/脚本/合成示例；`--staged` 检查整个暂存变更，`--base <提交>` 检查相对基线的已提交变化。检测是启发式，不能代替人工逐文件检查。真实配置、JSON、报告、原始邮件、附件以及日志不得加入公开提交。

## 分支与合并

`codex/local-review-tool` 是隔离开发的分支，`main` 是默认主线；PR 是将开发变化审核后并入主线的请求。分支并非重复安装程序，也不强制必须合并；当这一版准备成为默认版本时，应在隐私检查和 Windows/Linux 合成 CI 通过后合并。正常 merge 保留提交历史；本机用 `git switch main` 加 `git pull --ff-only` 对齐，不能用强制覆盖丢弃本地修改。即使合并，旧私人数据和凭据仍只在本机。
