/**
 * 功能：在当前文档内显示并编辑日期及可选时刻，所有操作均不跳转笔记。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:38:47
 */
import { mergeAttributes, Node } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { inlineDateText, inlineDateValue, inlineDateCalendarDate } from '../../core/inlineDate';
import type { InlineDateValue } from '../../core/inlineDate';
import { Popover } from '../components/Popover';
import { dateLocale, t } from '../i18n';

/** 只在新插入的标签上请求展开，不把浮层状态写进文档。 */
const OPEN_DATE = 'morrow:inline-date-open';

/** 日期键在公元1000年前也保持四位年份。 */
function dateKey(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 用UTC日历载体跨月滚动，日期显示不随设备时区改变。 */
function calendarDate(year: number, month: number, day: number): Date {
  /** 固定时分秒以避免继承Unix纪元当地时刻。 */
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
}

/** 今天以设备本地日历为准，再放入中性的UTC日历载体计算。 */
function todayCalendarDate(): Date {
  /** 当前设备本地时间不作为文档中已选日期的时区。 */
  const now = new Date();
  return calendarDate(now.getFullYear(), now.getMonth(), now.getDate());
}

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

/** 与既有日历共用样式的独立编辑面板，不读取或创建每日笔记。 */
function DatePanel({
  anchor,
  initial,
  update,
  close,
}: {
  anchor: HTMLElement;
  initial: InlineDateValue;
  update: (value: InlineDateValue) => void;
  close: () => void;
}) {
  /** 当前已保存的标签值。 */
  const [value, setValue] = useState(initial);
  /** 当前显示月份独立于已选日期。 */
  const [month, setMonth] = useState(() => inlineDateCalendarDate(initial.date)!);
  /** 键盘漫游日历焦点。 */
  const [focus, setFocus] = useState(initial.date);
  /** 日历容器用于重新聚焦目标日期按钮。 */
  const grid = useRef<HTMLDivElement>(null);
  /** 今天仅作边框标记及快捷日期基准。 */
  const today = todayCalendarDate();
  /** 以周日为起点，包含相邻月份并固定六周。 */
  const first = calendarDate(month.getUTCFullYear(), month.getUTCMonth(), 1);
  /** 当前可见的42个真实日期。 */
  const cells = Array.from({ length: 42 }, (_, index) =>
    calendarDate(first.getUTCFullYear(), first.getUTCMonth(), index - first.getUTCDay() + 1),
  );
  /** 每次明确操作更新原节点，保留其余属性。 */
  const save = (next: InlineDateValue) => {
    setValue(next);
    update(next);
  };
  /** 选择日期仅修改标签，不关闭用户正在设置的时刻。 */
  const pick = (date: Date) => {
    /** 校验边界，避免日历浏览超出可存储年份。 */
    const key = dateKey(date);
    if (!inlineDateValue(key)) return;
    setFocus(key);
    setMonth(date);
    save({ ...value, date: key });
  };
  /** 跨月和跨年共用导航，保持有效年份范围。 */
  const shift = (months: number) => {
    /** 使用月份第一天，避免31日跳过二月。 */
    const next = calendarDate(month.getUTCFullYear(), month.getUTCMonth() + months, 1);
    if (next.getUTCFullYear() < 1 || next.getUTCFullYear() > 9999) return;
    setMonth(next);
    setFocus(dateKey(next));
  };
  /** 箭头键按日或周漫游，PageUp/Down切换月，Enter/空格由原生按钮选择。 */
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, date: Date) => {
    /** 键盘对应的日偏移量。 */
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    /** 目标日期保持本地日历语义。 */
    const next = new Date(date);
    if (event.key in offsets) next.setUTCDate(next.getUTCDate() + offsets[event.key]!);
    else if (event.key === 'Home') next.setUTCDate(next.getUTCDate() - next.getUTCDay());
    else if (event.key === 'End') next.setUTCDate(next.getUTCDate() + 6 - next.getUTCDay());
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + (event.key === 'PageUp' ? -1 : 1));
    } else return;
    event.preventDefault();
    /** 焦点移动不修改已保存日期，Enter后才提交。 */
    const key = dateKey(next);
    if (!inlineDateValue(key)) return;
    setFocus(key);
    setMonth(next);
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${key}"]`)?.focus(),
    );
  };
  return (
    <Popover
      fitViewport
      anchor={anchor}
      onClose={close}
      label={t('inlineDate.picker')}
      className="inline-date-popover"
    >
      <div className="daily-calendar inline-date-calendar">
        <div className="daily-calendar-head">
          <button
            type="button"
            className="icon-button"
            aria-label={t('inlineDate.previousYear')}
            onClick={() => shift(-12)}
          >
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('daily.previousMonth')}
            onClick={() => shift(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <strong aria-live="polite">
            {month.toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' })}
          </strong>
          <button
            type="button"
            className="icon-button"
            aria-label={t('daily.nextMonth')}
            onClick={() => shift(1)}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('inlineDate.nextYear')}
            onClick={() => shift(12)}
          >
            <ChevronsRight size={16} />
          </button>
        </div>
        <div ref={grid} className="daily-calendar-grid" role="group" aria-label={t('inlineDate.pickDate')}>
          {Array.from({ length: 7 }, (_, index) => (
            <span key={`w${index}`} className="daily-calendar-weekday" aria-hidden="true">
              {calendarDate(2026, 9, 25 + index).toLocaleDateString(dateLocale(), {
                weekday: 'narrow',
                timeZone: 'UTC',
              })}
            </span>
          ))}
          {cells.map((date) => {
            /** 日历单元格的稳定日期键。 */
            const key = dateKey(date);
            return (
              <button
                key={key}
                type="button"
                data-date={key}
                tabIndex={key === focus ? 0 : -1}
                data-autofocus={key === focus ? '' : undefined}
                aria-label={date.toLocaleDateString(dateLocale(), { dateStyle: 'full', timeZone: 'UTC' })}
                aria-pressed={key === value.date}
                className={`daily-calendar-day${date.getUTCMonth() !== month.getUTCMonth() ? ' is-outside' : ''}${key === dateKey(today) ? ' is-today' : ''}${key === value.date ? ' is-selected' : ''}`}
                onKeyDown={(event) => move(event, date)}
                onClick={() => pick(date)}
              >
                {date.getUTCDate()}
              </button>
            );
          })}
        </div>
        <div className="inline-date-shortcuts">
          {[0, 1, 7].map((days) => (
            <button
              key={days}
              type="button"
              className="button small"
              onClick={() =>
                pick(calendarDate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days))
              }
            >
              {days === 0 ? t('daily.today') : days === 1 ? t('daily.tomorrow') : t('inlineDate.plusWeek')}
            </button>
          ))}
        </div>
        <div className="inline-date-time-row">
          <label>
            <input
              type="checkbox"
              checked={value.time !== null}
              onChange={(event) => save({ ...value, time: event.target.checked ? '09:00' : null })}
            />
            {t('inlineDate.includeTime')}
          </label>
          {value.time !== null && (
            <input
              className="text-input small"
              type="time"
              aria-label={t('inlineDate.time')}
              value={value.time}
              onChange={(event) => {
                /** 浏览器time控件清空或输入不完整时不覆盖上次有效值。 */
                const next = inlineDateValue(`${value.date}T${event.target.value}`);
                if (next) save(next);
              }}
            />
          )}
          <button type="button" className="button small" onClick={close}>
            {t('inlineDate.done')}
          </button>
        </div>
      </div>
    </Popover>
  );
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
