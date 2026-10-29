/**
 * 功能：提供本地笔记引用卡片、手动网页摘要卡片及粘贴链接后的可选转换。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:06:10
 */
import { Extension, mergeAttributes, Node } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { docToPlainText } from '../../core/doc';
import { isEffectivelyTrashed } from '../../core/tree';
import { displayTitle } from '../../core/model';
import { Dialog } from '../components/primitives';
import { t } from '../i18n';
import { fileUrl, storeFiles } from '../platform/attachments';
import { pickFiles } from '../platform/files';
import { openExternal } from '../platform/desktop';
import { getState } from '../workspace';
import { toast } from '../ui';
import { PageLink } from './PageLink';
import type { PageLinkOptions } from './PageLink';

/** 网页卡片仅允许浏览器可打开的HTTP地址。 */
export function bookmarkHref(value: string): string | null {
  try {
    // 规范化用户输入的地址，不自动补全或抓取远端内容。
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** 卡片表单收集的持久化属性。 */
interface BookmarkValue {
  /** 手动填写的HTTP地址。 */
  href: string;
  /** 自定义标题。 */
  title: string;
  /** 自定义摘要。 */
  description: string;
  /** 可选的本地附件封面。 */
  coverFileId: string | null;
}

/** 挂载复用项目Dialog的临时编辑界面。 */
function cardDialog(render: (close: () => void) => ReactNode): void {
  // 临时挂载点不参与编辑器文档。
  const host = document.createElement('div');
  document.body.append(host);
  // React根在关闭后移除，Dialog负责焦点和Escape。
  const root = createRoot(host);
  // 在React当前事件结束后卸载，避免同步卸载正在更新的根。
  const close = () =>
    queueMicrotask(() => {
      root.unmount();
      host.remove();
    });
  root.render(render(close));
}

/** 选择要引用的本地笔记，可附带标题或块锚点。 */
function PageCardPicker({ editor, close }: { editor: Editor; close: () => void }) {
  // 搜索关键字与可选定位锚点。
  const [query, setQuery] = useState('');
  // 锚点沿用已有页面导航语义。
  const [anchor, setAnchor] = useState('');
  // 当前可读取的页面，不包含回收站内容。
  const state = getState();
  // 标题搜索只作用于当前库。
  const pages = Object.values(state.pages).filter(
    (page) =>
      !isEffectivelyTrashed(state.pages, page.id) &&
      displayTitle(page).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Dialog title={t('editor.cards.choosePage')} onClose={close} size="small">
      <div className="reference-card-form">
        <label className="field">
          <span>{t('editor.cards.searchPages')}</span>
          <input className="text-input" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="field">
          <span>{t('editor.cards.anchor')}</span>
          <input
            className="text-input"
            value={anchor}
            onChange={(event) => setAnchor(event.target.value)}
            placeholder={t('editor.cards.anchorHelp')}
          />
        </label>
        <div className="reference-page-results">
          {pages.slice(0, 50).map((page) => (
            <button
              type="button"
              className="reference-page-result"
              key={page.id}
              onClick={() => {
                if (!editor.isDestroyed && editor.isEditable)
                  editor
                    .chain()
                    .focus()
                    .insertContent({
                      type: 'pageCard',
                      content: [
                        {
                          type: 'pageLink',
                          attrs: {
                            id: page.id,
                            label: displayTitle(page),
                            ...(anchor.trim() ? { anchor: anchor.trim().replace(/^#/, '') } : {}),
                          },
                        },
                      ],
                    })
                    .run();
                close();
              }}
            >
              <FileText size={16} />
              <span>{displayTitle(page)}</span>
            </button>
          ))}
          {!pages.length && <p className="muted">{t('editor.noPagesFound')}</p>}
        </div>
      </div>
    </Dialog>
  );
}

/** 从斜杠菜单打开本地引用卡片选择器。 */
export function openPageCardPicker(editor: Editor): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  cardDialog((close) => <PageCardPicker editor={editor} close={close} />);
}

/** 手动网页卡片的表单，不会自动联网读取标题或图片。 */
function BookmarkForm({
  initial,
  save,
  close,
}: {
  initial: BookmarkValue;
  save: (value: BookmarkValue) => void;
  close: () => void;
}) {
  // 表单草稿与上传状态在确认之前不写入文档。
  const [value, setValue] = useState(initial);
  // 地址校验仅在提交后显示。
  const [invalid, setInvalid] = useState(false);
  // 上传封面时阻止重复保存。
  const [uploading, setUploading] = useState(false);
  // 一次确认对应一次编辑器事务。
  const submit = () => {
    if (uploading) return;
    const href = bookmarkHref(value.href);
    setInvalid(!href);
    if (href) {
      save({
        ...value,
        href,
        title: value.title.trim() || new URL(href).hostname,
        description: value.description.trim(),
      });
      close();
    }
  };
  return (
    <Dialog
      title={t('editor.cards.websiteCard')}
      onClose={close}
      size="small"
      footer={
        <>
          <button type="button" className="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="button primary" disabled={uploading} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        className="reference-card-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>{t('editor.cards.address')}</span>
          <input
            type="url"
            className="text-input"
            value={value.href}
            aria-invalid={invalid}
            onChange={(event) => setValue({ ...value, href: event.target.value })}
            spellCheck={false}
          />
        </label>
        {invalid && (
          <p className="field-error" role="alert">
            {t('editor.cards.invalidAddress')}
          </p>
        )}
        <label className="field">
          <span>{t('editor.cards.title')}</span>
          <input
            className="text-input"
            value={value.title}
            maxLength={500}
            onChange={(event) => setValue({ ...value, title: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('editor.cards.description')}</span>
          <textarea
            className="text-input"
            rows={3}
            value={value.description}
            maxLength={2000}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
          />
        </label>
        <div className="reference-cover-actions">
          <button
            type="button"
            className="button small"
            disabled={uploading}
            onClick={() => {
              setUploading(true);
              void pickFiles('image/*', false)
                .then(storeFiles)
                .then((files) => {
                  if (files[0]) setValue((current) => ({ ...current, coverFileId: files[0]!.id }));
                })
                .catch(() => toast(t('editor.cards.coverFailed'), { tone: 'error' }))
                .finally(() => setUploading(false));
            }}
          >
            {uploading
              ? t('editor.cards.uploading')
              : value.coverFileId
                ? t('editor.cards.replaceCover')
                : t('editor.cards.addCover')}
          </button>
          {value.coverFileId && (
            <button
              type="button"
              className="button small"
              onClick={() => setValue({ ...value, coverFileId: null })}
            >
              {t('editor.cards.removeCover')}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

/** 打开网页卡片表单，可插入新卡片或替换指定范围。 */
export function openBookmarkEditor(
  editor: Editor,
  options: { position?: number; range?: Range; href?: string } = {},
): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  // 编辑已有节点时保留其位置与属性；新建时使用当前选择。
  const current = options.position === undefined ? null : editor.state.doc.nodeAt(options.position);
  // 已有卡片默认属性，其他节点不能误作卡片编辑。
  const attrs = current?.type.name === 'bookmark' ? current.attrs : {};
  // 表单初值只读原属性，不获取远端网页。
  const initial: BookmarkValue = {
    href: String(attrs.href ?? options.href ?? ''),
    title: String(attrs.title ?? ''),
    description: String(attrs.description ?? ''),
    coverFileId: typeof attrs.coverFileId === 'string' ? attrs.coverFileId : null,
  };
  cardDialog((close) => (
    <BookmarkForm
      initial={initial}
      close={close}
      save={(value) => {
        if (editor.isDestroyed || !editor.isEditable) return;
        if (
          options.position !== undefined &&
          editor.state.doc.nodeAt(options.position)?.type.name === 'bookmark'
        )
          editor.chain().focus().setNodeSelection(options.position).updateAttributes('bookmark', value).run();
        else if (
          options.range &&
          options.range.from >= 0 &&
          options.range.to <= editor.state.doc.content.size &&
          editor.state.doc.textBetween(options.range.from, options.range.to) === options.href
        )
          editor.chain().focus().insertContentAt(options.range, { type: 'bookmark', attrs: value }).run();
        else editor.chain().focus().insertContent({ type: 'bookmark', attrs: value }).run();
      }}
    />
  ));
}

/** 改变引用的展示方式，原页面ID、别名和锚点始终保留。 */
export function setReferenceDisplay(
  editor: Editor,
  position: number,
  display: 'inline' | 'card' | 'embed',
): void {
  // 引用卡片内部复用原有pageLink节点。
  const current = editor.state.doc.nodeAt(position);
  // 卡片的子节点或当前位置的行内链接。
  const link = current?.type.name === 'pageCard' ? current.firstChild : current;
  if (!current || link?.type.name !== 'pageLink' || !editor.isEditable) return;
  // 修改显示方式不覆盖链接的定位信息。
  const json = { type: 'pageLink', attrs: { ...link.attrs, embed: display === 'embed' ? true : null } };
  // 单独成段的引用替换整个段落，避免转换后遗留两个空段。
  const resolved = editor.state.doc.resolve(position);
  const wholeParagraph =
    current.type.name === 'pageLink' &&
    resolved.parent.type.name === 'paragraph' &&
    resolved.parent.childCount === 1;
  const replacement = wholeParagraph
    ? { from: resolved.before(), to: resolved.after() }
    : { from: position, to: position + current.nodeSize };
  if (display === 'card')
    editor
      .chain()
      .focus()
      .insertContentAt(replacement, { type: 'pageCard', content: [json] })
      .run();
  else if (current.type.name === 'pageCard')
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: position, to: position + current.nodeSize },
        { type: 'paragraph', content: [json] },
      )
      .run();
  else editor.chain().focus().setNodeSelection(position).updateAttributes('pageLink', json.attrs).run();
}

/** 本地笔记卡片：原链接仍在子节点内，供双链、导出和重命名机制读取。 */
export const PageCard = Node.create<PageLinkOptions>({
  name: 'pageCard',
  group: 'block',
  content: 'pageLink',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { ...PageLink.options };
  },
  parseHTML() {
    return [{ tag: 'div[data-page-card]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-card': '', class: 'reference-card' }), 0];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      // 当前卡片节点及其静态DOM容器。
      let current = node;
      // 主体按钮保持可访问名称与键盘激活。
      const dom = document.createElement('div');
      dom.className = 'reference-card';
      dom.contentEditable = 'false';
      // 通过按钮打开原始页面。
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'reference-card-open';
      // 可读标题、摘要和来源标记分开呈现。
      const title = document.createElement('strong');
      const summary = document.createElement('span');
      summary.className = 'reference-card-summary';
      const badge = document.createElement('span');
      badge.className = 'reference-card-badge';
      badge.textContent = t('editor.cards.localNote');
      open.append(title, summary, badge);
      dom.append(open);
      // 定位原笔记，缺失或回收站页面不自动重建。
      const resolve = () => {
        const link = current.firstChild;
        const id = typeof link?.attrs.id === 'string' ? link.attrs.id : null;
        // 已有ID的引用不能因原笔记删除而误指向同名新笔记。
        const resolved =
          id ??
          (typeof link?.attrs.target === 'string' ? this.options.resolveTarget(link.attrs.target) : null);
        const state = getState();
        return resolved &&
          this.options.getTitle(resolved) !== null &&
          state.pages[resolved] &&
          !isEffectivelyTrashed(state.pages, resolved)
          ? resolved
          : null;
      };
      // 订阅已有工作区，让改名和内容摘要自动更新。
      const refresh = () => {
        const id = resolve();
        const name = id ? this.options.getTitle(id) : null;
        title.textContent =
          name ??
          String(
            current.firstChild?.attrs.label ||
              current.firstChild?.attrs.target ||
              t('editor.cards.missingPage'),
          );
        // 回收站与加密笔记即便暂存有明文，也不能在引用卡片泄露摘要。
        const state = getState();
        const readable =
          id && state.pages[id] && !state.pages[id]!.encrypted && !isEffectivelyTrashed(state.pages, id);
        const doc = readable ? state.docs[id] : null;
        summary.textContent =
          name === null
            ? t('editor.cards.missingPage')
            : doc
              ? docToPlainText(doc).replace(/\s+/g, ' ').slice(0, 150)
              : t('editor.cards.openNote');
        dom.classList.toggle('is-missing', name === null);
        open.disabled = id === null;
      };
      open.addEventListener('click', () => {
        const id = resolve();
        if (id)
          this.options.open(
            id,
            typeof current.firstChild?.attrs.anchor === 'string' ? current.firstChild.attrs.anchor : null,
          );
      });
      // 只在编辑模式提供显示方式转换。
      if (editor.isEditable) {
        const actions = document.createElement('div');
        actions.className = 'reference-card-actions';
        for (const display of ['inline', 'embed'] as const) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'button small';
          button.textContent = display === 'inline' ? t('editor.cards.inlineLink') : t('editor.cards.embed');
          button.addEventListener('click', () => {
            const pos = typeof getPos === 'function' ? getPos() : undefined;
            if (pos !== undefined) setReferenceDisplay(editor, pos, display);
          });
          actions.append(button);
        }
        dom.append(actions);
      }
      refresh();
      // NodeView销毁时解除已有工作区订阅。
      const unsubscribe = this.options.subscribe(refresh);
      return {
        dom,
        update(updated: ProseNode) {
          if (updated.type !== current.type) return false;
          current = updated;
          refresh();
          return true;
        },
        stopEvent: (event: Event) => !event.type.startsWith('drag') && event.type !== 'drop',
        ignoreMutation: () => true,
        destroy: unsubscribe,
      };
    };
  },
});

/** 手工网页摘要卡片，不执行嵌入脚本或自动请求远端信息。 */
export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      href: { default: '' },
      title: { default: '' },
      description: { default: '' },
      coverFileId: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-bookmark]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-bookmark': '', class: 'reference-bookmark' }),
      ['a', { href: bookmarkHref(String(node.attrs.href ?? '')) ?? '' }, String(node.attrs.title ?? '')],
      ['p', {}, String(node.attrs.description ?? '')],
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      // 更新时复用同一个DOM，封面异步结果通过版本校验防止覆盖新值。
      let current = node;
      let coverVersion = 0;
      const dom = document.createElement('div');
      dom.className = 'reference-bookmark';
      dom.contentEditable = 'false';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'reference-card-open';
      const title = document.createElement('strong');
      const description = document.createElement('span');
      description.className = 'reference-card-summary';
      const source = document.createElement('span');
      source.className = 'reference-card-badge';
      const cover = document.createElement('img');
      cover.className = 'reference-bookmark-cover';
      cover.alt = '';
      cover.hidden = true;
      open.append(title, description, source);
      dom.append(open, cover);
      // 仅显式点击时使用既有外部链接打开能力。
      open.addEventListener('click', () => {
        const href = bookmarkHref(String(current.attrs.href ?? ''));
        if (href) void openExternal(href);
      });
      if (editor.isEditable) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'button small reference-bookmark-edit';
        edit.textContent = t('editor.cards.edit');
        edit.addEventListener('click', () => {
          const position = typeof getPos === 'function' ? getPos() : undefined;
          if (position !== undefined) openBookmarkEditor(editor, { position });
        });
        dom.append(edit);
      }
      // 读取已保存的本地封面，不加载任意远端图片。
      const refresh = () => {
        const href = bookmarkHref(String(current.attrs.href ?? ''));
        title.textContent = String(
          current.attrs.title || (href ? new URL(href).hostname : t('editor.cards.websiteCard')),
        );
        description.textContent = String(current.attrs.description ?? '');
        source.textContent = href ? new URL(href).hostname : t('editor.cards.invalidAddress');
        open.disabled = !href;
        const version = ++coverVersion;
        cover.hidden = true;
        if (typeof current.attrs.coverFileId === 'string')
          void fileUrl(current.attrs.coverFileId)
            .then((url) => {
              if (url && version === coverVersion) {
                cover.src = url;
                cover.hidden = false;
              }
            })
            .catch(() => {
              /* 附件失效时仍可阅读标题和摘要。 */
            });
      };
      refresh();
      return {
        dom,
        update(updated: ProseNode) {
          if (updated.type !== current.type) return false;
          current = updated;
          refresh();
          return true;
        },
        stopEvent: (event: Event) => !event.type.startsWith('drag') && event.type !== 'drop',
        ignoreMutation: () => true,
        destroy() {
          coverVersion++;
        },
      };
    };
  },
});

/** 粘贴链接时维持正常插入，只以可选操作提示转换为卡片。 */
export const ReferenceCardPaste = Extension.create({
  name: 'referenceCardPaste',
  addProseMirrorPlugins() {
    // 捕获当前编辑器，插件不干预只读或代码块中的粘贴。
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('referenceCardPaste'),
        props: {
          handlePaste(view, event) {
            if (
              !view.editable ||
              view.state.selection.$from.parent.type.name === 'codeBlock' ||
              event.clipboardData?.files.length
            )
              return false;
            const text = event.clipboardData?.getData('text/plain').trim() ?? '';
            if (!bookmarkHref(text)) return false;
            const from = view.state.selection.from;
            setTimeout(() => {
              if (
                editor.isDestroyed ||
                editor.state.doc.textBetween(
                  from,
                  Math.min(editor.state.doc.content.size, from + text.length),
                ) !== text
              )
                return;
              toast(t('editor.cards.pastedLink'), {
                action: {
                  label: t('editor.cards.convertCard'),
                  run: () =>
                    openBookmarkEditor(editor, { href: text, range: { from, to: from + text.length } }),
                },
              });
            }, 0);
            return false;
          },
        },
      }),
    ];
  },
});
