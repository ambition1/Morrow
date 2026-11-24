/**
 * 功能：在当前文档内显示并编辑日期及可选时刻，所有操作均不跳转笔记。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:38:47
 */
import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { CalendarDays } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { inlineDateText, inlineDateValue, inlineDateCalendarDate } from '../../core/inlineDate';
import type { InlineDateValue } from '../../core/inlineDate';
import { DatePanel, dateKey, todayCalendarDate } from '../components/CalendarDatePicker';
import { dateLocale, t } from '../i18n';

/** 只在新插入的标签上请求展开，不把浮层状态写进文档。 */
const OPEN_DATE = 'morrow:inline-date-open';

/** 界面使用绝对日期，不让“明天”随日期推移改变原意。 */
function dateLabel(value: InlineDateValue): string {
  /** 无时区日历日期仅用于本地格式化。 */
  const date = inlineDateCalendarDate(value.date);
  return `${
    date?.toLocaleDateString(dateLocale(), {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
      ...(date.getUTCFullYear() === todayCalendarDate().getUTCFullYear() ? {} : { year: 'numeric' }),
    }) ?? value.date
  }${value.time ? ` ${value.time}` : ''}`;
}

/** 独立行内日期，不复用会跳转文档的旧dateMention节点。 */
export const InlineDate = Node.create({
  name: 'inlineDate',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (element) => inlineDateValue(element.getAttribute('datetime'))?.date ?? null,
      },
      time: {
        default: null,
        parseHTML: (element) => inlineDateValue(element.getAttribute('datetime'))?.time ?? null,
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'time[data-inline-date]',
        getAttrs: (element) => (inlineDateValue(element.getAttribute('datetime')) ? null : false),
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'time',
      mergeAttributes(HTMLAttributes, {
        'data-inline-date': '',
        datetime: `${node.attrs.date}${node.attrs.time ? `T${node.attrs.time}` : ''}`,
      }),
      inlineDateText(node.attrs.date, node.attrs.time),
    ];
  },
  renderText({ node }) {
    return inlineDateText(node.attrs.date, node.attrs.time);
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      /** 当前节点跟随编辑器事务更新。 */
      let current = node;
      /** 组件外壳不允许正文直接修改标签文字。 */
      const dom = document.createElement('button');
      dom.type = 'button';
      dom.className = 'inline-date-chip';
      dom.contentEditable = 'false';
      /** 当前打开面板的清理函数。 */
      let closePanel: (() => void) | null = null;
      /** 日期标签使用已有Lucide图标。 */
      const chip = createRoot(dom);
      /** 保留编辑光标，关闭面板后可继续输入。 */
      const open = () => {
        if (!editor.isEditable || editor.isDestroyed) return;
        closePanel?.();
        /** 面板独立React根节点，与编辑器的DOM生命周期隔离。 */
        const host = document.createElement('div');
        document.body.append(host);
        /** 面板根节点负责释放事件和浮层。 */
        const root = createRoot(host);
        /** 防止重复关闭。 */
        let closed = false;
        /** 关闭采用微任务，避免事件回调内同步卸载React。 */
        const close = () => {
          if (closed) return;
          closed = true;
          queueMicrotask(() => {
            root.unmount();
            host.remove();
          });
          if (dom.isConnected) dom.focus({ preventScroll: true });
        };
        closePanel = close;
        root.render(
          <DatePanel
            anchor={dom}
            initial={
              inlineDateValue(
                `${current.attrs.date}${current.attrs.time ? `T${current.attrs.time}` : ''}`,
              ) ?? { date: dateKey(todayCalendarDate()), time: null }
            }
            close={close}
            update={(value) => {
              if (editor.isDestroyed || !editor.isEditable) return;
              /** 获取当前节点位置，避免浮层打开后文档前方编辑导致位置过期。 */
              const pos = getPos();
              if (pos === undefined) return;
              /** 被删除或替换的日期不再更新。 */
              const latest = editor.state.doc.nodeAt(pos);
              if (latest?.type.name !== 'inlineDate') return;
              if (latest.attrs.date === value.date && latest.attrs.time === value.time) return;
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, { ...latest.attrs, ...value }),
              );
            }}
          />,
        );
      };
      /** 更新标签与可访问名称，不使用相对日期。 */
      const paint = () => {
        /** 非法旧数据仍显示原文，避免整份文档打不开。 */
        const value = inlineDateValue(
          `${current.attrs.date}${current.attrs.time ? `T${current.attrs.time}` : ''}`,
        );
        dom.disabled = !editor.isEditable;
        dom.setAttribute('aria-haspopup', 'dialog');
        dom.setAttribute(
          'aria-label',
          `${t('inlineDate.edit')}: ${inlineDateText(current.attrs.date, current.attrs.time)}`,
        );
        chip.render(
          <>
            <CalendarDays size={15} aria-hidden="true" />
            <span>{value ? dateLabel(value) : String(current.attrs.date ?? '')}</span>
          </>,
        );
      };
      dom.addEventListener('click', open);
      dom.addEventListener(OPEN_DATE, open);
      paint();
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
        destroy() {
          closePanel?.();
          queueMicrotask(() => chip.unmount());
        },
      };
    };
  },
});

/** 斜杠入口直接插入今天日期并展开原地选择面板。 */
export function insertInlineDate(editor: Editor, range: Range): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'inlineDate', attrs: { date: dateKey(todayCalendarDate()), time: null } },
      { type: 'text', text: ' ' },
    ])
    .run();
  /** 节点视图在事务提交后同步挂载。 */
  const dom = editor.view.nodeDOM(range.from);
  if (dom instanceof HTMLElement) dom.dispatchEvent(new Event(OPEN_DATE));
}
