/**
 * 功能：以色系网格为数据库单选、多选设置颜色，支持自定义 HEX 色值。
 * 作者：xuanli
 * 创建时间：2026-11-24 12:20:15
 */
import { Check, ChevronRight, ChevronsUpDown, Palette } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { normalizeOptionColor, OPTION_HEX_PATTERN } from '../../../core/model';
import type { OptionColor, SelectOption } from '../../../core/model';
import { t } from '../../i18n';
import { colorLabel } from '../../i18n/labels';
import { optionColorAppearance } from '../optionColors';
import { Popover } from '../Popover';

// 每列固定一个色系，主色列与下方的浅色、深色在同一个位置。
const PALETTE = [
  [
    '#17191F',
    '#31343D',
    '#4B515C',
    'slate',
    '#777F8C',
    '#979EAA',
    '#B5BBC4',
    '#D1D6DD',
    '#E8EBEF',
    '#FFFFFF',
  ],
  ['blue', '#13A8DD', '#10B981', '#83C819', 'yellow', '#F59D10', 'orange', 'red', 'pink', 'purple'],
  [
    '#EAF2FF',
    '#E6F8FF',
    '#E4F8F1',
    '#EFF8D9',
    '#FFF9D6',
    '#FFF0D7',
    '#FFEEE2',
    '#FFEBED',
    '#FDEBF5',
    '#F2EBFF',
  ],
  [
    '#B5D0FF',
    '#A5DCF4',
    '#A0DDC5',
    '#CAE98A',
    '#FCE887',
    '#FFD588',
    '#FFC0A0',
    '#FFB7BF',
    '#F3B0D9',
    '#D2BDF9',
  ],
  ['#628CF4', '#47B7E4', 'green', '#A0CD43', '#E4C836', '#F3A72C', '#F48450', '#F26775', 'rose', 'violet'],
  ['indigo', 'cyan', 'teal', 'lime', '#A08008', '#B6730D', '#BB541C', '#B73946', '#B53887', '#623DC3'],
  ['#243874', '#17506B', '#145A45', '#385818', '#65560E', 'amber', 'brown', 'burgundy', '#702858', '#3F286F'],
] as const satisfies readonly (readonly OptionColor[])[];

// 展平后的色块顺序与键盘移动顺序一致。
const COLORS_IN_GRID: readonly OptionColor[] = PALETTE.flat();
// 自定义预览在尚未填写有效色值时采用中性色。
const INITIAL_HEX = '#808080';

/** 使用同一个样式来源绘制触发按钮、默认色和预设色块。 */
function Swatch({ color, selected = false }: { color: OptionColor; selected?: boolean }) {
  return (
    <span {...optionColorAppearance(color, 'chip db-option-swatch')} aria-hidden="true">
      {selected && <Check size={15} strokeWidth={2.5} />}
    </span>
  );
}

/** 将键盘焦点按视觉行列移动，方向键不会滚动背景页面。 */
function stepInGrid(index: number, key: string): number | undefined {
  // 同一行的列数与 CSS 网格保持一致。
  const width = PALETTE[0].length;
  // 每行水平移动到边缘时停止，垂直移动保持色系。
  const column = index % width;
  switch (key) {
    case 'ArrowLeft':
      return index - Number(column > 0);
    case 'ArrowRight':
      return index + Number(column < width - 1);
    case 'ArrowUp':
      return Math.max(index - width, column);
    case 'ArrowDown':
      return Math.min(index + width, COLORS_IN_GRID.length - width + column);
    case 'Home':
      return index - column;
    case 'End':
      return index - column + width - 1;
    default:
      return undefined;
  }
}

/** 在选项设置内展示默认色、预设色矩阵和自定义颜色。 */
export function OptionColorPicker({
  value,
  fieldOptions,
  onChange,
}: {
  value: OptionColor;
  fieldOptions: SelectOption[];
  onChange: (color: OptionColor) => void;
}) {
  // 触发按钮同时提供定位和关闭后的焦点落点。
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 组件按打开状态挂载，关闭后丢弃未应用的自定义输入。
  const label = t('editor.colour');
  return (
    <>
      <button
        type="button"
        className="select-button"
        aria-label={label}
        title={colorLabel(value)}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <span>
          <Swatch color={value} /> {colorLabel(value)}
        </span>
        <ChevronsUpDown size={14} />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label={label}
          className="db-option-palette"
          fitViewport
          placement="bottom-end"
        >
          <PaletteContent
            value={value}
            fieldOptions={fieldOptions}
            onPick={(color) => {
              if (color !== value) onChange(color);
              setAnchor(null);
              anchor.focus({ preventScroll: true });
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** 管理色板键盘焦点和自定义颜色草稿。 */
function PaletteContent({
  value,
  fieldOptions,
  onPick,
}: {
  value: OptionColor;
  fieldOptions: SelectOption[];
  onPick: (color: OptionColor) => void;
}) {
  // 未出现在预设网格中的已用颜色在自定义区展示，当前颜色优先。
  const custom = [...new Set([value, ...fieldOptions.map((option) => option.color)])]
    .filter((color) => color !== 'gray' && !COLORS_IN_GRID.includes(color))
    .slice(0, PALETTE[0].length);
  // 方向键导航只为一个预设色保留 Tab 停靠点。
  const [active, setActive] = useState(Math.max(0, COLORS_IN_GRID.indexOf(value)));
  // 保留预设色按钮引用，用于方向键导航。
  const grid = useRef<HTMLDivElement>(null);
  // 减少默认弹层高度，更多颜色按需展开。
  const [expanded, setExpanded] = useState(false);
  // 初始草稿沿用当前自定义色，预设色使用中性色。
  const [draft, setDraft] = useState<string>(OPTION_HEX_PATTERN.test(value) ? value : INITIAL_HEX);
  // 文本输入尚未形成有效色值时，原生取色器使用可显示的中性色。
  const hex = OPTION_HEX_PATTERN.test(draft) ? draft : null;
  // 提交后才显示错误并保留编辑内容。
  const [invalid, setInvalid] = useState(false);
  // 关联自定义颜色的输入和校验反馈。
  const errorId = useId();
  // 用于将更多颜色按钮与展开的输入区关联。
  const formId = useId();
  // 显示默认色已选状态。
  const isDefault = value === 'gray';

  /** 聚焦方向键指定的色块。 */
  const navigateGrid = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // 保留与方向键无关的浏览器快捷键和按钮行为。
    const next = stepInGrid(index, event.key);
    if (next === undefined) return;
    event.preventDefault();
    grid.current?.querySelector<HTMLButtonElement>(`[data-color-index="${next}"]`)?.focus();
  };

  return (
    <>
      <button
        type="button"
        className="db-palette-action"
        aria-pressed={isDefault}
        data-autofocus={isDefault ? '' : undefined}
        onClick={() => onPick('gray')}
      >
        <Swatch color="gray" selected={isDefault} /> {t('editorBlocks.defaultColor')}
      </button>
      <div ref={grid} className="db-palette-grid" role="group" aria-label={t('database.presetColors')}>
        {COLORS_IN_GRID.map((color, index) => (
          <button
            key={color}
            type="button"
            className="db-palette-cell"
            title={colorLabel(color)}
            aria-label={colorLabel(color)}
            aria-pressed={value === color}
            data-autofocus={value === color ? '' : undefined}
            data-color-index={index}
            tabIndex={active === index ? 0 : -1}
            onFocus={() => setActive(index)}
            onKeyDown={(event) => navigateGrid(event, index)}
            onClick={() => onPick(color)}
          >
            <Swatch color={color} selected={value === color} />
          </button>
        ))}
      </div>
      {custom.length > 0 && (
        <div role="group" aria-label={t('editorBlocks.customColor')}>
          <p className="db-palette-caption">{t('editorBlocks.customColor')}</p>
          <div className="db-palette-grid">
            {custom.map((color) => (
              <button
                key={color}
                type="button"
                className="db-palette-cell"
                title={colorLabel(color)}
                aria-label={colorLabel(color)}
                aria-pressed={color === value}
                data-autofocus={color === value ? '' : undefined}
                onClick={() => onPick(color)}
              >
                <Swatch color={color} selected={color === value} />
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className="db-palette-action db-palette-more"
        aria-expanded={expanded}
        aria-controls={expanded ? formId : undefined}
        onClick={() => setExpanded(!expanded)}
      >
        <Palette size={16} /> {t('database.moreColors')} <ChevronRight size={14} />
      </button>
      {expanded && (
        <form
          id={formId}
          className="db-palette-custom"
          onSubmit={(event) => {
            event.preventDefault();
            // 只保存可持久化的颜色，规范化后再提交。
            const color = hex && normalizeOptionColor(hex);
            if (color) onPick(color);
            else setInvalid(true);
          }}
        >
          <input
            type="color"
            aria-label={t('editorBlocks.customColor')}
            value={hex ?? INITIAL_HEX}
            onChange={(event) => {
              setDraft(event.target.value.toUpperCase());
              setInvalid(false);
            }}
          />
          <input
            type="text"
            className="text-input small"
            aria-label="HEX"
            placeholder="#RRGGBB"
            spellCheck={false}
            autoFocus
            value={draft}
            maxLength={7}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="button small">
            {t('editor.apply')}
          </button>
          {invalid && (
            <p id={errorId} role="alert" className="field-error">
              {t('editorBlocks.invalidColor')}
            </p>
          )}
        </form>
      )}
    </>
  );
}
