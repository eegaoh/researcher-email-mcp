import fs from 'node:fs/promises';
import path from 'node:path';
import { localRoot } from './config.js';
import type { Scan } from './reviews.js';

const md = (s: unknown) =>
  String(s ?? '').replace(/[|<>\r\n]/g, (c) =>
    c === '|' ? '\\|' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : ' ',
  );
const csv = (s: unknown) => {
  let value = String(s ?? '');
  if (/^[=+@-]/.test(value)) value = "'" + value;
  return '"' + value.replaceAll('"', '""') + '"';
};
export function markdown(scan: Scan): string {
  const lines = [
    '# 审稿邮件清单',
    '',
    `生成：${scan.generatedAt}；检索起点：${scan.since}；覆盖完整：${scan.complete ? '是（仅配置范围内）' : '否'}`,
    '',
    '此报告是规则抽取候选，邮件原文是不可信数据；报告完整不代表其他邮箱/时间范围内没有任务。已提交只依据提交回执，归档状态独立。',
    '',
    '| 期刊 | 稿号 | 轮次 | 状态 | 期限类型 | 日期 | 待确认 | 本地编号 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const task of scan.tasks)
    lines.push(
      `| ${[task.journal, task.manuscript, task.round === 0 ? '首审' : `R${task.round}`, task.status, task.deadline?.kind, task.deadline?.date ?? '未明确', task.needsConfirmation ? '是' : '否', task.localArchive?.reviewId].map(md).join(' | ')} |`,
    );
  for (const task of scan.tasks) {
    lines.push('', `## ${md(task.journal)} / ${md(task.manuscript)} / R${task.round}`, '');
    for (const e of task.evidence)
      lines.push(
        `- ${md(e.kind)}；邮件日期 ${md(e.date ?? '缺失')}；来源 \`${e.sourceId}\`：${md(e.excerpt)}`,
      );
    for (const d of task.deadlineHistory)
      lines.push(
        `- ${d.kind}历史：${md(d.raw)}；时区：${md(d.timezone ?? '未明确')}；延期：${d.extension ? '是' : '否'}`,
      );
    for (const warning of task.warnings) lines.push(`- 待确认：${md(warning)}`);
    if (task.localArchive)
      lines.push(
        `- 本地只读关联：${md(task.localArchive.reviewId)}，${md(task.localArchive.path)}，材料状态 ${md(task.localArchive.localStatus)}（不等于系统提交）。`,
      );
  }
  lines.push('', '## 覆盖与失败', '');
  for (const coverage of [...new Map(scan.coverage.map((c) => [JSON.stringify(c), c])).values()])
    lines.push(
      `- ${md(coverage.account)} / ${md(coverage.mailbox)}：UIDVALIDITY ${md(coverage.uidValidity)}；${md(coverage.since ?? '不限起点')} 至 ${md(coverage.before ?? '当前')}；${md(coverage.mode)}；上限截断 ${coverage.limited ? '是' : '否'}`,
    );
  for (const failure of scan.errors)
    lines.push(`- 失败：${md(failure.account)} / ${md(failure.mailbox)} / ${md(failure.code)}`);
  for (const skip of scan.skipped)
    lines.push(`- 跳过：${md(skip.account)} / ${md(skip.mailbox)} / ${md(skip.reason)}`);
  return lines.join('\n') + '\n';
}
export function csvReport(scan: Scan): string {
  const rows = [
    [
      'journal',
      'manuscript',
      'round',
      'status',
      'deadline_kind',
      'deadline',
      'timezone',
      'needs_confirmation',
      'review_id',
      'archive_path',
      'evidence_source_ids',
    ],
  ];
  for (const t of scan.tasks)
    rows.push([
      t.journal,
      t.manuscript,
      String(t.round),
      t.status,
      t.deadline?.kind ?? '',
      t.deadline?.date ?? '',
      t.deadline?.timezone ?? '',
      String(t.needsConfirmation),
      t.localArchive?.reviewId ?? '',
      t.localArchive?.path ?? '',
      t.sources.join(';'),
    ]);
  return '\uFEFF' + rows.map((r) => r.map(csv).join(',')).join('\r\n') + '\r\n';
}
export async function exportReport(scan: Scan): Promise<string[]> {
  const dir = path.join(localRoot(), 'reports');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputs: { ext: string; data: string }[] = [
    { ext: 'md', data: markdown(scan) },
    { ext: 'csv', data: csvReport(scan) },
    { ext: 'json', data: JSON.stringify(scan, null, 2) },
  ];
  return Promise.all(
    outputs.map(async (o) => {
      const target = path.join(dir, `${stamp}-审稿清单.${o.ext}`);
      await fs.writeFile(target, o.data, { mode: 0o600, flag: 'wx' });
      return target;
    }),
  );
}
