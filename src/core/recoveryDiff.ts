/**
 * 功能：生成保留行尾的草稿差异，根据逐段选择重建 Markdown。
 * 作者：xuanli
 * 创建时间：2026-11-19 13:58:55
 */

/** 差异段可以选择服务器、本机或先服务器后本机。 */
export type RecoveryChoice = 'server' | 'local' | 'both';

/** 相邻的变动行组成一段，共同行在预览中原样保留。 */
export type RecoverySegment =
  | { kind: 'equal'; text: string }
  | { kind: 'change'; id: number; serverLine: number; localLine: number; server: string[]; local: string[] };

/** 限制比较矩阵的规模，大文档仍可选择整段或手工编辑。 */
const MAX_CELLS = 1_000_000;

/** 将文本拆成保留实际行尾的行，避免合并时添加或吞掉换行。 */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** 使用可预测的逐行比较，移除共同首尾后才分配比较矩阵。 */
export function recoveryDiff(server: string, local: string): RecoverySegment[] {
  /** 两侧的 Markdown 行。 */
  const a = lines(server);
  /** 本机草稿的 Markdown 行。 */
  const b = lines(local);
  /** 公共前缀的行数。 */
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  /** 两侧公共后缀的起点。 */
  let endA = a.length;
  /** 本机公共后缀的起点。 */
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  /** 公共前缀保留在结果中，在差异视图中只显示变动段。 */
  const result: RecoverySegment[] = [{ kind: 'equal', text: a.slice(0, start).join('') }];
  /** 当前两侧游标。 */
  let i = start;
  /** 当前本机游标。 */
  let j = start;
  /** 每行比较表的宽度。 */
  const width = endB - start + 1;
  /** 空白一侧或矩阵过大时可以直接组成一段。 */
  const matrix =
    endA > start && endB > start && (endA - start + 1) * width <= MAX_CELLS
      ? new Uint32Array((endA - start + 1) * width)
      : null;
  /** 将两侧的行号映射到矩阵索引。 */
  const at = (row: number, column: number) => (row - start) * width + column - start;
  if (matrix) {
    for (let row = endA - 1; row >= start; row--) {
      for (let column = endB - 1; column >= start; column--) {
        matrix[at(row, column)] =
          a[row] === b[column]
            ? 1 + matrix[at(row + 1, column + 1)]!
            : Math.max(matrix[at(row + 1, column)]!, matrix[at(row, column + 1)]!);
      }
    }
  }
  while (i < endA || j < endB) {
    if (matrix && i < endA && j < endB && a[i] === b[j]) {
      /** 连续相同的行组成保留段。 */
      const equalStart = i;
      while (i < endA && j < endB && a[i] === b[j]) {
        i++;
        j++;
      }
      result.push({ kind: 'equal', text: a.slice(equalStart, i).join('') });
      continue;
    }
    /** 此差异段在两侧的起点。 */
    const fromA = i;
    /** 此差异段在本机版本的起点。 */
    const fromB = j;
    if (!matrix) {
      i = endA;
      j = endB;
    } else {
      while (i < endA || j < endB) {
        if (i < endA && j < endB && a[i] === b[j]) break;
        if (i < endA && (j === endB || matrix[at(i + 1, j)]! >= matrix[at(i, j + 1)]!)) i++;
        else j++;
      }
    }
    result.push({
      kind: 'change',
      id: result.length,
      serverLine: fromA + 1,
      localLine: fromB + 1,
      server: a.slice(fromA, i),
      local: b.slice(fromB, j),
    });
  }
  result.push({ kind: 'equal', text: a.slice(endA).join('') });
  return result;
}

/** 未选择的部分以服务器内容作为预览，界面仍要求明确选择后才能提交。 */
export function mergeRecoveryDiff(
  segments: RecoverySegment[],
  choices: Partial<Record<number, RecoveryChoice>>,
): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'equal') return segment.text;
      /** 两侧文本各自保留原始行尾。 */
      const server = segment.server.join('');
      /** 本机文本可能是未以换行结束的最后一行。 */
      const local = segment.local.join('');
      if (choices[segment.id] === 'local') return local;
      if (choices[segment.id] === 'both')
        return server && local && !server.endsWith('\n') ? `${server}\n${local}` : server + local;
      return server;
    })
    .join('');
}
