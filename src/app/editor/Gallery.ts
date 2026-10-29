/**
 * 功能：图册节点、布局管理与可重试的图片上传队列。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:07:51
 */
import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { pickFiles } from '../platform/files';
import { storeFiles } from '../platform/attachments';
import { t } from '../i18n';
import { openGallerySettings } from './MediaPanels';
import type { MediaAttributes } from './MediaPanels';

/** 图册内图片拖动使用独立格式，避免和编辑器整块拖动混淆。 */
export const GALLERY_DRAG_TYPE = 'application/x-morrow-gallery-image';
/** 将已选文件交给新图册视图的本地事件，不保存到文档。 */
const ADD_FILES_EVENT = 'morrow:gallery-add-files';

/** 更新仍存在的图册属性，保留其全部图片内容。 */
export function updateGallery(
  editor: Editor,
  position: () => number | undefined,
  attributes: MediaAttributes,
): void {
  /** 节点可能在文件选择期间被用户移除。 */
  const at = position();
  if (at === undefined || editor.isDestroyed || !editor.isEditable) return;
  /** 只更新调用方所持有的图册。 */
  const node = editor.state.doc.nodeAt(at);
  if (node?.type.name !== 'gallery') return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...attributes }));
}

/** 上传完成后只向仍可编辑的原图册追加图片，权限变化时不再写入。 */
export function appendGalleryImage(
  editor: Editor,
  position: () => number | undefined,
  fileId: string,
  name: string,
): void {
  /** 异步上传不能沿用启动时的编辑权限。 */
  const at = position();
  if (at === undefined || editor.isDestroyed || !editor.isEditable) return;
  /** 图册可能已在上传期间被删除或替换。 */
  const latest = editor.state.doc.nodeAt(at);
  if (latest?.type.name !== 'gallery') return;
  /** 附件标识与图片名称沿用原有结构。 */
  const image = editor.schema.nodes.image?.create({ fileId, alt: name.replace(/\.[^.]+$/, '') });
  if (image) editor.view.dispatch(editor.state.tr.insert(at + latest.nodeSize - 1, image));
}

/** 移动图册内的单张图片；整个排序是一个可撤销事务。 */
export function reorderGalleryImage(editor: Editor, galleryPosition: number, from: number, to: number): void {
  /** 当前图册及图片列表必须仍然存在。 */
  const gallery = editor.state.doc.nodeAt(galleryPosition);
  if (!editor.isEditable || gallery?.type.name !== 'gallery') return;
  /** 有效索引之外的拖动不改变文档。 */
  if (from === to || from < 0 || to < 0 || from >= gallery.childCount || to >= gallery.childCount) return;
  /** 原图片节点被复用，不重新上传附件。 */
  const images: ProseNode[] = [];
  gallery.forEach((image) => images.push(image));
  /** 被移动的原节点。 */
  const image = images.splice(from, 1)[0]!;
  images.splice(to, 0, image);
  editor.view.dispatch(
    editor.state.tr.replaceWith(
      galleryPosition + 1,
      galleryPosition + gallery.nodeSize - 1,
      Fragment.fromArray(images),
    ),
  );
}

/** 新图册先插入正文，再由其视图处理上传、失败重试及用户后续编辑。 */
export async function insertGallery(editor: Editor, files: File[], at?: number): Promise<void> {
  if (editor.isDestroyed || !editor.isEditable || !editor.schema.nodes.gallery) return;
  /** 使用独立节点实例定位本次插入，不查询全局最后一张图。 */
  const gallery = editor.schema.nodes.gallery.create();
  /** 可选拖放位置必须限制在当前文档中。 */
  const transaction = editor.state.tr;
  if (at !== undefined)
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(Math.max(0, Math.min(at, transaction.doc.content.size)))),
    );
  transaction.replaceSelectionWith(gallery);
  /** 当前新节点在拟提交文档中的真实位置。 */
  let position: number | undefined;
  transaction.doc.descendants((node, offset) => {
    if (node === gallery) position = offset;
  });
  if (position === undefined) return;
  /** 图册后保留空段落，让连续输入不替换新图册。 */
  const paragraph = editor.schema.nodes.paragraph?.create();
  if (paragraph) transaction.insert(position + gallery.nodeSize, paragraph);
  transaction.setSelection(NodeSelection.create(transaction.doc, position));
  editor.view.dispatch(transaction);
  /** 当前节点视图同步挂载，事件只发送给本次新图册。 */
  const element = editor.view.nodeDOM(position);
  if (element instanceof HTMLElement && files.length)
    element.dispatchEvent(new CustomEvent(ADD_FILES_EVENT, { detail: files }));
  editor.view.focus();
}

/** 图册保留原image子节点，使附件扫描、历史与备份沿用既有遍历。 */
export const Gallery = Node.create({
  name: 'gallery',
  group: 'block',
  content: 'image*',
  defining: true,
  isolating: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      layout: { default: 'grid', parseHTML: (element) => element.getAttribute('data-layout') ?? 'grid' },
      columns: { default: 3, parseHTML: (element) => Number(element.getAttribute('data-columns')) || 3 },
      gap: { default: 'normal', parseHTML: (element) => element.getAttribute('data-gap') ?? 'normal' },
      originalRatio: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-original-ratio') === 'true',
      },
      caption: { default: '', parseHTML: (element) => element.getAttribute('data-caption') ?? '' },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-gallery]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-gallery': '',
        'data-layout': node.attrs.layout,
        'data-columns': node.attrs.columns,
        'data-gap': node.attrs.gap,
        'data-original-ratio': node.attrs.originalRatio,
        'data-caption': node.attrs.caption,
      }),
      0,
    ];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      /** 当前图册节点随编辑事务更新，DOM外壳保持稳定。 */
      let current = node;
      /** 正在上传时仍可修改图册布局。 */
      let uploading = false;
      /** 上传失败的原文件只在此视图内保留，以便单独重试。 */
      let failed: File[] = [];
      /** 已排队但尚未上传的文件。 */
      let pending: File[] = [];
      /** 轮播位置不写入文档，不产生无意义历史。 */
      let active = 0;
      /** 节点销毁后不再追加图片或更新DOM。 */
      let destroyed = false;
      /** 当前打开的布局浮层关闭器。 */
      let closePanel: (() => void) | undefined;
      /** 视图更新后等待ProseMirror挂载子图片。 */
      let frame = 0;
      /** 整组图册容器及内容插槽。 */
      const dom = document.createElement('section');
      dom.className = 'gallery-block';
      dom.dataset.gallery = '';
      /** 只有内容插槽交给ProseMirror管理。 */
      const contentDOM = document.createElement('div');
      contentDOM.className = 'gallery-content';
      /** 标题与操作栏不属于可编辑正文。 */
      const toolbar = document.createElement('div');
      toolbar.className = 'gallery-toolbar';
      toolbar.contentEditable = 'false';
      /** 图册张数以当前文档数据计算。 */
      const title = document.createElement('strong');
      /** 操作控件全部使用项目已有按钮样式。 */
      const actions = document.createElement('div');
      actions.className = 'gallery-actions';
      toolbar.append(title, actions);
      /** 创建不触发编辑器输入的图册按钮。 */
      const button = (label: string, action: (event: MouseEvent) => void) => {
        /** 按钮在手机和键盘聚焦时也可使用。 */
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'button small';
        item.textContent = label;
        item.addEventListener('click', (event) => {
          event.preventDefault();
          action(event);
        });
        return item;
      };
      /** 布局入口复用Popover、Select和Switch。 */
      const settings = button(t('mediaBlocks.gallerySettings'), () => {
        closePanel?.();
        closePanel = openGallerySettings(settings, current.attrs, (patch) =>
          updateGallery(editor, getPos, patch),
        );
      });
      /** 添加按钮打开既有本地文件选择器。 */
      const add = button(t('mediaBlocks.addPhotos'), () => {
        void pickFiles('image/*', true).then(queueFiles);
      });
      actions.append(settings, add);
      /** 轮播控制始终是显式操作，不自动播放。 */
      const navigation = document.createElement('div');
      navigation.className = 'gallery-navigation';
      navigation.contentEditable = 'false';
      /** 轮播上一张。 */
      const previous = button(t('mediaBlocks.previous'), () => {
        active = Math.max(0, active - 1);
        render();
      });
      /** 当前轮播序号。 */
      const count = document.createElement('span');
      /** 轮播下一张。 */
      const next = button(t('mediaBlocks.next'), () => {
        active = Math.min(current.childCount - 1, active + 1);
        render();
      });
      navigation.append(previous, count, next);
      /** 空图册和拖放区域复用同一添加入口。 */
      const empty = button(t('mediaBlocks.emptyGallery'), () => {
        void pickFiles('image/*', true).then(queueFiles);
      });
      empty.className = 'gallery-add-zone';
      empty.contentEditable = 'false';
      /** 整组说明独立于单张图片说明。 */
      const caption = document.createElement('input');
      caption.className = 'gallery-caption text-input';
      caption.type = 'text';
      caption.placeholder = t('mediaBlocks.galleryCaptionPlaceholder');
      caption.setAttribute('aria-label', t('mediaBlocks.galleryCaption'));
      /** 图片上传状态及错误重试区。 */
      const status = document.createElement('div');
      status.className = 'gallery-upload-status';
      status.contentEditable = 'false';
      status.setAttribute('role', 'status');
      /** 重试只重新上传失败列表，不重复追加成功项。 */
      const retry = button(t('mediaBlocks.retry'), () => {
        const files = failed;
        failed = [];
        queueFiles(files);
      });
      /** 说明失焦时提交一次，Escape还原后失焦不写入。 */
      const commitCaption = () => {
        if (caption.value !== String(current.attrs.caption ?? ''))
          updateGallery(editor, getPos, { caption: caption.value });
      };
      caption.addEventListener('blur', commitCaption);
      caption.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
          caption.value = String(current.attrs.caption ?? '');
          caption.blur();
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          caption.blur();
        }
      });
      dom.append(toolbar, contentDOM, navigation, caption, empty, status);

      /** 按上传结果追加当前图册末尾，保留期间发生的其他编辑。 */
      const append = (fileId: string, name: string) => {
        if (!destroyed) appendGalleryImage(editor, getPos, fileId, name);
      };
      /** 顺序处理文件，失败项目留下重试入口。 */
      async function uploadPending(): Promise<void> {
        if (uploading || destroyed) return;
        uploading = true;
        render();
        while (pending.length && !destroyed) {
          /** 本次待保存的原文件。 */
          const file = pending.shift()!;
          try {
            /** 单文件保存避免一项失败导致成功项重复提交。 */
            const stored = await storeFiles([file]);
            if (stored[0]) append(stored[0].id, stored[0].name);
            else failed.push(file);
          } catch {
            failed.push(file);
          }
          render();
        }
        uploading = false;
        render();
      }
      /** 只接收图片，并在已有上传后继续排队。 */
      function queueFiles(files: File[]): void {
        if (!editor.isEditable || destroyed) return;
        pending.push(
          ...files.filter(
            (file) =>
              file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$/i.test(file.name),
          ),
        );
        void uploadPending();
      }
      /** 更新布局和控件状态，但不替换ProseMirror的内容插槽。 */
      function render(): void {
        if (destroyed) return;
        /** 不合法或缺失的属性回退为标准网格。 */
        const layout = ['grid', 'masonry', 'carousel'].includes(String(current.attrs.layout))
          ? String(current.attrs.layout)
          : 'grid';
        dom.dataset.layout = layout;
        dom.dataset.gap = String(current.attrs.gap ?? 'normal');
        dom.dataset.originalRatio = String(current.attrs.originalRatio === true);
        dom.dataset.editable = String(editor.isEditable);
        dom.style.setProperty(
          '--gallery-columns',
          String([2, 3, 4].includes(Number(current.attrs.columns)) ? Number(current.attrs.columns) : 3),
        );
        title.textContent = `${t('mediaBlocks.gallery')} · ${t('mediaBlocks.photos', { count: current.childCount })}`;
        actions.hidden = !editor.isEditable;
        empty.hidden = !editor.isEditable;
        empty.textContent = current.childCount
          ? `＋ ${t('mediaBlocks.addPhotos')}`
          : t('mediaBlocks.emptyGallery');
        caption.readOnly = !editor.isEditable;
        caption.hidden = !editor.isEditable && !current.attrs.caption;
        if (document.activeElement !== caption) caption.value = String(current.attrs.caption ?? '');
        active = Math.max(0, Math.min(active, current.childCount - 1));
        navigation.hidden = layout !== 'carousel' || current.childCount < 2;
        previous.disabled = active === 0;
        next.disabled = active >= current.childCount - 1;
        count.textContent = t('mediaBlocks.countOf', {
          index: current.childCount ? active + 1 : 0,
          count: current.childCount,
        });
        status.replaceChildren();
        if (uploading) status.textContent = t('mediaBlocks.uploading');
        else if (failed.length) {
          status.textContent = t('mediaBlocks.uploadFailed');
          status.append(retry);
        }
        status.hidden = !uploading && failed.length === 0;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          Array.from(contentDOM.children).forEach((child, index) => {
            if (child instanceof HTMLElement) child.hidden = layout === 'carousel' && index !== active;
          });
        });
      }
      /** 只有本图册的新增事件会加入队列。 */
      const onAdd = (event: Event) => queueFiles((event as CustomEvent<File[]>).detail ?? []);
      dom.addEventListener(ADD_FILES_EVENT, onAdd);
      /** 已有图册内拖入图片直接追加，不让外层FileDrop再次处理。 */
      dom.addEventListener('dragover', (event) => {
        if (
          !editor.isEditable ||
          (!event.dataTransfer?.types.includes('Files') &&
            !event.dataTransfer?.types.includes(GALLERY_DRAG_TYPE))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
      });
      /** 图册内单图拖动和外部文件拖入分开处理。 */
      dom.addEventListener('drop', (event) => {
        if (!editor.isEditable) return;
        /** 单图排序只接受同一图册的源索引。 */
        const encoded = event.dataTransfer?.getData(GALLERY_DRAG_TYPE);
        if (encoded) {
          event.preventDefault();
          event.stopPropagation();
          try {
            /** 拖动数据不是文档内容，异常内容直接忽略。 */
            const source = JSON.parse(encoded) as { gallery: number; index: number };
            /** 当前拖放目标是某个图片节点。 */
            const figure = (event.target as HTMLElement).closest<HTMLElement>('[data-image-node]');
            const at = getPos();
            if (figure && at !== undefined && source.gallery === at) {
              /** 只统计当前图册的图片外壳，忽略光标等编辑器装饰。 */
              const targetIndex = Array.from(
                contentDOM.querySelectorAll(':scope > [data-image-node]'),
              ).indexOf(figure);
              if (targetIndex >= 0) reorderGalleryImage(editor, at, source.index, targetIndex);
            }
          } catch {
            /* 无效拖动数据不改变图册。 */
          }
          return;
        }
        /** 外部文件属于当前图册，结束冒泡避免重复插入。 */
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) {
          event.preventDefault();
          event.stopPropagation();
          queueFiles(files);
        }
      });
      render();
      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          render();
          return true;
        },
        stopEvent(event) {
          return (
            event.target instanceof HTMLElement &&
            Boolean(event.target.closest('button,input,select,.gallery-upload-status'))
          );
        },
        ignoreMutation(mutation) {
          return (
            mutation.type !== 'selection' &&
            (mutation.type === 'attributes' || !contentDOM.contains(mutation.target))
          );
        },
        destroy() {
          destroyed = true;
          pending = [];
          cancelAnimationFrame(frame);
          closePanel?.();
          dom.removeEventListener(ADD_FILES_EVENT, onAdd);
        },
      };
    };
  },
});
