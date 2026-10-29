import { computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import { ReactRenderer } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import type { LucideIcon } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useId } from 'react';
import { t } from '../i18n';

export interface MenuItem {
  id: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  hint?: string;
  section?: string;
  /** 斜杠菜单中的紧凑分组，不影响页面或日期补全。 */
  compact?: 'recent' | 'format' | 'content' | 'more';
  /** 格式快捷键的单个字形，例如H1。 */
  glyph?: string;
  /** 最近使用副本仍指向原始命令。 */
  commandId?: string;
}

interface Props {
  items: MenuItem[];
  emptyText: string;
  label: string;
  // what enter does, shown in the hint along the bottom
  action: string;
  onSelect: (item: MenuItem) => void;
  /** 仅空查询的斜杠菜单显示图标网格。 */
  compact?: boolean;
}

export interface SuggestionMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SuggestionMenu = forwardRef<SuggestionMenuHandle, Props>(function SuggestionMenu(
  { items, emptyText, label, action, onSelect, compact = false },
  ref,
) {
  // 当前虚拟焦点与选项ID保留在编辑器输入过程中。
  const [active, setActive] = useState(0);
  // 每个编辑器菜单独享ID，分屏不会重复。
  const optionId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [lastItems, setLastItems] = useState(items);

  // reset the highlight whenever the result list changes
  if (items !== lastItems) {
    setLastItems(items);
    setActive(0);
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const actionLabel =
    action === 'insert'
      ? t('editor.suggestion.actionInsert')
      : action === 'link'
        ? t('editor.suggestion.actionLink')
        : action === 'choose'
          ? t('editor.suggestion.actionChoose')
          : action;

  // 图标区上下移动按真实视觉行定位，左右按相邻项目移动。
  const move = (direction: 'up' | 'down' | 'left' | 'right') => {
    setActive((index) => {
      // 普通搜索结果仍沿用原有顺序。
      if (!compact || direction === 'left' || direction === 'right')
        return (index + (direction === 'up' || direction === 'left' ? -1 : 1) + items.length) % items.length;
      // 编辑器焦点不离开正文，读取菜单按钮位置决定下一行。
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? []);
      const rect = buttons[index]?.getBoundingClientRect();
      if (!rect) return index;
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      // 候选按垂直距离优先，同一行选择横向最近的按钮。
      const candidates = buttons
        .map((button, nextIndex) => ({ nextIndex, rect: button.getBoundingClientRect() }))
        .filter(({ rect: next }) =>
          direction === 'down'
            ? next.y + next.height / 2 > centerY + 4
            : next.y + next.height / 2 < centerY - 4,
        );
      candidates.sort(
        (a, b) =>
          Math.abs(a.rect.y + a.rect.height / 2 - centerY) -
            Math.abs(b.rect.y + b.rect.height / 2 - centerY) ||
          Math.abs(a.rect.x + a.rect.width / 2 - centerX) - Math.abs(b.rect.x + b.rect.width / 2 - centerX),
      );
      return candidates[0]?.nextIndex ?? (direction === 'down' ? 0 : items.length - 1);
    });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229 || items.length === 0) return false;
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        move('down');
        return true;
      }
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        move('up');
        return true;
      }
      if (compact && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        move(event.key === 'ArrowLeft' ? 'left' : 'right');
        return true;
      }
      if (event.key === 'Home') {
        setActive(0);
        return true;
      }
      if (event.key === 'End') {
        setActive(items.length - 1);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // 选中项只执行一次，输入法选词阶段不进入此分支。
        const item = items[active];
        if (item) onSelect(item);
        return true;
      }
      return false;
    },
  }));

  // 每个分组保留它在扁平命令数组中的索引，键盘与鼠标采用同一顺序。
  const groups: Array<{
    section: string;
    kind: MenuItem['compact'];
    entries: Array<{ item: MenuItem; index: number }>;
  }> = [];
  for (const [index, item] of items.entries()) {
    // 相邻分组只生成一个标题。
    const previous = groups[groups.length - 1];
    if (!previous || previous.section !== (item.section ?? '') || previous.kind !== item.compact)
      groups.push({ section: item.section ?? '', kind: item.compact, entries: [{ item, index }] });
    else previous.entries.push({ item, index });
  }
  // 图标选项使用完整名称作为可访问文本及悬停说明。
  const renderItem = (item: MenuItem, index: number) => {
    const Icon = item.icon;
    const iconOnly = compact && item.compact === 'format';
    return (
      <button
        key={item.id}
        id={`${optionId}-${index}`}
        type="button"
        role="option"
        aria-label={item.title}
        aria-selected={index === active}
        data-index={index}
        className={`suggestion-item${iconOnly ? ' is-icon-only' : ''}`}
        title={item.title}
        onMouseMove={() => index !== active && setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(item)}
      >
        {item.glyph && iconOnly ? (
          <span className="suggestion-glyph" aria-hidden="true">
            {item.glyph}
          </span>
        ) : Icon ? (
          <span className="suggestion-icon">
            <Icon size={16} strokeWidth={1.75} />
          </span>
        ) : null}
        {!iconOnly && (
          <span className="suggestion-text">
            <span className="suggestion-title">{item.title}</span>
            {!compact && item.description && (
              <span className="suggestion-description">{item.description}</span>
            )}
          </span>
        )}
        {!compact && item.hint && <kbd className="suggestion-hint">{item.hint}</kbd>}
      </button>
    );
  };

  return (
    <div
      className={`suggestion-menu popover${compact ? ' slash-insertion-menu' : ''}`}
      role="listbox"
      aria-label={label}
      aria-activedescendant={items.length ? `${optionId}-${active}` : undefined}
    >
      <div className="suggestion-list" ref={listRef}>
        {items.length === 0 ? (
          <div className="suggestion-empty">{emptyText}</div>
        ) : (
          groups.map((group, groupIndex) => (
            <div
              key={`${group.section}-${groupIndex}`}
              className={compact ? `slash-command-group is-${group.kind ?? 'more'}` : undefined}
            >
              {group.section && <div className="suggestion-section">{group.section}</div>}
              <div className={compact ? 'slash-command-grid' : undefined}>
                {group.entries.map(({ item, index }) => renderItem(item, index))}
              </div>
            </div>
          ))
        )}
      </div>
      {items.length > 0 && (
        <div className="suggestion-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('editor.suggestion.toChoose')}
          </span>
          <span>
            <kbd>↵</kbd> {t('editor.suggestion.toAction', { action: actionLabel })}
          </span>
          <span>
            <kbd>esc</kbd> {t('editor.suggestion.toClose')}
          </span>
        </div>
      )}
    </div>
  );
});

// lifecycle glue between tiptap suggestion and the floating react list
export function renderSuggestion(
  label: string | (() => string),
  emptyText: string | (() => string),
  action: string | (() => string) = 'choose',
  options: { mode?: 'slash' } = {},
) {
  return () => {
    let renderer: ReactRenderer<SuggestionMenuHandle, Props> | null = null;
    let latest: SuggestionProps<MenuItem, MenuItem> | null = null;

    const place = () => {
      const rect = latest?.clientRect?.();
      if (!renderer || !rect) return;
      const element = renderer.element as HTMLElement;
      /** 紧凑面板优先使用空间较大的一侧，避免上次收缩高度影响下一次定位。 */
      const preferAbove =
        options.mode === 'slash' &&
        window.innerHeight - rect.bottom < 400 &&
        rect.top > window.innerHeight - rect.bottom;
      void computePosition({ getBoundingClientRect: () => rect }, element, {
        placement: preferAbove ? 'top-start' : 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(6),
          // opens above the line when there is more room there, and never runs off the window
          flip({ padding: 8, fallbackPlacements: ['top-start'] }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(64, Math.min(options.mode === 'slash' ? 600 : 420, availableHeight))}px`;
            },
          }),
        ],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      });
    };

    const resolveText = (val: string | (() => string)) => (typeof val === 'function' ? val() : val);

    const props = (suggestion: SuggestionProps<MenuItem, MenuItem>): Props => ({
      items: suggestion.items,
      emptyText: resolveText(emptyText),
      label: resolveText(label),
      action: resolveText(action),
      onSelect: (item) => suggestion.command(item),
      compact: options.mode === 'slash' && !suggestion.query.trim(),
    });

    const destroy = () => {
      renderer?.element.remove();
      renderer?.destroy();
      renderer = null;
    };

    return {
      onStart(suggestion: SuggestionProps<MenuItem, MenuItem>) {
        latest = suggestion;
        renderer = new ReactRenderer(SuggestionMenu, {
          props: props(suggestion),
          editor: suggestion.editor as Editor,
        });
        const element = renderer.element as HTMLElement;
        element.classList.add('floating-layer');
        element.style.position = 'fixed';
        document.body.appendChild(element);
        place();
        // placed again once the list is drawn, its real height decides above or below
        requestAnimationFrame(place);
      },
      onUpdate(suggestion: SuggestionProps<MenuItem, MenuItem>) {
        latest = suggestion;
        renderer?.updateProps(props(suggestion));
        requestAnimationFrame(place);
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (event.isComposing || event.keyCode === 229) return false;
        if (event.key === 'Escape') {
          destroy();
          return true;
        }
        return renderer?.ref?.onKeyDown(event) ?? false;
      },
      onExit() {
        destroy();
      },
    };
  };
}
