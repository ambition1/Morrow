import { Extension, mergeAttributes, Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { FileMeta } from '../../core/model';
import { downloadFile, fileUrl, formatBytes, storeFiles } from '../platform/attachments';
import { t } from '../i18n';
import { pickFiles } from '../platform/files';
import { GALLERY_DRAG_TYPE, insertGallery, reorderGalleryImage } from './Gallery';
import { openImageSettings, openImageViewer } from './MediaPanels';
import type { ViewerImage } from './MediaPanels';

/** 图片节点复用既有附件，新增图注、宽度和对齐，不改变旧图默认显示。 */
export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (element) => element.getAttribute('data-file-id') },
      src: { default: null, parseHTML: (element) => element.getAttribute('data-src') },
      alt: { default: '', parseHTML: (element) => element.getAttribute('alt') ?? '' },
      caption: { default: '', parseHTML: (element) => element.getAttribute('data-caption') ?? '' },
      width: { default: null, parseHTML: (element) => Number(element.getAttribute('data-width')) || null },
      align: { default: 'center', parseHTML: (element) => element.getAttribute('data-align') ?? 'center' },
    };
  },
  parseHTML() {
    return [{ tag: 'img[data-file-id]' }, { tag: 'img[data-src]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-file-id': node.attrs.fileId,
        'data-src': node.attrs.src,
        alt: node.attrs.alt,
        'data-caption': node.attrs.caption || null,
        'data-width': node.attrs.width,
        'data-align': node.attrs.align,
      }),
    ];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      /** 当前图片节点和异步读取世代。 */
      let current = node;
      let loadVersion = 0;
      /** 当前已读取的附件标识，属性修改不重复生成Blob地址。 */
      let loadedSource = '';
      /** 关闭节点持有的图片设置面板。 */
      let closePanel: (() => void) | undefined;
      /** 单图替换请求期间不重复上传。 */
      let replacing = false;
      /** 替换失败时只重试这个原文件。 */
      let failedFile: File | null = null;
      /** 图片外壳供整图选择以及图册排序定位。 */
      const dom = document.createElement('figure');
      dom.className = 'image-block media-image-block';
      dom.dataset.imageNode = '';
      dom.contentEditable = 'false';
      /** 图片本体与其加载占位。 */
      const img = document.createElement('img');
      img.draggable = false;
      /** 加载失败仍保留设置和替换入口。 */
      const placeholder = document.createElement('div');
      placeholder.className = 'media-image-placeholder';
      /** 局部操作条复用现有紧凑按钮。 */
      const toolbar = document.createElement('div');
      toolbar.className = 'image-local-toolbar';
      /** 图片说明是可编辑的独立字段，不作为alt复用。 */
      const caption = document.createElement('input');
      caption.type = 'text';
      caption.className = 'image-caption text-input';
      caption.placeholder = t('mediaBlocks.captionPlaceholder');
      caption.setAttribute('aria-label', t('mediaBlocks.imageCaption'));
      /** 返回当前图片在图册中的最新位置。 */
      const galleryPosition = () => {
        const at = getPos();
        if (at === undefined) return null;
        const position = editor.state.doc.resolve(at);
        return position.parent.type.name === 'gallery'
          ? { gallery: position.before(position.depth), index: position.index() }
          : null;
      };
      /** 安全更新仍存在的图片节点。 */
      const update = (attributes: Record<string, unknown>) => {
        const at = getPos();
        if (at === undefined || editor.isDestroyed || !editor.isEditable) return;
        const latest = editor.state.doc.nodeAt(at);
        if (latest?.type.name === 'image')
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(at, undefined, { ...latest.attrs, ...attributes }),
          );
      };
      /** 当前图片或所属图册内全部图片的放大预览。 */
      const preview = () => {
        const position = galleryPosition();
        const gallery = position ? editor.state.doc.nodeAt(position.gallery) : null;
        const images: ViewerImage[] = [];
        if (gallery) gallery.forEach((image) => images.push(image.attrs as ViewerImage));
        else images.push(current.attrs as ViewerImage);
        closePanel?.();
        closePanel = openImageViewer(images, position?.index ?? 0);
      };
      /** 创建可访问的局部按钮。 */
      const button = (label: string, action: () => void) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'button small';
        element.textContent = label;
        element.title = label;
        element.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          action();
        });
        return element;
      };
      /** 替换只追加新附件引用，原附件由既有回收机制处理。 */
      const replaceWith = async (file: File) => {
        if (replacing || !editor.isEditable) return;
        replacing = true;
        render();
        try {
          const stored = await storeFiles([file]);
          if (stored[0]) {
            update({ fileId: stored[0].id, src: null });
            failedFile = null;
          } else failedFile = file;
        } catch {
          failedFile = file;
        }
        replacing = false;
        render();
      };
      /** 拖动手柄仅对图册内图片启用。 */
      const grip = button(t('mediaBlocks.reorder'), () => {});
      grip.className = 'icon-button tiny image-sort-grip';
      grip.textContent = '⠿';
      grip.draggable = true;
      grip.addEventListener('dragstart', (event) => {
        const position = galleryPosition();
        if (!position || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        event.dataTransfer.setData(GALLERY_DRAG_TYPE, JSON.stringify(position));
        event.dataTransfer.effectAllowed = 'move';
      });
      /** 阅读和编辑模式均可主动打开大图。 */
      const zoom = button(t('mediaBlocks.preview'), preview);
      /** 修改图片说明、替代文字、宽度和对齐。 */
      const settings = button(t('mediaBlocks.imageSettings'), () => {
        closePanel?.();
        closePanel = openImageSettings(
          current.attrs,
          (values) =>
            update({ caption: values.caption, alt: values.alt, width: values.width, align: values.align }),
          [
            { label: t('mediaBlocks.replace'), run: () => replace.click() },
            ...(current.attrs.fileId
              ? [{ label: t('mediaBlocks.download'), run: () => download.click() }]
              : []),
            ...(galleryPosition()
              ? [
                  { label: t('mediaBlocks.moveBefore'), run: () => before.click() },
                  { label: t('mediaBlocks.moveAfter'), run: () => after.click() },
                ]
              : []),
            { label: t('mediaBlocks.remove'), run: () => remove.click() },
          ],
        );
      });
      /** 单张替换入口。 */
      const replace = button(t('mediaBlocks.replace'), () => {
        void pickFiles('image/*', false).then((files) => {
          if (files[0]) void replaceWith(files[0]);
        });
      });
      /** 下载继续使用已保存的原始文件。 */
      const download = button(t('mediaBlocks.download'), () => {
        if (current.attrs.fileId) void downloadFile(String(current.attrs.fileId));
      });
      /** 用键盘按钮完成与鼠标拖动等价的排序。 */
      const before = button(t('mediaBlocks.moveBefore'), () => {
        const position = galleryPosition();
        if (position) reorderGalleryImage(editor, position.gallery, position.index, position.index - 1);
      });
      const after = button(t('mediaBlocks.moveAfter'), () => {
        const position = galleryPosition();
        if (position) reorderGalleryImage(editor, position.gallery, position.index, position.index + 1);
      });
      /** 仅移除图片节点，不永久删除附件。 */
      const remove = button(t('mediaBlocks.remove'), () => {
        if (editor.isDestroyed || !editor.isEditable) return;
        const at = getPos();
        if (at === undefined) return;
        const latest = editor.state.doc.nodeAt(at);
        if (latest) editor.view.dispatch(editor.state.tr.delete(at, at + latest.nodeSize));
      });
      /** 失败时只重传未成功保存的替换文件。 */
      const retry = button(t('mediaBlocks.retry'), () => {
        if (failedFile) void replaceWith(failedFile);
      });
      /** 次要操作收纳到图片设置，避免小图工具条遮挡图片；保留原按钮供设置面板调用。 */
      for (const action of [replace, download, before, after, remove])
        action.classList.add('image-secondary-action');
      toolbar.append(grip, zoom, settings, replace, download, before, after, remove, retry);
      caption.addEventListener('blur', () => {
        if (caption.value !== String(current.attrs.caption ?? '')) update({ caption: caption.value });
      });
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
      img.addEventListener('dblclick', preview);
      img.addEventListener('click', () => {
        if (!editor.isEditable) preview();
        else {
          const at = getPos();
          if (at !== undefined)
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
        }
      });
      img.addEventListener('error', () => {
        img.hidden = true;
        placeholder.hidden = false;
        placeholder.textContent = t('mediaBlocks.missing');
      });
      dom.append(toolbar, placeholder, img, caption);
      /** 只在地址变化时重新读取图片，旧请求不覆盖更新后的节点。 */
      const loadImage = () => {
        const source = `${current.attrs.fileId ?? ''}|${current.attrs.src ?? ''}`;
        if (source === loadedSource) return;
        loadedSource = source;
        const version = ++loadVersion;
        img.hidden = true;
        placeholder.hidden = false;
        placeholder.replaceChildren();
        if (!current.attrs.fileId) {
          const src = String(current.attrs.src ?? '');
          placeholder.textContent = /^https:\/\//i.test(src)
            ? t('editor.imageFrom', { host: safeHost(src) })
            : t('mediaBlocks.missing');
          if (/^https:\/\//i.test(src))
            placeholder.append(
              button(t('editor.loadImage'), () => {
                img.src = src;
                img.hidden = false;
                placeholder.hidden = true;
              }),
            );
          return;
        }
        placeholder.textContent = t('mediaBlocks.uploading');
        void fileUrl(String(current.attrs.fileId)).then((url) => {
          if (version !== loadVersion) return;
          if (url) {
            img.src = url;
            img.hidden = false;
            placeholder.hidden = true;
          } else {
            placeholder.textContent = t('mediaBlocks.missing');
          }
        });
      };
      /** 属性更新不重建图片DOM，正在输入的说明不会被失焦覆盖。 */
      function render(): void {
        const inGallery = galleryPosition() !== null;
        dom.dataset.align = String(current.attrs.align ?? 'center');
        dom.style.width = inGallery
          ? ''
          : `${Math.max(10, Math.min(100, Number(current.attrs.width) || 100))}%`;
        dom.dataset.editable = String(editor.isEditable);
        img.alt = String(current.attrs.alt ?? '');
        if (document.activeElement !== caption) caption.value = String(current.attrs.caption ?? '');
        caption.readOnly = !editor.isEditable;
        caption.hidden = !editor.isEditable && !current.attrs.caption;
        settings.hidden = replace.hidden = remove.hidden = !editor.isEditable;
        grip.hidden = before.hidden = after.hidden = !editor.isEditable || !inGallery;
        replace.disabled = replacing;
        retry.hidden = !editor.isEditable || !failedFile;
        download.hidden = !current.attrs.fileId;
        loadImage();
      }
      render();
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          render();
          return true;
        },
        selectNode() {
          dom.classList.add('ProseMirror-selectednode');
        },
        deselectNode() {
          dom.classList.remove('ProseMirror-selectednode');
        },
        stopEvent(event) {
          return event.target instanceof HTMLElement && Boolean(event.target.closest('button,input'));
        },
        ignoreMutation: () => true,
        destroy() {
          loadVersion++;
          closePanel?.();
        },
      };
    };
  },
});

export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (element) => element.getAttribute('data-file-id') },
      name: { default: 'file', parseHTML: (element) => element.textContent ?? 'file' },
      size: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-attachment]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-file-attachment': '', 'data-file-id': node.attrs.fileId }),
      String(node.attrs.name ?? 'file'),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'file-block';
      dom.contentEditable = 'false';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = String(node.attrs.name ?? 'file');
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      // 文件类型和真实大小来自已有附件元数据，不假定PDF页数。
      const extension = /\.([a-z0-9]+)$/i.exec(String(node.attrs.name ?? ''))?.[1]?.toUpperCase() ?? '';
      meta.textContent = [extension, typeof node.attrs.size === 'number' ? formatBytes(node.attrs.size) : '']
        .filter(Boolean)
        .join(' · ');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'file-save';
      save.textContent = t('editor.saveACopy');
      save.addEventListener('click', (event) => {
        event.preventDefault();
        void downloadFile(String(node.attrs.fileId ?? ''));
      });
      dom.append(name, meta, save);
      // sound, video and pdfs play right on the page
      const kind = mediaKind(String(node.attrs.name ?? ''));
      if (!kind) return { dom };
      const shell = document.createElement('div');
      shell.className = `media-block media-${kind}`;
      shell.contentEditable = 'false';
      const player =
        kind === 'pdf'
          ? document.createElement('iframe')
          : document.createElement(kind === 'audio' ? 'audio' : 'video');
      if (player instanceof HTMLMediaElement) {
        player.controls = true;
        player.preload = 'metadata';
      } else {
        player.title = String(node.attrs.name ?? 'PDF');
      }
      dom.classList.add('is-compact');
      // 预览由用户主动打开，附件卡片保持紧凑。
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'file-save';
      preview.textContent = t('mediaBlocks.preview');
      preview.setAttribute('aria-expanded', 'false');
      player.hidden = true;
      preview.addEventListener('click', (event) => {
        event.preventDefault();
        player.hidden = !player.hidden;
        preview.setAttribute('aria-expanded', String(!player.hidden));
      });
      dom.insertBefore(preview, save);
      shell.append(player, dom);
      void fileUrl(String(node.attrs.fileId ?? '')).then((url) => {
        if (url) player.src = url;
        else shell.classList.add('is-missing');
      });
      return {
        dom: shell,
        stopEvent: (event) =>
          event.target === player ||
          (event.target instanceof HTMLElement && Boolean(event.target.closest('button'))),
        ignoreMutation: () => true,
      };
    };
  },
});

export function mediaKind(name: string): 'audio' | 'video' | 'pdf' | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'].includes(extension)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  return null;
}

function safeHost(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return 'the web';
  }
}

export function mediaNodes(files: FileMeta[]) {
  return files.map((file) =>
    file.type.startsWith('image/')
      ? { type: 'image', attrs: { fileId: file.id, alt: file.name.replace(/\.[^.]+$/, '') } }
      : { type: 'fileAttachment', attrs: { fileId: file.id, name: file.name, size: file.size } },
  );
}

// stores the files first and only then inserts blocks that point at them
export async function insertFiles(editor: Editor, files: File[], at?: number): Promise<void> {
  if (files.length > 1 && files.every((file) => file.type.startsWith('image/'))) {
    await insertGallery(editor, files, at);
    return;
  }
  const stored = await storeFiles(files);
  if (stored.length === 0 || editor.isDestroyed) return;
  const position = at ?? editor.state.selection.to;
  // the empty line after the media takes the cursor, so typing never replaces the new block
  editor
    .chain()
    .focus()
    .insertContentAt(Math.min(position, editor.state.doc.content.size), [
      ...mediaNodes(stored),
      { type: 'paragraph' },
    ])
    .run();
}

function filesFrom(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

export const FileDrop = Extension.create({
  name: 'fileDrop',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('fileDrop'),
        props: {
          handlePaste(_view: EditorView, event: ClipboardEvent) {
            const files = filesFrom(event.clipboardData);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertFiles(editor, files);
            return true;
          },
          handleDrop(view: EditorView, event: DragEvent, _slice, moved: boolean) {
            const files = filesFrom(event.dataTransfer);
            if (moved || files.length === 0) return false;
            event.preventDefault();
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertFiles(editor, files, position);
            return true;
          },
        },
      }),
    ];
  },
});
