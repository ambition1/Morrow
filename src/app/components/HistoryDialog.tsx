import { generateHTML } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { History } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { countWords, docToPlainText } from '../../core/doc';
import { diffLines } from '../../core/diff';
import type { DiffLine } from '../../core/diff';
import { displayTitle } from '../i18n/labels';
import type { PageId, Snapshot } from '../../core/model';
import { createExtensions } from '../editor/extensions';
import { restoreVersion } from '../operations';
import { fileUrl } from '../platform/attachments';
import { closeDialog } from '../ui';
import { commitEditors } from '../editor/commits';
import { getSession, useWorkspace } from '../workspace';
import { Dialog } from './primitives';
import { dateLocale, t, tp } from '../i18n';

let previewExtensions: ReturnType<typeof createExtensions> | null = null;

// rendering needs the schema only, so the editor callbacks are inert here
function extensionsForPreview() {
  previewExtensions ??= createExtensions({
    getTitle: () => null,
    subscribe: () => () => {},
    open: () => {},
    findPages: () => [],
    createPage: () => null,
    onBlockMenu: () => {},
    resolvePage: () => null,
    resolveTarget: () => null,
    createFromTarget: () => null,
    openTag: () => {},
    createChild: () => null,
    renderEmbed: () => null,
    openDate: () => {},
  });
  return previewExtensions;
}

export function HistoryDialog({ pageId }: { pageId: PageId }) {
  /** 当前笔记状态与可恢复正文。 */
  const state = useWorkspace();
  /** 页面可能在历史对话框打开时被移除。 */
  const page = state.pages[pageId];
  /** 未加载、空列表与读取失败是三个不同状态。 */
  const [versions, setVersions] = useState<Snapshot[] | null>(null);
  /** 选中版本使用稳定ID，避免新增版本后选错条目。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 差异与原文预览仍复用现有实现。 */
  const [mode, setMode] = useState<'changes' | 'version'>('changes');
  /** 手动版本名称在保存失败时保留。 */
  const [name, setName] = useState('');
  /** 当前选中版本的待修改名称。 */
  const [rename, setRename] = useState<string | null>(null);
  /** 异步写入期间避免重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 错误不能伪装成空历史。 */
  const [error, setError] = useState(false);
  /** 预览容器负责加载本地附件。 */
  const previewRef = useRef<HTMLDivElement>(null);
  /** 防止对话框关闭后继续更新React状态。 */
  const mounted = useRef(true);
  /** 当前ID不在列表时，安全退回最新版本。 */
  const snapshot = versions?.find((version) => version.id === selectedId) ?? versions?.[0];
  /** 对比针对当前正文，恢复不修改页面属性。 */
  const current = state.docs[pageId];

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (page?.encrypted ? Promise.resolve([]) : getSession().listSnapshots(pageId))
      .then((list) => {
        if (!cancelled) {
          setVersions(list);
          setError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [pageId, page?.encrypted]);

  /** 未编辑名称时直接显示所选版本的持久化名称。 */
  const editName = rename ?? snapshot?.name ?? '';

  /** 读取成功后才替换列表，失败保留现有界面与输入。 */
  const refresh = async (id?: string) => {
    const list = await getSession().listSnapshots(pageId);
    if (!mounted.current) return;
    setVersions(list);
    setRename(null);
    if (id) setSelectedId(id);
  };
  /** 所有异步操作统一展示忙碌和失败状态。 */
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  /** 按时间之外的可选来源标识自动、手动或恢复前版本。 */
  const sourceLabel = (version: Snapshot) =>
    t(
      version.source === 'manual'
        ? 'history.manual'
        : version.source === 'restore'
          ? 'history.beforeRestore'
          : version.source === 'assistant'
            ? 'history.beforeAssistant'
            : 'history.automatic',
    );
  /** 提交活动编辑器后创建命名版本，成功后才清空输入。 */
  const save = () =>
    void perform(async () => {
      commitEditors();
      const saved = await getSession().saveVersion(pageId, name);
      await refresh(saved.id);
      if (mounted.current) setName('');
    });
  /** 修改元数据复用原版本，不复制正文或附件。 */
  const edit = (patch: { name?: string; pinned?: boolean }) => {
    if (!snapshot) return;
    void perform(async () => {
      await getSession().updateVersion(pageId, snapshot.id, patch);
      await refresh(snapshot.id);
    });
  };
  const changes = useMemo(
    () => (!snapshot || !current ? [] : diffLines(docToPlainText(snapshot.doc), docToPlainText(current))),
    [snapshot, current],
  );
  const html = useMemo(() => {
    if (!snapshot) return '';
    try {
      return generateHTML(snapshot.doc as JSONContent, extensionsForPreview());
    } catch {
      return '';
    }
  }, [snapshot]);
  useEffect(() => {
    let cancelled = false;
    for (const img of previewRef.current?.querySelectorAll<HTMLImageElement>('img[data-file-id]') ?? []) {
      void fileUrl(img.dataset.fileId ?? '')
        .then((url) => {
          if (url && !cancelled) img.src = url;
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [html]);
  if (!page) return null;
  return (
    <Dialog
      title={t('history.title', { title: displayTitle(page) })}
      size="large"
      className="history-dialog"
      onClose={() => {
        if (!busy) closeDialog();
      }}
    >
      <div className="history-controls">
        <p className="muted small">{page.encrypted ? t('history.encrypted') : t('history.policy')}</p>
        {!page.encrypted && (
          <form
            className="history-save-row"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <input
              className="text-input"
              aria-label={t('history.versionName')}
              placeholder={t('history.namePlaceholder')}
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="button primary" disabled={busy}>
              {t('history.saveVersion')}
            </button>
          </form>
        )}
        {error && (
          <div className="field-error history-error" role="alert">
            <span>{t('history.operationFailed')}</span>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => void perform(() => refresh())}
            >
              {t('history.retry')}
            </button>
          </div>
        )}
      </div>
      {versions === null ? (
        !error && <p className="muted">{t('history.loadingVersions')}</p>
      ) : versions.length === 0 ? (
        <div className="empty-state compact">
          <History size={24} strokeWidth={1.5} />
          <p>{page.encrypted ? t('history.encrypted') : t('history.empty')}</p>
        </div>
      ) : (
        <div className="history-layout" aria-busy={busy}>
          <ul className="history-list" aria-label={t('history.versions')}>
            {versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-current={version.id === snapshot?.id ? 'true' : undefined}
                  className={`history-item${version.id === snapshot?.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setSelectedId(version.id);
                    setRename(null);
                  }}
                >
                  <strong>{version.name || sourceLabel(version)}</strong>
                  <span>
                    {new Date(version.createdAt).toLocaleString(dateLocale(), {
                      dateStyle: 'medium',
                      timeStyle: 'medium',
                    })}
                  </span>
                  <span className="muted small">
                    {sourceLabel(version)} · {tp('history.words', countWords(docToPlainText(version.doc)))}
                    {version.pinned ? ` · ${t('history.kept')}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-preview">
            {snapshot && (
              <div className="history-version-tools">
                <input
                  className="text-input small"
                  aria-label={t('history.rename')}
                  placeholder={t('history.namePlaceholder')}
                  maxLength={120}
                  value={editName}
                  disabled={busy}
                  onChange={(event) => setRename(event.target.value)}
                />
                <button
                  type="button"
                  className="button small"
                  disabled={busy || editName.trim() === (snapshot.name ?? '')}
                  onClick={() => edit({ name: editName })}
                >
                  {t('history.rename')}
                </button>
                <button
                  type="button"
                  className="button small"
                  aria-pressed={!!snapshot.pinned}
                  disabled={busy}
                  onClick={() => edit({ pinned: !snapshot.pinned })}
                >
                  {snapshot.pinned ? t('history.unkeep') : t('history.keep')}
                </button>
              </div>
            )}
            <div className="segmented history-mode" role="radiogroup" aria-label={t('common.show')}>
              {(['changes', 'version'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  className={mode === value ? 'is-active' : ''}
                  onClick={() => setMode(value)}
                >
                  {value === 'changes' ? t('history.changesSince') : t('history.thatVersion')}
                </button>
              ))}
            </div>
            {mode === 'changes' && <p className="muted small">{t('history.diffHelp')}</p>}
            {mode === 'changes' ? (
              <DiffView lines={changes} />
            ) : html ? (
              <div
                ref={previewRef}
                onClick={(event) => event.preventDefault()}
                onAuxClick={(event) => event.preventDefault()}
                className="prose preview"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <p className="muted">{t('history.previewFailed')}</p>
            )}
            {snapshot && (
              <div className="history-actions">
                <span className="muted small">{t('history.restoreHelp')}</span>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (await restoreVersion(snapshot)) closeDialog();
                      else setError(true);
                    })
                  }
                >
                  {t('history.restoreThisVersion')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// shows removed lines in red and added lines in green, long unchanged stretches fold away
function DiffView({ lines }: { lines: DiffLine[] }) {
  if (lines.every((line) => line.kind === 'same'))
    return <p className="muted history-same">{t('history.sameAsNow')}</p>;
  const rows: Array<DiffLine | { kind: 'gap'; count: number }> = [];
  let run: DiffLine[] = [];
  const flush = (end: boolean) => {
    if (run.length > 6) {
      if (rows.length > 0) rows.push(...run.slice(0, 2));
      rows.push({ kind: 'gap', count: run.length - (rows.length > 0 ? 2 : 0) - (end ? 0 : 2) });
      if (!end) rows.push(...run.slice(-2));
    } else rows.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (line.kind === 'same') run.push(line);
    else {
      flush(false);
      rows.push(line);
    }
  }
  flush(true);
  return (
    <div className="diff" role="table" aria-label={t('settings.assistant.changesTitle')}>
      {rows.map((row, index) =>
        row.kind === 'gap' ? (
          <div key={index} className="diff-gap">
            {tp('history.unchangedLines', row.count)}
          </div>
        ) : (
          <div key={index} className={`diff-line diff-${row.kind}`}>
            <span className="diff-sign" aria-hidden="true">
              {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
            </span>
            <span className="visually-hidden">
              {row.kind === 'added' ? t('history.added') : row.kind === 'removed' ? t('history.removed') : ''}
            </span>
            {row.text || ' '}
          </div>
        ),
      )}
    </div>
  );
}
