import { RotateCcw, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { displayTitle } from '../i18n/labels';
import type { PageId, WorkspaceState } from '../../core/model';
import { ancestorsOf, trashedPages } from '../../core/tree';
import { deleteForever, emptyTrash, restorePage } from '../operations';
import { openPage } from '../router';
import { useWorkspace } from '../workspace';
import { relativeTime, useShowMore } from './primitives';
import { PageIcon } from './Sidebar';
import { TopBar } from './TopBar';
import { t } from '../i18n';

function pathOf(state: WorkspaceState, id: PageId): string {
  return ancestorsOf(state.pages, id)
    .reverse()
    .map((page) => displayTitle(page))
    .join(' / ');
}

export function TrashView() {
  const state = useWorkspace();
  const trashed = useMemo(() => trashedPages(state.pages), [state.pages]);
  const listed = useShowMore(trashed, 60);

  return (
    <div className="view collection-view trash-view">
      <TopBar>
        <span className="topbar-title">{t('trash.title')}</span>
      </TopBar>
      <div className="page-scroll">
        <div className="collection">
          <header className="collection-header">
            <span className="collection-symbol" aria-hidden="true">
              <Trash2 size={22} strokeWidth={1.5} />
            </span>
            <h1>{t('trash.title')}</h1>
            <p className="muted">{t('trash.subtitle')}</p>
            {trashed.length > 0 && (
              <button type="button" className="button danger" onClick={() => emptyTrash(trashed.length)}>
                <Trash2 size={15} /> {t('trash.emptyTrashButton')}
              </button>
            )}
          </header>
          {trashed.length === 0 ? (
            <div className="empty-state compact">
              <Trash2 size={24} strokeWidth={1.5} />
              <p>{t('trash.emptyMessage')}</p>
            </div>
          ) : (
            <>
              <ul className="link-list">
                {listed.shown.map((page) => {
                  const path = pathOf(state, page.id);
                  return (
                    <li key={page.id} className="trash-row">
                      <button type="button" className="link-row" onClick={() => openPage(page.id)}>
                        <span className="tree-icon">
                          <PageIcon page={page} />
                        </span>
                        <span className="link-row-title">
                          {displayTitle(page)}
                          {path && <span className="link-row-path">{t('trash.inPath', { path })}</span>}
                        </span>
                        <span className="link-row-meta">
                          {t('trash.trashedAt', { time: relativeTime(page.trashedAt ?? 0) })}
                        </span>
                      </button>
                      <div className="row-actions">
                        <button type="button" className="button small" onClick={() => restorePage(page.id)}>
                          <RotateCcw size={14} /> {t('trash.restore')}
                        </button>
                        <button
                          type="button"
                          className="button small danger"
                          onClick={() => deleteForever(page.id)}
                        >
                          {t('trash.deleteForever')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {listed.more}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
