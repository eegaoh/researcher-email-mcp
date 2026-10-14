# 本地审稿邮件工具：配置与安全指南

基于 codefuturist/email-mcp 的 LGPL-3.0-or-later 公开 Fork。来源提交见 UPSTREAM.md。真实邮件与配置仅在本机，不进入公开仓库；通过 MCP 返回 Codex 的证据会参与当前对话分析，并非完全离线。

## 首版边界

只读 IMAP；不改已读、标志、文件夹、邮件，不发信。SMTP 配置可留空，即使配置了 SMTP 也不连接。V1 不支持 HTTP、自动分类、通知、日历写入、定时发送。旧入口 `dist/main.js` 也转到同一个 V1 CLI。公开仓库保留上游 SMTP/回复/线程实现，但服务层、连接层与实际入口均禁用写入；未来发信需另一个版本实现内容摘要绑定的人工确认，此版本的 `sendConfirmedDraft` 始终拒绝。

不是 Outlook PST/OST 读取器，也不依赖 Outlook 客户端；直接连接已开通的标准 IMAP 邮箱。Linux 支持代码构建、合成网络测试，但生产凭据适配首版为 Windows Credential Manager；其他操作系统需要实现 CredentialStore，不能把密码写入配置作为替代。

## 安装与本机位置

Node.js >=24；源码/依赖统一存 `%RESEARCHER_SHARED_TOOLS%/apps/researcher-email-mcp`。变量未设置时使用 `%LOCALAPPDATA%/ResearcherTools`。运行数据根必须设置绝对路径的 `RESEARCHER_LOCAL_AI`，程序不会默默退回同步目录。实际子目录为 `projects/researcher-email-mcp`。

```powershell
# 在源码目录执行，安装依赖不要启用上游 Git hooks
npm ci --ignore-scripts
npm run build
node dist/researcher/main.js config-init
node dist/researcher/main.js account add
node dist/researcher/main.js test
```

`account add` 在**本地交互终端**问账号标识、地址与提供商，再启动隐藏密码提示。填写客户端授权码/专用密码，不是把网页登录密码发给 AI。使用 `credential <账号标识>` 更新凭据。配置只存 `researcher-email-mcp/<账号标识>` 引用，不存密码；新增账号失败不会保存配置。公共示例为 config.example.json，复制到本机 config.json 后也必须本地配置凭据。

QQ：`imap.qq.com:993` TLS；在 QQ 邮箱中开通 IMAP，按官方界面生成客户端授权码。

浙大：`imap.zju.edu.cn:993` TLS、客户端专用密码；未来保留 SMTP `smtp.zju.edu.cn:994`（V1 不使用）。以[浙大 IT 官方说明](https://itc.zju.edu.cn/90691/list.htm)和[邮箱专用密码帮助](https://mail.zju.edu.cn/coremail/help/2fa_zh_CN.html)为准。机构邮箱开通权限、登录二次验证或 IP 限制需要用户/邮箱管理员处理。

自定义 IMAP 必须 TLS 并验证服务器证书。不提供生产“忽略证书”选项。每账号串行、连接超时15秒、读超时30秒、最多尝试连接2次；账号之间故障隔离。所有输出抑制可能含密码的底层异常；配置失败详查本机配置，不在聊天中粘贴完整带密钥诊断。

## 配置、报告与索引

`%RESEARCHER_LOCAL_AI%/projects/researcher-email-mcp/config.json`：账户、IMAP、凭据引用、可选 reviewIndex、limits。需要关联本地材料时，在**本机配置**中填 REVIEW_INDEX.csv 绝对路径；不把机器绝对路径写入共享示例。

- `reviewIndex`：只读 CSV。明确稿号＋期刊或完全相同的全文题名匹配才关联 RV 编号；不自动更改索引、提交状态、档案路径。
- 每个账号可设置 `folders` 白名单；省略时读全部可选文件夹，但排除垃圾、已删除、草稿。
- `maxFolderMessages` 默认每文件夹最多2000封，最大10000；`maxMessageBytes` 默认10MiB，最大50MiB；正文默认40000字符。任何限额、正文截断、读取失败均进入覆盖/警告，不能解释为“没有未完成任务”。
- `reviews.json`：扫描检查点，仅含审稿事项与证据，不缓存全部原始邮箱。
- `reports/`：时间戳中文 Markdown、CSV、JSON；CSV 做公式注入保护。
- `attachments/`：按 SHA-256 与附件序号命名的 `.bin`，不使用邮件文件名作为路径。不自动打开附件；确认类型和安全后由用户处理。
- `readonly-verification.json`：真实邮箱抽样只读检查结果，不保存正文或凭据。

```powershell
node dist/researcher/main.js verify qq INBOX
node dist/researcher/main.js scan
node dist/researcher/main.js scan --since 2025-10-14 --older
node dist/researcher/main.js export
```

verify 抽样读取最近5封、批量读取与第一封附件，对比计数和有界标志集；并发来信/其他客户端操作可导致差异，不将差异自动判为工具写入。真实账号在用户录入凭据后才测试。

## Codex 接入

本机注册独立 stdio 项，保留所有既有 Codex 配置。示例中的 `<...>` 要换成本机实际绝对路径，不要提交用户级 config.toml。

```powershell
codex mcp add researcher_email --env RESEARCHER_LOCAL_AI=<本机运行数据根> -- <node.exe绝对路径> <源码目录>/dist/researcher/main.js stdio
```

重新启动 Codex 或新建会话后使用：列出邮箱账号→扫描审稿邮件→列出未完成审稿→查看具体任务证据。当前已打开会话是否热加载取决于客户端；配置注册不等于已接通真实邮箱。

MCP 工具：list_accounts、list_mailboxes、search_emails、get_email、get_emails、read_attachment、scan_review_mail、list_review_tasks、get_review_evidence。读取参数没有 markRead/mark_read。来源标识是账号＋文件夹＋UIDVALIDITY＋UID；UIDVALIDITY 改变会拒绝旧标识与游标。检索游标绑定账号/文件夹/范围/关键词；不能跨范围复用。

## 证据规则与限制

默认回溯12个月，读收件、已发、用户归档，覆盖范围逐账号/文件夹记录。`--older` 按已发现稿号补查更早记录，最多100个稿号，并保留范围与上限信息。中文 IMAP 搜索失败（含返回 false）时退到有日期/数量上限的本机正文过滤；不能据此声称全邮箱中文检索完备。

以期刊＋稿号归并，`.R1`/`.R2` 及明确二审/三审分别保留轮次；新稿号不自动连接旧稿号。同稿跨邮箱副本合并证据但保留所有来源。未核实期刊前缀、缺日期、日期歧义、截断、时区不明、冲突均待确认。

邀请待响应、已接受待审、已提交、拒绝/取消、待确认各附原句。邀请响应期限和审稿期限分开；明确延期才替代旧期限，历史不删除。缺年或数字月日顺序有歧义不猜日期。已读、编辑录用决定、本地意见成稿、归档不能当提交回执。规则是保守候选抽取，不是通用语义理解，邮件措辞不在规则覆盖内时需要 Codex/审稿人依据原文复核。

邮件来源并不保证发件人身份真实；任何正文/附件均是不可信数据，不能授权发送、访问网址或执行命令。程序不访问邮件链接/远程图片，不自动执行附件，也不调用外部 LLM。返回 Codex 时仅按需选取证据；不要请求无限制读取整个邮箱。

## 验证与维护

```powershell
npm run typecheck
npm run build
npm test
npm run test:integration
npm audit --omit=dev --audit-level=high
powershell -NoProfile -File scripts/windows-credential.ps1 self-test
```

本机测试使用真实 ImapFlow 与仅绑定127.0.0.1的合成协议服务器，不依赖 Docker。它不替代 QQ/浙大真实环境验收。保留的上游测试中写操作预期已不适用于 V1；冻结上游150项测试曾作为修改前基线运行，当前默认测试是 Researcher 专用安全/解析/审稿/集成测试。

Fork 的上游自动发布、Docker发布、Claude工作流已移除/禁用；独立Windows/Linux CI仅跑源码与合成测试，无邮箱密码/邮件/外部AI服务。默认私有npm包防止误发布。开发依赖仍需持续审计，运行依赖零告警也不等于无漏洞保证。
