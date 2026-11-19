/**
 * 功能：展示服务器和本机正文的差异，支持逐段选择与 Markdown 手工合并。
 * 作者：xuanli
 * 创建时间：2026-11-19 13:59:40
 */
import { useMemo, useState } from 'react';
import { mergeRecoveryDiff, recoveryDiff } from '../../core/recoveryDiff';
import type { RecoveryChoice } from '../../core/recoveryDiff';
import { useTranslation } from '../i18n';

/** 比对文本由恢复窗口的精确版本提供，写入仍由恢复窗口校验。 */
interface DifferenceProps {
  server: string;
  local: string;
  disabled: boolean;
  onSave: (text: string) => void;
}

/** 大段保留完整预览，仅限制差异面板逐行渲染。 */
const MAX_VISIBLE_LINES = 80;

/** 每段差异由独立选择控制，未选择完毕时保留预览但禁止逐段提交。 */
export function RecoveryDifference({ server, local, disabled, onSave }: DifferenceProps) {
  /** 多语言状态、来源和动作名称。 */
  const { t } = useTranslation();
  /** 每个来源选择只属于当前对比的文件版本。 */
  const [choices, setChoices] = useState<Partial<Record<number, RecoveryChoice>>>({});
  /** 手工编辑与根据选项生成的预览互相独立。 */
  const [manual, setManual] = useState<string | null>(null);
  /** 仅在任一版本变化时重新计算差异。 */
  const segments = useMemo(() => recoveryDiff(server, local), [server, local]);
  /** 表单只列出含有新增或删除的段。 */
  const changes = segments.filter((segment) => segment.kind === 'change');
  /** 预览不包含视觉上的加减号和行号。 */
  const merged = mergeRecoveryDiff(segments, choices);
  /** 未选择的差异段不会被默认提交。 */
  const remaining = changes.filter(({ id }) => !choices[id]).length;
  /** 单选按钮由组标题与各自的来源文案提供可访问名称。 */
  const options = [
    { value: 'server', label: t('reliability.chooseServer') },
    { value: 'local', label: t('reliability.chooseLocal') },
    { value: 'both', label: t('reliability.chooseBoth') },
  ] as const;

  return (
    <>
      <h3>{t('reliability.diffTitle')}</h3>
      {!changes.length && <p className="muted">{t('reliability.noDiff')}</p>}
      {changes.map((change, index) => (
        <fieldset className="recovery-hunk" key={change.id} disabled={disabled || manual !== null}>
          <legend>{t('reliability.diffHunk', { number: index + 1 })}</legend>
          <div className="recovery-compare">
            <div className="recovery-diff-side">
              <div className="muted small">{t('reliability.server')}</div>
              {change.server.length ? (
                <pre
                  className="recovery-diff-lines is-removed"
                  tabIndex={0}
                  aria-label={t('reliability.server')}
                >
                  {change.server.slice(0, MAX_VISIBLE_LINES).map((line, offset) => (
                    <span key={offset}>
                      <span aria-hidden="true">− {change.serverLine + offset}</span>
                      {line.replace(/\n$/, '')}
                    </span>
                  ))}
                </pre>
              ) : (
                <p className="muted small">{t('reliability.noLines')}</p>
              )}
            </div>
            <div className="recovery-diff-side">
              <div className="muted small">{t('reliability.local')}</div>
              {change.local.length ? (
                <pre
                  className="recovery-diff-lines is-added"
                  tabIndex={0}
                  aria-label={t('reliability.local')}
                >
                  {change.local.slice(0, MAX_VISIBLE_LINES).map((line, offset) => (
                    <span key={offset}>
                      <span aria-hidden="true">+ {change.localLine + offset}</span>
                      {line.replace(/\n$/, '')}
                    </span>
                  ))}
                </pre>
              ) : (
                <p className="muted small">{t('reliability.noLines')}</p>
              )}
            </div>
          </div>
          {(change.server.length > MAX_VISIBLE_LINES || change.local.length > MAX_VISIBLE_LINES) && (
            <p className="muted small">{t('reliability.diffTruncated')}</p>
          )}
          <div className="recovery-diff-options">
            {options.map(({ value, label }) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`recovery-diff-${change.id}`}
                  checked={choices[change.id] === value}
                  onChange={() => setChoices((current) => ({ ...current, [change.id]: value }))}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <label className="field">
        <span>{t(manual === null ? 'reliability.mergePreview' : 'reliability.merge')}</span>
        <textarea
          className="text-input"
          rows={5}
          readOnly={manual === null}
          disabled={manual !== null && disabled}
          value={manual ?? merged}
          onChange={(event) => setManual(event.target.value)}
        />
      </label>
      <div className="button-row">
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={() => setManual(manual === null ? merged : null)}
        >
          {t(manual === null ? 'reliability.editMerge' : 'reliability.backToChoices')}
        </button>
        <button
          className="button primary"
          type="button"
          disabled={disabled || (manual === null && remaining > 0)}
          onClick={() => onSave(manual ?? merged)}
        >
          {t('reliability.saveMerge')}
        </button>
      </div>
      {manual === null && remaining > 0 && (
        <p className="muted small" role="status">
          {t('reliability.chooseRemaining', { count: remaining })}
        </p>
      )}
    </>
  );
}
