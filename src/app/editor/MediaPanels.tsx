/**
 * 功能：提供图片设置、图册布局与图片放大的共用浮层。
 * 作者：xuanli
 * 创建时间：2026-10-30 00:06:22
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { Dialog, Switch } from '../components/primitives';
import { Popover } from '../components/Popover';
import { Select } from '../components/Select';
import { t } from '../i18n';
import { downloadFile, fileUrl } from '../platform/attachments';

/** 图片或图册可以保存的可选外观值。 */
export type MediaAttributes = Record<string, unknown>;
/** 放大视图使用的图片元数据。 */
export interface ViewerImage {
  /** 附件标识，优先从本地笔记库读取。 */
  fileId?: string | null;
  /** 经用户主动打开的远程图片地址。 */
  src?: string | null;
  /** 图片替代文字。 */
  alt?: string;
  /** 独立于替代文字的图片说明。 */
  caption?: string;
}

/** 将共用浮层挂到独立React根节点，关闭后释放事件和DOM。 */
function mountPanel(render: (close: () => void) => ReactNode): () => void {
  /** 浮层根节点不写入编辑器正文。 */
  const host = document.createElement('div');
  document.body.append(host);
  /** React根负责复用项目已有Dialog和Popover。 */
  const root = createRoot(host);
  /** 避免重复卸载已关闭的浮层。 */
  let closed = false;
  /** 下一微任务卸载，避免从React事件中同步卸载当前树。 */
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      root.unmount();
      host.remove();
    });
  };
  root.render(render(close));
  return close;
}

/** 打开图册布局浮层；每次选择只提交一次属性更新。 */
export function openGallerySettings(
  anchor: HTMLElement,
  attributes: MediaAttributes,
  change: (attributes: MediaAttributes) => void,
): () => void {
  return mountPanel((close) => (
    <GallerySettings anchor={anchor} attributes={attributes} change={change} close={close} />
  ));
}

/** 图册设置只在局部维护当前选择，正文仍由ProseMirror保存。 */
function GallerySettings({
  anchor,
  attributes,
  change,
  close,
}: {
  anchor: HTMLElement;
  attributes: MediaAttributes;
  change: (attributes: MediaAttributes) => void;
  close: () => void;
}) {
  /** 正在显示的布局值。 */
  const [values, setValues] = useState(attributes);
  /** 合并一次布局选择并通知节点。 */
  const update = (patch: MediaAttributes) => {
    setValues((current) => ({ ...current, ...patch }));
    change(patch);
  };
  return (
    <Popover
      anchor={anchor}
      onClose={close}
      label={t('mediaBlocks.gallerySettings')}
      className="media-settings-panel"
    >
      <strong>{t('mediaBlocks.gallerySettings')}</strong>
      <div className="field">
        <span>{t('mediaBlocks.gallerySettings')}</span>
        <Select
          value={String(values.layout ?? 'grid')}
          label={t('mediaBlocks.gallerySettings')}
          options={['grid', 'masonry', 'carousel'].map((value) => ({
            value,
            label: t(`mediaBlocks.${value}` as 'mediaBlocks.grid'),
          }))}
          onChange={(layout) => update({ layout })}
        />
      </div>
      <div className="field">
        <span>{t('mediaBlocks.columns')}</span>
        <div className="segmented" role="group" aria-label={t('mediaBlocks.columns')}>
          {[2, 3, 4].map((columns) => (
            <button
              type="button"
              key={columns}
              aria-pressed={Number(values.columns ?? 3) === columns}
              className={Number(values.columns ?? 3) === columns ? 'is-active' : ''}
              onClick={() => update({ columns })}
            >
              {columns}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{t('mediaBlocks.gap')}</span>
        <Select
          value={String(values.gap ?? 'normal')}
          label={t('mediaBlocks.gap')}
          options={['compact', 'normal', 'wide'].map((value) => ({
            value,
            label: t(`mediaBlocks.${value}` as 'mediaBlocks.normal'),
          }))}
          onChange={(gap) => update({ gap })}
        />
      </div>
      <div className="media-setting-switch">
        <span>{t('mediaBlocks.originalRatio')}</span>
        <Switch
          label={t('mediaBlocks.originalRatio')}
          checked={values.originalRatio === true}
          onChange={(originalRatio) => update({ originalRatio })}
        />
      </div>
    </Popover>
  );
}

/** 打开单图属性面板；保存之前不改变正文或制造多条历史。 */
export function openImageSettings(
  attributes: MediaAttributes,
  save: (attributes: MediaAttributes) => void,
  actions: Array<{ label: string; run: () => void }> = [],
): () => void {
  return mountPanel((close) => (
    <ImageSettings attributes={attributes} save={save} actions={actions} close={close} />
  ));
}

/** 单图的说明、替代文本、宽度和对齐设置。 */
function ImageSettings({
  attributes,
  save,
  actions,
  close,
}: {
  attributes: MediaAttributes;
  save: (attributes: MediaAttributes) => void;
  actions: Array<{ label: string; run: () => void }>;
  close: () => void;
}) {
  /** 当前尚未提交的图片设置。 */
  const [values, setValues] = useState(attributes);
  /** 更新草稿中的单个字段。 */
  const update = (patch: MediaAttributes) => setValues((current) => ({ ...current, ...patch }));
  return (
    <Dialog
      title={t('mediaBlocks.imageSettings')}
      onClose={close}
      size="small"
      footer={
        <button
          type="button"
          className="button primary"
          onClick={() => {
            save(values);
            close();
          }}
        >
          {t('mediaBlocks.save')}
        </button>
      }
    >
      <div className="media-image-fields">
        {actions.length > 0 && (
          <div className="media-image-actions">
            {actions.map((action) => (
              <button
                type="button"
                className="button small"
                key={action.label}
                onClick={() => {
                  close();
                  action.run();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
        <label className="field">
          <span>{t('mediaBlocks.imageCaption')}</span>
          <input
            className="text-input"
            value={String(values.caption ?? '')}
            onChange={(event) => update({ caption: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{t('mediaBlocks.alt')}</span>
          <input
            className="text-input"
            value={String(values.alt ?? '')}
            onChange={(event) => update({ alt: event.target.value })}
          />
        </label>
        <label className="field">
          <span>
            {t('mediaBlocks.width')} · {Number(values.width ?? 100)}%
          </span>
          <input
            type="range"
            min="10"
            max="100"
            step="5"
            value={Number(values.width ?? 100)}
            onChange={(event) => update({ width: Number(event.target.value) })}
          />
        </label>
        <div className="field">
          <span>{t('mediaBlocks.align')}</span>
          <Select
            label={t('mediaBlocks.align')}
            value={String(values.align ?? 'center')}
            options={['left', 'center', 'right'].map((value) => ({
              value,
              label: t(`mediaBlocks.${value}` as 'mediaBlocks.center'),
            }))}
            onChange={(align) => update({ align })}
          />
        </div>
      </div>
    </Dialog>
  );
}

/** 放大一组图片，支持键盘与前后按钮，不自动轮播。 */
export function openImageViewer(items: ViewerImage[], start: number): () => void {
  return mountPanel((close) => <ImageViewer items={items} start={start} close={close} />);
}

/** 放大弹窗通过既有附件缓存读取图片，关闭后释放监听。 */
function ImageViewer({ items, start, close }: { items: ViewerImage[]; start: number; close: () => void }) {
  /** 当前图片索引只在当前弹窗内变化。 */
  const [index, setIndex] = useState(Math.max(0, Math.min(start, items.length - 1)));
  /** 当前已读取的图片地址。 */
  const [loaded, setLoaded] = useState<{ for: ViewerImage | undefined; url: string | null; failed: boolean }>(
    { for: undefined, url: null, failed: false },
  );
  /** 当前图片保存的信息。 */
  const current = items[index];
  /** 切换索引立即呈现加载状态，不在effect内同步更新状态。 */
  const url = loaded.for === current ? loaded.url : null;
  /** 只有当前图片的请求结果决定错误提示。 */
  const failed = loaded.for === current && loaded.failed;
  useEffect(() => {
    /** 已关闭或切换图片时不更新旧请求结果。 */
    let live = true;
    const loading = current?.fileId
      ? fileUrl(current.fileId)
      : Promise.resolve(/^https:\/\//i.test(current?.src ?? '') ? current!.src! : null);
    void loading.then((next) => {
      if (live) {
        setLoaded({ for: current, url: next, failed: !next });
      }
    });
    return () => {
      live = false;
    };
  }, [current]);
  useEffect(() => {
    /** 左右箭头只在图片弹窗中切换，不触发编辑器移动。 */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setIndex((value) =>
        Math.max(0, Math.min(items.length - 1, value + (event.key === 'ArrowRight' ? 1 : -1))),
      );
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items.length]);
  return (
    <Dialog
      title={current?.caption || current?.alt || t('mediaBlocks.preview')}
      onClose={close}
      size="large"
      className="media-viewer"
      footer={
        <>
          <button type="button" className="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            <ChevronLeft size={15} />
            {t('mediaBlocks.previous')}
          </button>
          <span className="media-viewer-count">
            {t('mediaBlocks.countOf', { index: index + 1, count: items.length })}
          </span>
          <button
            type="button"
            className="button"
            disabled={index >= items.length - 1}
            onClick={() => setIndex(index + 1)}
          >
            {t('mediaBlocks.next')}
            <ChevronRight size={15} />
          </button>
          {current?.fileId && (
            <button type="button" className="button" onClick={() => void downloadFile(current.fileId!)}>
              <Download size={15} />
              {t('mediaBlocks.download')}
            </button>
          )}
        </>
      }
    >
      <div className="media-viewer-image">
        {failed ? (
          <p>{t('mediaBlocks.missing')}</p>
        ) : url ? (
          <img
            src={url}
            alt={current?.alt ?? ''}
            onError={() => setLoaded({ for: current, url: null, failed: true })}
          />
        ) : (
          <p>{t('mediaBlocks.uploading')}</p>
        )}
      </div>
      {current?.caption && <p className="media-viewer-caption">{current.caption}</p>}
    </Dialog>
  );
}
