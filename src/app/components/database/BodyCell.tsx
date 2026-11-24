/**
 * 功能：在数据库表格中预览和编辑行文档正文。
 * 作者：xuanli
 * 创建时间：2026-11-24 12:05:22
 */
import { useMemo, useState } from 'react';
import { docToPlainText, findUnknownTypes, isDocEmpty } from '../../../core/doc';
import { emptyDoc } from '../../../core/model';
import type { PageMeta } from '../../../core/model';
import { commitEditors } from '../../editor/commits';
import { PageEditor } from '../../editor/PageEditor';
import { t } from '../../i18n';
import { displayTitle } from '../../i18n/labels';
import { getSession, useWorkspace } from '../../workspace';
import { Popover } from '../Popover';

// 空白行共用稳定的正文引用，避免浮层输入中重置编辑器。
const EMPTY_BODY = emptyDoc();

/** 正文列使用现有富文本编辑器，格式、链接及附件随行文档保存。 */
export function BodyCell({ row, editable }: { row: PageMeta; editable: boolean }) {
  // 正文和加密状态跟随工作区更新。
  const state = useWorkspace();
  // 正文直接来自文档存储。
  const doc = state.docs[row.id] ?? EMPTY_BODY;
  // 保留富文本原状，表格只显示其纯文本摘要。
  const preview = useMemo(() => docToPlainText(doc).replace(/\s+/g, ' ').trim(), [doc]);
  // 未来版本中的节点由完整页面的只读界面展示。
  const supported = useMemo(() => findUnknownTypes(doc).length === 0, [doc]);
  // 锁定文档只显示不可读取状态。
  const unreadable = getSession().unreadable.has(row.id);
  // 画布内容由画布编辑器保存，避免用富文本改写画布节点。
  const isCanvas = row.kind === 'canvas';
  // 仅在能够读取和编辑行正文时开放浮层。
  const canEdit = editable && supported && !unreadable && !isCanvas;
  // 使用预览单元格作为浮层锚点。
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 可访问名称附上记录名，便于从多个正文单元格中定位。
  const label = t('database.editBody', { title: displayTitle(row) });
  return (
    <>
      <button
        type="button"
        className="db-cell-display db-body-preview"
        aria-label={canEdit ? label : undefined}
        aria-haspopup={canEdit ? 'dialog' : undefined}
        aria-expanded={canEdit ? Boolean(anchor) : undefined}
        disabled={!canEdit}
        onClick={(event) => {
          commitEditors();
          setAnchor(event.currentTarget);
        }}
      >
        <span className="prop-text">
          {unreadable
            ? t('page.contentUnreadable')
            : isCanvas
              ? t('sidebar.canvas')
              : preview || (isDocEmpty(doc) ? t('database.empty') : t('database.bodyColumn'))}
        </span>
      </button>
      {anchor && canEdit && (
        <Popover
          anchor={anchor}
          label={label}
          onClose={() => setAnchor(null)}
          className="db-body-popover"
          fitViewport
        >
          <div className="db-body-editor">
            <PageEditor
              pageId={row.id}
              doc={doc}
              editable
              find={null}
              onDirty={() => undefined}
              onExitTop={() => anchor.focus({ preventScroll: true })}
              onReady={(editor) => {
                // 等编辑器挂载后定位光标，便于直接开始输入。
                requestAnimationFrame(() => {
                  if (!editor.isDestroyed && anchor.isConnected) editor.commands.focus('end');
                });
              }}
            />
          </div>
          <div className="popover-actions">
            <button
              type="button"
              className="button small"
              onClick={() => {
                commitEditors();
                setAnchor(null);
                anchor.focus({ preventScroll: true });
              }}
            >
              {t('inlineDate.done')}
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
