/**
 * 功能：编辑现有提示块、分栏、步骤列表与折叠块的外观配置。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:05:47
 */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Check, CircleAlert, CircleHelp, Info, Lightbulb, MoreHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { normalizeBackground } from '../../core/blockAppearance';
import { CALLOUT_TONES, COLORS } from '../../core/model';
import { Popover } from '../components/Popover';
import { Switch } from '../components/primitives';
import { colorLabel } from '../i18n/labels';
import { t } from '../i18n';

/** 已支持的自定义提示图标。 */
const BLOCK_ICONS = [
  { value: 'info', Icon: Info },
  { value: 'lightbulb', Icon: Lightbulb },
  { value: 'check', Icon: Check },
  { value: 'alert', Icon: CircleAlert },
  { value: 'help', Icon: CircleHelp },
] as const;

/** 外观面板仅修改当前节点的可选属性，编辑内容仍由原编辑器管理。 */
export function BlockAppearanceSettings({
  editor,
  pos,
  anchor,
  onClose,
  onMore,
}: {
  editor: Editor;
  pos: number;
  anchor: DOMRect;
  onClose: () => void;
  onMore: () => void;
}) {
  /** 订阅当前节点，让连续设置立即反映在面板和正文中。 */
  const node = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc.nodeAt(pos) });
  /** 自定义HEX输入在本地编辑，失焦或回车才形成一次撤销记录。 */
  const [custom, setCustom] = useState<string | null>(null);
  /** 非法颜色输入的就地错误状态。 */
  const [invalid, setInvalid] = useState(false);
  if (!node) return null;
  /** 当前节点类别与属性。 */
  const type = node.type.name;
  /** 不修改文档结构的外观属性快照。 */
  const attrs = node.attrs;
  /** 每次明确的设置只提交一个事务，且保留其他属性。 */
  const update = (patch: Record<string, unknown>) => {
    if (editor.isDestroyed || !editor.isEditable) return;
    /** 当前文档中的节点，避免使用过期属性覆盖连续编辑。 */
    const current = editor.state.doc.nodeAt(pos);
    if (current?.type.name !== type) return;
    // 相同设置不产生空的撤销记录或无意义保存。
    if (
      Object.entries(patch).every(
        ([key, value]) => JSON.stringify(current.attrs[key]) === JSON.stringify(value),
      )
    )
      return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }));
  };
  /** 校验并提交自定义颜色，不把非法样式写入文档。 */
  const commitColor = () => {
    if (custom === null) return;
    /** 颜色归一化结果。 */
    const value = custom.trim() ? normalizeBackground(custom) : null;
    if (custom.trim() && !/^#[0-9A-F]{6}$/.test(value ?? '')) {
      setInvalid(true);
      return;
    }
    update({ background: value });
    setCustom(null);
    setInvalid(false);
  };
  /** 面板标题沿用现有块的语义。 */
  const label = type === 'callout' ? t('editor.callout') : t('editorBlocks.appearance');
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      placement="right-start"
      label={label}
      className="block-appearance-popover"
    >
      <div className="block-appearance-heading">
        <strong>{label}</strong>
        <button type="button" className="icon-button small" aria-label={t('common.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {type === 'callout' && (
        <section className="block-setting-section">
          <span className="block-setting-label">{t('editorBlocks.presets')}</span>
          <div className="segmented block-presets">
            {CALLOUT_TONES.map((tone) => (
              <button
                key={tone}
                type="button"
                aria-pressed={attrs.tone === tone}
                className={attrs.tone === tone ? 'is-active' : ''}
                onClick={() => update({ tone, kind: tone })}
              >
                {t(
                  tone === 'note'
                    ? 'editor.note'
                    : tone === 'tip'
                      ? 'editor.tip'
                      : tone === 'warning'
                        ? 'editor.warning'
                        : 'editor.danger',
                )}
              </button>
            ))}
          </div>
        </section>
      )}
      {type === 'columns' ? (
        <section className="block-setting-section">
          <span className="block-setting-label">{t('editorBlocks.proportions')}</span>
          <div className="segmented">
            <button type="button" onClick={() => update({ widths: null })}>
              {t('editorBlocks.equalColumns')}
            </button>
            {node.childCount === 2 && (
              <>
                <button type="button" onClick={() => update({ widths: [66.67, 33.33] })}>
                  2 : 1
                </button>
                <button type="button" onClick={() => update({ widths: [33.33, 66.67] })}>
                  1 : 2
                </button>
              </>
            )}
          </div>
          <span className="block-setting-label">{t('editorBlocks.spacing')}</span>
          <div className="segmented">
            {(['compact', 'normal', 'wide'] as const).map((gap) => (
              <button
                key={gap}
                type="button"
                aria-pressed={(attrs.gap ?? 'normal') === gap}
                className={(attrs.gap ?? 'normal') === gap ? 'is-active' : ''}
                onClick={() => update({ gap: gap === 'normal' ? null : gap })}
              >
                {t(`editorBlocks.${gap}`)}
              </button>
            ))}
          </div>
          <p className="block-setting-help">{t('editorBlocks.resizeHelp')}</p>
          {Array.from({ length: node.childCount }, (_, index) => {
            /** 对应栏的文档位置。 */
            const columnPos =
              pos +
              1 +
              Array.from({ length: index }, (_, before) => node.child(before).nodeSize).reduce(
                (sum, size) => sum + size,
                0,
              );
            return <ColumnAppearance key={index} editor={editor} pos={columnPos} number={index + 1} />;
          })}
        </section>
      ) : type === 'orderedList' ? (
        <section className="block-setting-section">
          <span className="block-setting-label">{t('editorBlocks.listStyle')}</span>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={attrs.presentation !== 'steps'}
              onClick={() => update({ presentation: null })}
            >
              {t('editorBlocks.standardList')}
            </button>
            <button
              type="button"
              aria-pressed={attrs.presentation === 'steps'}
              onClick={() => update({ presentation: 'steps' })}
            >
              {t('editorBlocks.steps')}
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="block-setting-section">
            <span className="block-setting-label">{t('editorBlocks.background')}</span>
            <div className="block-colors">
              <button
                type="button"
                className={`color-dot default${!attrs.background ? ' is-active' : ''}`}
                aria-label={t('editorBlocks.defaultColor')}
                title={t('editorBlocks.defaultColor')}
                onClick={() => {
                  update({ background: null });
                  setCustom(null);
                  setInvalid(false);
                }}
              />
              <button
                type="button"
                className={`color-dot block-transparent${attrs.background === 'transparent' ? ' is-active' : ''}`}
                aria-label={t('editorBlocks.transparent')}
                title={t('editorBlocks.transparent')}
                onClick={() => {
                  update({ background: 'transparent' });
                  setCustom(null);
                  setInvalid(false);
                }}
              />
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`color-dot bg-${color}${attrs.background === color ? ' is-active' : ''}`}
                  aria-label={colorLabel(color)}
                  title={colorLabel(color)}
                  onClick={() => {
                    update({ background: color });
                    setCustom(null);
                    setInvalid(false);
                  }}
                />
              ))}
            </div>
            <label className="block-custom-color">
              <span>{t('editorBlocks.customColor')}</span>
              <input
                className="text-input small"
                aria-label={t('editorBlocks.customColor')}
                aria-invalid={invalid}
                placeholder="#EDF5FF"
                spellCheck={false}
                value={
                  custom ??
                  (typeof attrs.background === 'string' && attrs.background.startsWith('#')
                    ? attrs.background
                    : '')
                }
                onChange={(event) => {
                  setCustom(event.target.value);
                  setInvalid(false);
                }}
                onBlur={commitColor}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitColor();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setCustom(null);
                    setInvalid(false);
                  }
                }}
              />
            </label>
            {invalid && (
              <span className="field-error" role="alert">
                {t('editorBlocks.invalidColor')}
              </span>
            )}
          </section>
          <section className="block-setting-section">
            <span className="block-setting-label">{t('editorBlocks.border')}</span>
            <div className="segmented">
              {(['none', 'thin', 'left'] as const).map((border) => (
                <button
                  key={border}
                  type="button"
                  aria-pressed={attrs.border === border}
                  className={attrs.border === border ? 'is-active' : ''}
                  onClick={() => update({ border })}
                >
                  {t(
                    `editorBlocks.border${border === 'none' ? 'None' : border === 'thin' ? 'Thin' : 'Left'}`,
                  )}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      {type === 'callout' && (
        <>
          <section className="block-setting-section">
            <span className="block-setting-label">{t('editorBlocks.icon')}</span>
            <div className="block-icon-options">
              <button
                type="button"
                className="icon-button"
                aria-label={t('editorBlocks.defaultIcon')}
                title={t('editorBlocks.defaultIcon')}
                onClick={() => update({ icon: null })}
              >
                <Info size={17} />
              </button>
              {BLOCK_ICONS.map(({ value, Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={`icon-button${attrs.icon === value ? ' is-active' : ''}`}
                  aria-label={t(
                    `editorBlocks.icon${value === 'info' ? 'Info' : value === 'lightbulb' ? 'Idea' : value === 'check' ? 'Check' : value === 'alert' ? 'Alert' : 'Help'}`,
                  )}
                  aria-pressed={attrs.icon === value}
                  onClick={() => update({ icon: value })}
                >
                  <Icon size={17} />
                </button>
              ))}
              <button
                type="button"
                className="icon-button"
                aria-label={t('editorBlocks.hideIcon')}
                title={t('editorBlocks.hideIcon')}
                aria-pressed={attrs.icon === 'none'}
                onClick={() => update({ icon: 'none' })}
              >
                <X size={17} />
              </button>
            </div>
          </section>
          <div className="block-setting-toggle">
            <span>{t('editorBlocks.showTitle')}</span>
            <Switch
              checked={attrs.showTitle ?? attrs.title !== null}
              label={t('editorBlocks.showTitle')}
              onChange={(checked) =>
                update({ showTitle: checked, ...(checked && attrs.title === null ? { title: '' } : {}) })
              }
            />
          </div>
          <div className="block-setting-toggle">
            <span>{t('editorBlocks.allowFold')}</span>
            <Switch
              checked={Boolean(attrs.fold)}
              label={t('editorBlocks.allowFold')}
              onChange={(checked) => update({ fold: checked ? '+' : null })}
            />
          </div>
        </>
      )}
      <button type="button" className="button small block-more" onClick={onMore}>
        <MoreHorizontal size={16} />
        {t('editorBlocks.moreActions')}
      </button>
    </Popover>
  );
}

/** 分栏面板内直接设置每栏的基础背景与边框，保留栏内全部内容。 */
function ColumnAppearance({ editor, pos, number }: { editor: Editor; pos: number; number: number }) {
  /** 对应栏的属性随编辑器事务更新。 */
  const node = useEditorState({ editor, selector: ({ editor: current }) => current.state.doc.nodeAt(pos) });
  if (node?.type.name !== 'column') return null;
  /** 更新特定栏，不影响相邻栏及比例。 */
  const update = (patch: Record<string, unknown>) =>
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }));
  return (
    <div className="block-column-setting">
      <span>{t('editorBlocks.columnNumber', { number })}</span>
      <select
        className="text-input small"
        aria-label={t('editorBlocks.columnBackground', { number })}
        value={node.attrs.background ?? ''}
        onChange={(event) => update({ background: event.target.value || null })}
      >
        <option value="">{t('editorBlocks.defaultColor')}</option>
        {COLORS.map((color) => (
          <option value={color} key={color}>
            {colorLabel(color)}
          </option>
        ))}
      </select>
      <select
        className="text-input small"
        aria-label={t('editorBlocks.columnBorder', { number })}
        value={node.attrs.border ?? ''}
        onChange={(event) => update({ border: event.target.value || null })}
      >
        <option value="">{t('editorBlocks.defaultColor')}</option>
        <option value="none">{t('editorBlocks.borderNone')}</option>
        <option value="thin">{t('editorBlocks.borderThin')}</option>
        <option value="left">{t('editorBlocks.borderLeft')}</option>
      </select>
    </div>
  );
}
