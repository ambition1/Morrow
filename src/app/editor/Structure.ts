import { Extension, mergeAttributes, Node } from '@tiptap/core';
import type { NodeViewRenderer } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { normalizeWidths } from '../../core/blockAppearance';
import { applyBlockAppearance, blockAppearanceAttributes } from './BlockAppearance';
import type { Editor } from '@tiptap/core';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { CalendarDays, FileText } from 'lucide-react';
import { dateKey, parseDateKey } from '../../core/daily';
import type { MenuItem } from './SuggestionMenu';
import { renderSuggestion } from './SuggestionMenu';
import { dateLocale, t } from '../i18n';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      setColumns: (count: number) => ReturnType;
    };
  }
}

// side by side blocks, each column holds any blocks
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,4}',
  defining: true,
  isolating: true,

  // 宽度和间距为可选属性，旧文档仍默认等分。
  addAttributes() {
    return {
      widths: {
        default: null,
        parseHTML: (element) => {
          try {
            return normalizeWidths(JSON.parse(element.getAttribute('data-column-widths') ?? 'null'));
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => (attrs.widths ? { 'data-column-widths': JSON.stringify(attrs.widths) } : {}),
      },
      gap: {
        default: null,
        parseHTML: (element) =>
          ['compact', 'wide'].includes(element.getAttribute('data-column-gap') ?? '')
            ? element.getAttribute('data-column-gap')
            : null,
        renderHTML: (attrs) => (attrs.gap ? { 'data-column-gap': attrs.gap } : {}),
      },
    };
  },

  addNodeView() {
    return columnsNodeView();
  },

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-columns': '',
        class: 'columns',
        style: `--columns: ${node.childCount};--column-template:${(normalizeWidths(node.attrs.widths, node.childCount) ?? Array.from({ length: node.childCount }, () => 1)).map((width) => `minmax(0,${width}fr)`).join(' ')}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count) =>
        ({ chain, state }) => {
          const start = state.selection.from;
          return (
            chain()
              .insertContent({
                type: 'columns',
                content: Array.from({ length: Math.min(4, Math.max(2, count)) }, () => ({
                  type: 'column',
                  content: [{ type: 'paragraph' }],
                })),
              })
              // typing carries on in the first column
              .command(({ tr }) => {
                let target: number | null = null;
                tr.doc.nodesBetween(Math.max(0, start - 2), tr.doc.content.size, (node, pos) => {
                  if (target !== null) return false;
                  if (node.type.name === 'column') {
                    target = pos + 2;
                    return false;
                  }
                  return true;
                });
                if (target !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
                return true;
              })
              .run()
          );
        },
    };
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  // 栏背景与边框复用提示块的受限外观属性。
  addAttributes() {
    return blockAppearanceAttributes();
  },

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'column' }), 0];
  },
});

/** 为现有步骤列表和折叠块增加可选属性，不替换原有节点类型。 */
export const ContentAppearance = Extension.create({
  name: 'contentAppearance',
  addGlobalAttributes() {
    return [
      { types: ['details'], attributes: blockAppearanceAttributes() },
      {
        types: ['orderedList'],
        attributes: {
          presentation: {
            default: null,
            parseHTML: (element) => (element.getAttribute('data-presentation') === 'steps' ? 'steps' : null),
            renderHTML: (attrs) => (attrs.presentation === 'steps' ? { 'data-presentation': 'steps' } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          /** 第三方折叠NodeView仅刷新展开状态，因此单独同步其外观。 */
          const sync = () =>
            view.state.doc.descendants((node, pos) => {
              if (node.type.name === 'details') {
                /** 折叠节点实际的外层DOM。 */
                const element = view.nodeDOM(pos);
                if (element instanceof HTMLElement) applyBlockAppearance(element, node.attrs);
              }
            });
          sync();
          return {
            update: (next, previous) => {
              if (next.state.doc !== previous.doc) sync();
            },
          };
        },
      }),
    ];
  },
});

/** 分栏视图在本地预览拖动，仅结束拖动时提交一个可撤销事务。 */
function columnsNodeView(): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    /** 当前分栏节点。 */
    let current = node;
    /** 分栏外壳，工具手柄不进入正文内容。 */
    const dom = document.createElement('div');
    dom.className = 'columns';
    dom.dataset.columns = '';
    /** 仅供ProseMirror管理各栏内容的容器。 */
    const content = document.createElement('div');
    content.className = 'columns-content';
    /** 浮在分栏间隙中的可访问分隔手柄。 */
    const controls = document.createElement('div');
    controls.className = 'column-resizers';
    controls.contentEditable = 'false';
    dom.append(content, controls);
    /** 正在拖动时的临时清理方法。 */
    let cancelDrag: (() => void) | null = null;
    /** 当前布局的规范化宽度。 */
    const widths = () =>
      normalizeWidths(current.attrs.widths, current.childCount) ??
      Array.from({ length: current.childCount }, () => 100 / current.childCount);
    /** 只更新CSS预览，不写入持久化数据。 */
    const preview = (values: number[]) =>
      content.style.setProperty('--column-template', values.map((value) => `minmax(0,${value}fr)`).join(' '));
    /** 将分隔手柄放在实际两栏之间，包含当前间距。 */
    const place = () => {
      /** 实际显示的各栏。 */
      const columns = Array.from(content.children).filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
      /** 内容容器的起点。 */
      const box = content.getBoundingClientRect();
      Array.from(controls.children).forEach((element, index) => {
        /** 当前栏和下一栏之间的真实横向中心。 */
        const left = columns[index]?.getBoundingClientRect();
        /** 下一栏的起点。 */
        const right = columns[index + 1]?.getBoundingClientRect();
        if (element instanceof HTMLElement && left && right)
          element.style.left = `${(left.right + right.left) / 2 - box.left}px`;
      });
    };
    /** 提交分栏宽度，保留栏内容与其他布局设置。 */
    const commit = (values: number[]) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      /** 当前节点文档位置。 */
      const pos = getPos();
      if (pos === undefined) return;
      /** 当前文档节点。 */
      const latest = editor.state.doc.nodeAt(pos);
      if (latest?.type.name !== 'columns') return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, undefined, { ...latest.attrs, widths: values }),
      );
    };
    /** 根据当前栏数重新建立拖动与键盘分隔手柄。 */
    const rebuild = () => {
      controls.replaceChildren();
      if (!editor.isEditable) return;
      for (let index = 0; index < current.childCount - 1; index++) {
        /** 当前分隔线对应的左栏序号。 */
        const at = index;
        /** 原生按钮允许键盘直接操作分隔线。 */
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'column-resizer';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', t('editorBlocks.resizeColumn', { number: at + 1 }));
        handle.title = t('editorBlocks.resizeHelp');
        handle.textContent = '⋮';
        handle.addEventListener('keydown', (event) => {
          if (!editor.isEditable) return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          /** 键盘调整前的全部比例。 */
          const values = widths();
          /** 相邻两栏的可分配总量。 */
          const pair = values[at]! + values[at + 1]!;
          /** 每次键盘调整使用整体百分之二，且保留最小可读比例。 */
          const next = Math.min(pair - 10, Math.max(10, values[at]! + (event.key === 'ArrowLeft' ? -2 : 2)));
          values[at] = next;
          values[at + 1] = pair - next;
          commit(values);
        });
        handle.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || !editor.isEditable) return;
          event.preventDefault();
          cancelDrag?.();
          /** 本次拖动的起点。 */
          const start = event.clientX;
          /** 初始分栏比例，用于取消与计算。 */
          const initial = widths();
          /** 实际内容宽度。 */
          const available = content.getBoundingClientRect().width;
          /** 相邻两栏共享的比例总量。 */
          const pair = initial[at]! + initial[at + 1]!;
          /** 当前临时拖动比例。 */
          let pending = [...initial];
          /** 释放事件监听并恢复拖动状态。 */
          const cleanup = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', cancel);
            window.removeEventListener('keydown', key, true);
            window.removeEventListener('blur', cancel);
            dom.classList.remove('is-resizing');
            cancelDrag = null;
          };
          /** 指针移动仅预览宽度。 */
          const move = (next: PointerEvent) => {
            /** 保证最窄栏仍有可读宽度。 */
            const minimum = Math.min(pair / 2, Math.max(10, 10000 / Math.max(1, available)));
            /** 左栏的下一比例。 */
            const left = Math.max(
              minimum,
              Math.min(
                pair - minimum,
                initial[at]! + ((next.clientX - start) / Math.max(1, available)) * 100,
              ),
            );
            pending = [...initial];
            pending[at] = left;
            pending[at + 1] = pair - left;
            preview(pending);
            place();
          };
          /** 拖动结束后只提交一次。 */
          const end = () => {
            cleanup();
            if (pending.some((value, part) => Math.abs(value - initial[part]!) > 0.01)) commit(pending);
            else preview(initial);
          };
          /** 取消时完全恢复原始宽度。 */
          const cancel = () => {
            cleanup();
            preview(initial);
            place();
          };
          /** Escape允许取消尚未提交的拖动。 */
          const key = (next: KeyboardEvent) => {
            if (next.key === 'Escape') {
              next.preventDefault();
              next.stopPropagation();
              cancel();
            }
          };
          cancelDrag = cancel;
          dom.classList.add('is-resizing');
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', end, { once: true });
          window.addEventListener('pointercancel', cancel, { once: true });
          window.addEventListener('keydown', key, true);
          window.addEventListener('blur', cancel, { once: true });
        });
        controls.append(handle);
      }
    };
    /** 同步持久化外观与手柄的可访问范围。 */
    const sync = () => {
      dom.dataset.columnGap = String(current.attrs.gap ?? 'normal');
      dom.style.setProperty('--columns', String(current.childCount));
      preview(widths());
      if (controls.childElementCount !== (editor.isEditable ? current.childCount - 1 : 0)) rebuild();
      Array.from(controls.children).forEach((handle, index) => {
        handle.setAttribute('aria-valuemin', '10');
        handle.setAttribute('aria-valuemax', '90');
        handle.setAttribute('aria-valuenow', String(Math.round(widths()[index]!)));
      });
      requestAnimationFrame(place);
    };
    /** 视口、侧栏与字体变化时重新定位分隔线。 */
    const observer = new ResizeObserver(place);
    observer.observe(content);
    sync();
    return {
      dom,
      contentDOM: content,
      update(updated) {
        if (updated.type !== current.type) return false;
        current = updated;
        if (!cancelDrag) sync();
        return true;
      },
      stopEvent: (event) => controls.contains(event.target as globalThis.Node),
      ignoreMutation: (mutation) =>
        controls.contains(mutation.target) ||
        (mutation.type === 'attributes' && (mutation.target === dom || mutation.target === content)),
      destroy() {
        cancelDrag?.();
        observer.disconnect();
      },
    };
  };
}

// a live list of the page's headings, each one jumps to its section
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-toc': '', class: 'toc' })];
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement('nav');
      dom.className = 'toc';
      dom.contentEditable = 'false';
      dom.setAttribute('aria-label', t('slash.items.toc.title'));
      let last = '';
      const render = () => {
        const headings: Array<{ level: number; text: string; pos: number }> = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading')
            headings.push({ level: Number(node.attrs.level), text: node.textContent, pos });
          return node.type.name !== 'heading';
        });
        const key = JSON.stringify(headings.map((heading) => [heading.level, heading.text]));
        if (key === last) return;
        last = key;
        dom.replaceChildren();
        if (!headings.length) {
          const empty = document.createElement('p');
          empty.className = 'toc-empty';
          empty.textContent = t('editor.tocEmpty');
          dom.append(empty);
          return;
        }
        headings.forEach((heading, index) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = `toc-item toc-${Math.min(3, heading.level)}`;
          item.textContent = heading.text || 'Untitled heading';
          item.addEventListener('click', (event) => {
            event.preventDefault();
            // positions move as the page changes, so the heading is found again by its place in the list
            let seen = 0;
            let target: number | null = null;
            editor.state.doc.descendants((node, pos) => {
              if (target !== null) return false;
              if (node.type.name === 'heading') {
                if (seen === index) target = pos;
                seen++;
                return false;
              }
              return true;
            });
            if (target === null) return;
            const element = editor.view.nodeDOM(target) as HTMLElement | null;
            element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          dom.append(item);
        });
      };
      render();
      editor.on('update', render);
      return {
        dom,
        stopEvent: (event) => event.type === 'click' || event.type === 'mousedown',
        ignoreMutation: () => true,
        destroy: () => {
          editor.off('update', render);
        },
      };
    };
  },
});

export interface DateMentionOptions {
  openDate: (date: Date) => void;
  findPages: (query: string) => Array<{ id: string; title: string; path: string }>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function describeDate(key: string, today = new Date()): string {
  const date = parseDateKey(key);
  if (!date) return key;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return t('daily.today');
  if (days === 1) return t('daily.tomorrow');
  if (days === -1) return t('daily.yesterday');
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(dateLocale(), {
    ...(days > 1 && days < 7 ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// dates the @ menu offers for what was typed, like "fri", "next week" or "2026-12-01"
export function dateSuggestions(query: string, today = new Date()): Date[] {
  const at = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const text = query.trim().toLowerCase();
  const all: Array<[string, Date]> = [
    ['今天', at(0)],
    ['明天', at(1)],
    ['昨天', at(-1)],
    ['下周', at(7)],
    ['today', at(0)],
    ['tomorrow', at(1)],
    ['yesterday', at(-1)],
    ['next week', at(7)],
  ];
  for (let offset = 1; offset <= 7; offset++) {
    const date = at(offset);
    all.push([WEEKDAYS[date.getDay()]!, date]);
    // 中文日期提及与英文关键字同时可用。
    const weekday = '日一二三四五六'[date.getDay()]!;
    all.push([`星期${weekday}`, date], [`周${weekday}`, date]);
  }
  const exact = parseDateKey(text);
  if (exact) return [exact];
  const typed = text ? new Date(`${text} ${today.getFullYear()}`) : null;
  const matches = all.filter(
    ([name]) => !text || name.startsWith(text) || name.split(' ').some((word) => word.startsWith(text)),
  );
  const dates = matches.map(([, date]) => date);
  if (typed && !Number.isNaN(typed.getTime()) && /\d/.test(text)) dates.unshift(typed);
  const seen = new Set<string>();
  return dates
    .filter((date) => {
      const key = dateKey(date);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, text ? 6 : 4);
}

// @today and friends, a date that opens that day's note
export const DateMention = Node.create<DateMentionOptions>({
  name: 'dateMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { openDate: () => {}, findPages: () => [] };
  },

  addAttributes() {
    return { date: { default: null, parseHTML: (element) => element.getAttribute('datetime') } };
  },

  parseHTML() {
    // 新日期组件的非法HTML也不能被旧每日笔记节点接管并吞掉原文。
    return [{ tag: 'time[datetime]:not([data-inline-date])' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'time',
      mergeAttributes(HTMLAttributes, { datetime: node.attrs.date, class: 'date-mention' }),
      describeDate(String(node.attrs.date)),
    ];
  },

  renderText({ node }) {
    return describeDate(String(node.attrs.date));
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.className = 'date-mention';
      dom.contentEditable = 'false';
      const paint = () => {
        const key = String(current.attrs.date ?? '');
        dom.textContent = `@${describeDate(key)}`;
        dom.title = t('editor.openNoteFor', {
          date: parseDateKey(key)?.toLocaleDateString(dateLocale(), { dateStyle: 'full' }) ?? key,
        });
        const date = parseDateKey(key);
        const today = dateKey(new Date());
        dom.classList.toggle('is-past', !!date && key < today);
        dom.classList.toggle('is-today', key === today);
      };
      paint();
      dom.addEventListener('click', (event) => {
        event.preventDefault();
        const date = parseDateKey(String(current.attrs.date ?? ''));
        if (date) this.options.openDate(date);
      });
      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<MenuItem, MenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey('dateMentionSuggestion'),
        char: '@',
        allowSpaces: true,
        allow: ({ state }) => state.selection.$from.parent.type.name !== 'codeBlock',
        items: ({ query }) => {
          if (query.length > 30) return [];
          const dates: MenuItem[] = dateSuggestions(query).map((date) => ({
            id: `date:${dateKey(date)}`,
            title: describeDate(dateKey(date)),
            description: date.toLocaleDateString(dateLocale(), {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }),
            icon: CalendarDays,
          }));
          const pages: MenuItem[] = options
            .findPages(query.trim())
            .slice(0, 5)
            .map((page) => ({
              id: `page:${page.id}`,
              title: page.title,
              ...(page.path ? { description: page.path } : {}),
              icon: FileText,
            }));
          return [...dates, ...pages];
        },
        command: ({ editor, range, props }) => insertMention(editor, range, props),
        render: renderSuggestion(
          () => t('editor.mentionDateOrPage'),
          () => t('editor.nothingMatches'),
        ),
      }),
    ];
  },
});

function insertMention(editor: Editor, range: { from: number; to: number }, item: MenuItem): void {
  const node = item.id.startsWith('date:')
    ? { type: 'dateMention', attrs: { date: item.id.slice(5) } }
    : { type: 'pageLink', attrs: { id: item.id.slice(5), label: item.title } };
  editor
    .chain()
    .focus()
    .insertContentAt(range, [node, { type: 'text', text: ' ' }])
    .run();
}
