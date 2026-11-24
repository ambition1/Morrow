/**
 * 功能：为文档标签和数据库属性提供一致的日历浮层。
 * 作者：xuanli
 * 创建时间：2026-11-24 12:04:08
 */
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { inlineDateValue, inlineDateCalendarDate } from '../../core/inlineDate';
import type { InlineDateValue } from '../../core/inlineDate';
import { Popover } from './Popover';
import { dateLocale, t } from '../i18n';

/** 日期键在公元1000年前也保持四位年份。 */
export function dateKey(date: Date): string {
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
export function todayCalendarDate(): Date {
  /** 当前设备本地时间不作为文档中已选日期的时区。 */
  const now = new Date();
  return calendarDate(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 与既有日历共用样式的独立编辑面板，不读取或创建每日笔记。 */
export function DatePanel({
  anchor,
  initial,
  update,
  close,
  dateOnly,
}: {
  anchor: HTMLElement;
  initial: InlineDateValue;
  update: (value: InlineDateValue) => void;
  close: () => void;
  /** 数据库日期允许手输或清空，选中日期后立即完成。 */
  dateOnly?: { empty: boolean; manualDate: string | null; clear: () => void };
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
      label={t(dateOnly ? 'database.date' : 'inlineDate.picker')}
      className="inline-date-popover"
    >
      <div className="daily-calendar inline-date-calendar">
        {dateOnly && <DateFields date={dateOnly.manualDate ?? ''} onPick={pick} />}
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
            /** 空值打开时只标记今天，避免误显示已保存日期。 */
            const selected = key === value.date && (!dateOnly || dateOnly.manualDate === key);
            return (
              <button
                key={key}
                type="button"
                data-date={key}
                disabled={date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999}
                tabIndex={key === focus ? 0 : -1}
                data-autofocus={!dateOnly && key === focus ? '' : undefined}
                aria-label={date.toLocaleDateString(dateLocale(), { dateStyle: 'full', timeZone: 'UTC' })}
                aria-pressed={selected}
                className={`daily-calendar-day${date.getUTCMonth() !== month.getUTCMonth() ? ' is-outside' : ''}${key === dateKey(today) ? ' is-today' : ''}${selected ? ' is-selected' : ''}`}
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
        {dateOnly ? (
          <div className="inline-date-time-row">
            <button type="button" className="button small" disabled={dateOnly.empty} onClick={dateOnly.clear}>
              {t('database.clear')}
            </button>
          </div>
        ) : (
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
        )}
      </div>
    </Popover>
  );
}

/** 四位年、两位月日分别输入，避免浏览器原生日期控件接受五位年份。 */
function DateFields({ date, onPick }: { date: string; onPick: (date: Date) => void }) {
  // 输入过程保留草稿，只有提交有效日期才更新记录。
  const [parts, setParts] = useState(() => (date ? date.split('-') : ['', '', '']));
  // 提交失败后保留已输入的年月日并提示修正。
  const [invalid, setInvalid] = useState(false);
  // 为日期校验说明建立当前浮层内唯一的关联。
  const errorId = useId();
  // 字段标题随着界面语言切换，输入顺序与 ISO 日期一致。
  const fields = [t('database.dateYear'), t('database.dateMonth'), t('database.dateDay')];
  return (
    <form
      className="db-date-fields"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // 转换之前检查年份位数，并将一位的月、日补齐。
        const key = [parts[0], parts[1]?.padStart(2, '0'), parts[2]?.padStart(2, '0')].join('-');
        // 共用正文日期的校验，涵盖月末和闰年。
        const parsed = inlineDateCalendarDate(key);
        if (parsed) onPick(parsed);
        else setInvalid(true);
      }}
    >
      {fields.map((label, index) => (
        <label key={label} className="field">
          <span>{label}</span>
          <input
            type="text"
            className="text-input small"
            inputMode="numeric"
            maxLength={index === 0 ? 4 : 2}
            data-autofocus={index === 0 ? true : undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            value={parts[index]}
            onChange={(event) => {
              // 粘贴与输入都只保留规定长度的数字。
              const digits = event.target.value.replace(/\D/g, '').slice(0, index === 0 ? 4 : 2);
              setInvalid(false);
              setParts((current) => current.map((part, position) => (position === index ? digits : part)));
            }}
          />
        </label>
      ))}
      <button type="submit" className="button small">
        {t('inlineDate.done')}
      </button>
      {invalid && (
        <p id={errorId} className="field-error" role="alert">
          {t('database.invalidDate')}
        </p>
      )}
    </form>
  );
}

/** 数据库属性和筛选器共用的日期输入。 */
export function DateInput({
  label,
  value,
  editable = true,
  onChange,
}: {
  label: string;
  value: string | null;
  editable?: boolean;
  onChange: (value: string | null) => void;
}) {
  // 展开状态绑定当前触发按钮，便于浮层定位和键盘焦点恢复。
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 历史值保持可见，只将合法日期带入日历。
  const selected = inlineDateValue(value ?? '')?.date ?? null;
  // 完成输入或选择后回到同一个表格单元格或表单控件。
  const close = () => {
    setAnchor(null);
  };
  // 明确提交时恢复焦点，外部点击关闭时由用户选择新的焦点。
  const commit = (next: string | null) => {
    onChange(next);
    anchor?.focus({ preventScroll: true });
    close();
  };
  return (
    <>
      <button
        className="prop-select db-date-trigger"
        type="button"
        aria-label={value ? `${label}: ${value}` : label}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        disabled={!editable}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <span>{value || (editable ? t('database.empty') : '')}</span>
        {editable && <CalendarDays size={14} aria-hidden="true" />}
      </button>
      {anchor && (
        <DatePanel
          anchor={anchor}
          initial={{ date: selected ?? dateKey(todayCalendarDate()), time: null }}
          update={(next) => commit(next.date)}
          close={close}
          dateOnly={{ empty: !value, manualDate: selected, clear: () => commit(null) }}
        />
      )}
    </>
  );
}
