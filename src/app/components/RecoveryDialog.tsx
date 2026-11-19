/**
 * 功能：对比本机草稿与最新服务器正文，提供副本、手动合并和安全刷新。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:44:39
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkspaceState } from '../../core/model';
import { draftMarkdown, parseDraftMarkdown } from '../../core/recoveryMarkdown';
import { VaultRepository } from '../../storage/vaultRepository';
import type { WebDraft } from '../../storage/webDrafts';
import { webVaultBridge } from '../platform/webVault';
import { webRecovery } from '../platform/webRecovery';
import { newId } from '../platform/files';
import { getSession, useSaveStatus, useWorkspace } from '../workspace';
import { closeDialog, setUi } from '../ui';
import { useTranslation } from '../i18n';
import { commitEditors } from '../editor/commits';
import { localizeError } from '../i18n/errors';
import { Select } from './Select';
import { displayTitle } from '../i18n/labels';
import { RecoveryDifference } from './RecoveryDifference';
import { Dialog } from './primitives';

/** 使用既有对话框与表单样式，原始 Markdown 可复制，不执行草稿中的内容。 */
export function RecoveryDialog({ pageId }: { pageId?: string }) {
  /** 当前 Web 工作区恢复协调器。 */
  const recovery = webRecovery;
  if (!recovery) return null;
  return <RecoveryContents recovery={recovery} pageId={pageId} />;
}

/** 内部组件只在 Web 协调器存在时挂载，保证 Hook 顺序稳定。 */
function RecoveryContents({
  recovery,
  pageId,
}: {
  recovery: NonNullable<typeof webRecovery>;
  pageId?: string;
}) {
  /** 翻译器与本机保护状态。 */
  const { t } = useTranslation();
  /** 当前页的名称来自本机镜像，删除后仍可使用草稿标题。 */
  const workspace = useWorkspace();
  /** 草稿列表随本机事务更新。 */
  const status = useSyncExternalStore(recovery.subscribe, recovery.getStatus);
  /** 选定记录采用独立的标签身份和页面身份。 */
  const [selected, setSelected] = useState('');
  /** 最新服务器内容由独立只读仓库读取，不推进原桥接版本。 */
  const [server, setServer] = useState<WorkspaceState | null>(null);
  /** 内容读取时的服务器版本。 */
  const [revision, setRevision] = useState('');
  /** 历史快照请求也可能先于保存队列发现远端已更新。 */
  const [staleComparison, setStaleComparison] = useState(false);
  /** 所有异步动作共用忙碌状态。 */
  const [busy, setBusy] = useState(false);
  /** 失败保留草稿和合并输入。 */
  const [error, setError] = useState('');
  /** 页面入口只列出本页草稿，整库入口仍能找回其他页面。 */
  const drafts = pageId ? status.drafts.filter((item) => item.pageId === pageId) : status.drafts;
  /** 当前选中草稿，不依赖列表下标。 */
  const draft = drafts.find((item) => `${item.owner}/${item.pageId}` === selected) ?? drafts[0];
  /** 标题优先显示页面的当前名称。 */
  const page = pageId ? (workspace.pages[pageId] ?? draft?.page) : undefined;
  /** 保存队列冲突期间先刷新，避免用户输入的合并文本被刷新丢弃。 */
  const saveStatus = useSaveStatus();
  /** 内容读取期间不允许恢复或清理。 */
  const ready = Boolean(server && revision === recovery.getRevision());

  /** 当前会话能够以对比中的版本写回。 */
  const canRestore = ready && !staleComparison && saveStatus.state !== 'conflict';

  useEffect(() => {
    /** 关闭浮层后不发布异步读取结果。 */
    let cancelled = false;
    /** 独立桥接只读取服务端，不改变当前待保存正文。 */
    const bridge = webVaultBridge();
    /** 解析复用原有文件兼容规则。 */
    const repository = new VaultRepository(bridge, newId);
    void recovery
      .refresh()
      .then(() => repository.load())
      .then((loaded) => {
        if (!loaded.ok) throw new Error(loaded.error);
        if (!cancelled) {
          setServer({
            pages: Object.fromEntries(loaded.value.pages.map((page) => [page.id, page])),
            docs: loaded.value.docs,
          });
          setRevision(bridge.getRevision());
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(String(failure));
      });
    return () => {
      cancelled = true;
      repository.close();
    };
  }, [recovery]);

  /** 两侧正文必须都可读，缺失页面时仍能下载和另存草稿。 */
  const serverDoc = draft && server?.docs[draft.pageId];
  /** 合并只写当前可编辑页面，不恢复已删除或加密内容。 */
  const target = draft && server?.pages[draft.pageId];
  /** 使用原始正文支持整页替换，逐段选择才经过 Markdown 转换。 */
  const allowMerge = Boolean(
    canRestore && !busy && serverDoc && target?.trashedAt === null && !target.encrypted,
  );

  /** 确认所有内存编辑都已落到本机，再重新加载服务器；失败禁止刷新。 */
  const reload = async () => {
    setBusy(true);
    setError('');
    try {
      commitEditors();
      await recovery.prepareReload();
      if (recovery.getStatus().error || recovery.getStatus().pending)
        throw new Error(t('reliability.localUnavailable'));
      window.location.reload();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  /** 服务器确认副本或合并落盘之后，才清除被恢复的旧草稿。 */
  const restore = async (item: WebDraft, copy: boolean, text?: string) => {
    setBusy(true);
    setError('');
    try {
      commitEditors();
      /** 冲突队列必须先刷新，不能用重试绕过版本校验。 */
      const session = getSession();
      if (!canRestore || session.queue.status.state === 'conflict')
        throw new Error(t('reliability.refreshFirst'));
      /** 恢复副本默认放在根目录，避免已删除父页面导致不可达。 */
      const id = copy ? newId() : item.pageId;
      /** 确认对比的仍是可写的页面，保存期间的其他编辑不会被覆盖。 */
      if (!copy && (!allowMerge || !session.queue.isIdle())) throw new Error(t('reliability.refreshFirst'));
      /** 保留完整来源的结构化内容，只有混合结果需要解析 Markdown。 */
      const doc =
        text === undefined || text === draftMarkdown(item.doc)
          ? item.doc
          : serverDoc && text === draftMarkdown(serverDoc)
            ? serverDoc
            : parseDraftMarkdown(
                text,
                serverDoc ? [item.doc, serverDoc] : [item.doc],
                session.getState().pages,
              );
      if (!copy) {
        /** 当前服务器正文先保存保留版本，手动合并也能撤回。 */
        await session.saveVersion(id, t('reliability.beforeMerge'));
      }
      /** 所有恢复仍走普通命令和服务器校验。 */
      const result = copy
        ? session.execute({
            type: 'page.create',
            id,
            parentId: null,
            now: Date.now(),
            title: `${item.page.title} ${t('reliability.copySuffix')}`,
            doc,
            tags: item.page.tags,
          })
        : session.execute({ type: 'page.setDoc', id, doc, now: Date.now() });
      if (!result.ok) throw new Error(result.error);
      if (!(await session.flush())) throw new Error(t('reliability.saveFailed'));
      await recovery.dismiss(item);
      setRevision(recovery.getRevision());
      setServer(session.getState());
    } catch (failure) {
      if ((failure as { status?: number }).status === 409) setStaleComparison(true);
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  /** 下载保留可读正文，存储不可用或持续冲突时仍可取出内容。 */
  const download = (item: WebDraft) => {
    /** 浏览器下载 URL 在点击后释放。 */
    const url = URL.createObjectURL(
      new Blob([draftMarkdown(item.doc)], { type: 'text/markdown;charset=utf-8' }),
    );
    /** 下载文件名不允许路径分隔符。 */
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.page.title.replace(/[\\/]/g, '-') || 'draft'}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Dialog
      title={page ? t('reliability.pageTitle', { title: displayTitle(page) }) : t('reliability.title')}
      size="large"
      className="recovery-dialog"
      onClose={() => {
        if (!busy) closeDialog();
      }}
    >
      <p className="muted small">{t('reliability.explanation')}</p>
      {pageId && (
        <div className="button-row">
          <button
            type="button"
            className="button small"
            onClick={() => setUi({ dialog: { kind: 'recovery' } })}
          >
            {t('reliability.reviewAll')}
          </button>
        </div>
      )}
      {(error || status.error) && (
        <p className="field-error" role="alert">
          {error ? localizeError(error) : t('reliability.localUnavailable')}
        </p>
      )}
      {Boolean(server) && !canRestore && (
        <div className="field">
          <p>{t('reliability.refreshFirst')}</p>
          <button type="button" className="button primary" disabled={busy} onClick={() => void reload()}>
            {t('reliability.reload')}
          </button>
        </div>
      )}
      {drafts.length ? (
        <>
          <label className="field">
            <span>{t('reliability.drafts')}</span>
            <Select
              label={t('reliability.drafts')}
              disabled={busy}
              value={draft ? `${draft.owner}/${draft.pageId}` : ''}
              onChange={setSelected}
              options={drafts.map((item) => ({
                value: `${item.owner}/${item.pageId}`,
                label: `${pageId ? '' : `${displayTitle(item.page)} · `}${t(
                  recovery.ownsDraft(item) ? 'reliability.thisTab' : 'reliability.otherTab',
                )} · ${new Date(item.updatedAt).toLocaleString()}`,
              }))}
            />
          </label>
          {draft && (
            <>
              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  disabled={!allowMerge || saveStatus.state !== 'saved'}
                  onClick={() =>
                    void recovery.dismiss(draft).catch((failure: unknown) => setError(String(failure)))
                  }
                >
                  {t('reliability.useServer')}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!allowMerge || saveStatus.state !== 'saved'}
                  onClick={() => void restore(draft, false)}
                >
                  {t('reliability.useLocal')}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !canRestore}
                  onClick={() => void restore(draft, true)}
                >
                  {t('reliability.keepCopy')}
                </button>
                <button type="button" className="button" disabled={busy} onClick={() => download(draft)}>
                  {t('reliability.download')}
                </button>
              </div>
              {serverDoc ? (
                <RecoveryDifference
                  key={`${draft.owner}/${draft.pageId}/${draft.sequence}/${revision}`}
                  server={draftMarkdown(serverDoc)}
                  local={draftMarkdown(draft.doc)}
                  disabled={!allowMerge || saveStatus.state !== 'saved'}
                  onSave={(text) => void restore(draft, false, text)}
                />
              ) : (
                <>
                  {server && <p className="muted">{t('reliability.missing')}</p>}
                  <label className="field">
                    <span>{t('reliability.local')}</span>
                    <textarea className="text-input" readOnly rows={5} value={draftMarkdown(draft.doc)} />
                  </label>
                </>
              )}
            </>
          )}
        </>
      ) : (
        <p className="muted">{t(pageId ? 'reliability.emptyPage' : 'reliability.empty')}</p>
      )}
    </Dialog>
  );
}
