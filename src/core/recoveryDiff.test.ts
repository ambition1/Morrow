/**
 * 功能：验证草稿差异的分段、组合和原文恢复。
 * 作者：xuanli
 * 创建时间：2026-11-19 14:03:21
 */
import { describe, expect, it } from 'vitest';
import { mergeRecoveryDiff, recoveryDiff } from './recoveryDiff';

describe('草稿正文差异', () => {
  it('独立选择不相邻的差异，保留其间的共同行', () => {
    /** 两个修改点由相同段落分开。 */
    const segments = recoveryDiff('服务器 A\n共同段\n服务器 B\n', '草稿 A\n共同段\n草稿 B\n');
    /** 筛出可独立选择的两组。 */
    const changes = segments.filter((segment) => segment.kind === 'change');
    expect(changes).toHaveLength(2);
    expect(changes.map(({ serverLine }) => serverLine)).toEqual([1, 3]);
    expect(mergeRecoveryDiff(segments, { [changes[0]!.id]: 'server', [changes[1]!.id]: 'local' })).toBe(
      '服务器 A\n共同段\n草稿 B\n',
    );
  });

  it.each([
    ['', '新增'],
    ['删除\n', ''],
    ['标题\n\n尾行', '标题\n\n草稿\n'],
    ['重复\n同文\n重复\n', '同文\n不同\n重复\n'],
    ['甲\n'.repeat(1100), '乙\n'.repeat(1100)],
  ])('完整选择任一侧都重建原文并保留行尾', (server, local) => {
    /** 新增、删除、重复或大文件都必须能完整还原。 */
    const segments = recoveryDiff(server, local);
    /** 把每一处差异选择为本机来源。 */
    const choices = Object.fromEntries(
      segments.filter((segment) => segment.kind === 'change').map(({ id }) => [id, 'local' as const]),
    );
    expect(mergeRecoveryDiff(segments, {})).toBe(server);
    expect(mergeRecoveryDiff(segments, choices)).toBe(local);
  });

  it('保留两段时不会把无行尾的服务器最后一行粘到本机正文', () => {
    /** 同一末行的两个版本都没有换行。 */
    const segments = recoveryDiff('旧末行', '新末行');
    /** 找到唯一需要选择的末行。 */
    const change = segments.find((segment) => segment.kind === 'change')!;
    expect(mergeRecoveryDiff(segments, { [change.id]: 'both' })).toBe('旧末行\n新末行');
  });
});
