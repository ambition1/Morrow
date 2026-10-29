/**
 * 功能：验证图册重排保持附件信息，并且单次撤销能够恢复原顺序。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:12:08
 */
import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { appendGalleryImage, reorderGalleryImage, updateGallery } from './Gallery';

/** 最小文档结构使用真实ProseMirror事务，不依赖浏览器DOM。 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    paragraph: { group: 'block', content: 'text*' },
    text: {},
    gallery: { group: 'block', content: 'image*', attrs: { caption: { default: '' } } },
    image: { group: 'block', atom: true, attrs: { fileId: { default: null }, caption: { default: '' } } },
  },
});

/** 建立可记录写入次数和历史的编辑器接口。 */
function harness(editable = true) {
  /** 三张图片拥有不同附件标识和图注。 */
  const images = ['a', 'b', 'c'].map((fileId) =>
    schema.nodes.image!.create({ fileId, caption: `说明${fileId}` }),
  );
  /** 真实编辑器状态承担排序和undo。 */
  let state = EditorState.create({
    doc: schema.node('doc', null, [schema.node('gallery', { caption: '整组说明' }, images)]),
    plugins: [history()],
  });
  /** 每次排序只能派发一个文档事务。 */
  let dispatches = 0;
  /** 只模拟重排函数使用的编辑器边界。 */
  const editor = {
    isEditable: editable,
    schema,
    get state() {
      return state;
    },
    view: {
      dispatch(transaction: Parameters<EditorState['apply']>[0]) {
        dispatches++;
        state = state.apply(transaction);
      },
    },
  } as unknown as Editor;
  return {
    editor,
    state: () => state,
    dispatches: () => dispatches,
    undo: () =>
      undo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ids: () => state.doc.firstChild!.content.content.map((image) => image.attrs.fileId),
  };
}

describe('图册内图片重排', () => {
  it('移动图片保留其附件与图注，并能一次撤销恢复原图册', () => {
    /** 本次编辑与原始节点的快照。 */
    const result = harness();
    const original = result.state().doc.toJSON();
    reorderGalleryImage(result.editor, 0, 0, 2);
    expect(result.ids()).toEqual(['b', 'c', 'a']);
    expect(result.state().doc.firstChild!.lastChild!.attrs).toEqual({ fileId: 'a', caption: '说明a' });
    expect(result.state().doc.firstChild!.attrs.caption).toBe('整组说明');
    expect(result.dispatches()).toBe(1);
    expect(result.undo()).toBe(true);
    expect(result.state().doc.toJSON()).toEqual(original);
  });

  it('无效索引、相同位置和只读状态不改变图册', () => {
    /** 无效操作不能产生任何文档事务。 */
    const result = harness();
    for (const [from, to] of [
      [-1, 0],
      [0, 3],
      [1, 1],
    ])
      reorderGalleryImage(result.editor, 0, from!, to!);
    expect(result.ids()).toEqual(['a', 'b', 'c']);
    expect(result.dispatches()).toBe(0);
    /** 只读编辑器不能通过按钮修改排序。 */
    const readonly = harness(false);
    reorderGalleryImage(readonly.editor, 0, 0, 2);
    expect(readonly.dispatches()).toBe(0);
  });
});

describe('图册异步编辑权限', () => {
  it('布局浮层打开后转为只读，迟到的设置回调不能写入', () => {
    /** 设置回调复用真实图册节点位置。 */
    const result = harness();
    updateGallery(result.editor, () => 0, { caption: '新的说明' });
    expect(result.dispatches()).toBe(1);
    Object.assign(result.editor, { isEditable: false });
    updateGallery(result.editor, () => 0, { caption: '不允许保存' });
    expect(result.state().doc.firstChild!.attrs.caption).toBe('新的说明');
    expect(result.dispatches()).toBe(1);
  });

  it('上传开始后转为只读，上传完成不能再追加图片', async () => {
    /** 延迟一轮模拟上传完成时才执行追加回调。 */
    const result = harness();
    const completed = Promise.resolve().then(() =>
      appendGalleryImage(result.editor, () => 0, 'late', '图片.png'),
    );
    Object.assign(result.editor, { isEditable: false });
    await completed;
    expect(result.ids()).toEqual(['a', 'b', 'c']);
    expect(result.dispatches()).toBe(0);
    Object.assign(result.editor, { isEditable: true });
    appendGalleryImage(result.editor, () => 0, 'new', '图片.png');
    expect(result.ids()).toEqual(['a', 'b', 'c', 'new']);
    expect(result.dispatches()).toBe(1);
  });
});
