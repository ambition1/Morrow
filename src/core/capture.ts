/**
 * 功能：组合快速记录正文与附件，复用普通笔记节点并保持任务语义。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:45:07
 */
import type { DocNode, FileMeta } from './model';

/** 在已有正文之后追加一次记录，不修改原文档对象。 */
export function appendCapture(doc: DocNode, text: string, files: FileMeta[], time: string): DocNode {
  /** 空白输入可以只插入图片或附件。 */
  const clean = text.trim();
  /** 每段沿用任务标记；仅首段普通文字显示记录时间。 */
  const blocks: DocNode[] = clean
    ? clean.split(/\n{2,}/).map((part, index) => {
        /** 任务只在段首识别，普通文字中的方括号保持原样。 */
        const task = /^\[( |x)\]\s*/i.exec(part);
        /** 每个单独换行保留为软换行。 */
        const body = task ? part.slice(task[0].length) : part;
        /** 现有编辑器理解的行内节点。 */
        const lines: DocNode[] = body
          .split('\n')
          .flatMap((line, lineIndex) => [
            ...(lineIndex ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ]);
        /** 第一段正文的时间只记录一次。 */
        const content =
          index === 0 && !task
            ? [{ type: 'text', text: `${time} `, marks: [{ type: 'bold' }] }, ...lines]
            : lines;
        return task
          ? {
              type: 'taskList',
              content: [
                {
                  type: 'taskItem',
                  attrs: { checked: task[1] !== ' ' },
                  content: [{ type: 'paragraph', content }],
                },
              ],
            }
          : { type: 'paragraph', content };
      })
    : [];
  /** 所有文件都沿用已有附件ID，图片直接作为图片节点。 */
  const attachments: DocNode[] = files.map((file) =>
    file.type.startsWith('image/')
      ? { type: 'image', attrs: { fileId: file.id, alt: file.name } }
      : { type: 'fileAttachment', attrs: { fileId: file.id, name: file.name, size: file.size } },
  );
  /** 仅去掉初始化时的单个空段落，不删除用户有意保留的空行。 */
  const existing = (doc.content ?? []).filter(
    (node, _index, all) => !(all.length === 1 && node.type === 'paragraph' && !node.content?.length),
  );
  return { ...doc, content: [...existing, ...blocks, ...attachments] };
}
