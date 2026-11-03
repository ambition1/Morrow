/**
 * 功能：提供可边看边记的侧边、内嵌与大窗附件预览宿主。
 * 作者：xuanli
 * 创建时间：2026-11-03 12:06:09
 */
import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { FileViewerHandle, ViewerViewState } from '@file-viewer/react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { Dialog } from '../components/primitives';
import { Select } from '../components/Select';
import { useTranslation } from '../i18n';
import { downloadFile } from '../platform/attachments';
import { getSession } from '../workspace';
import { closePreview, setPreviewMode, usePreview } from './state';
import type { PreviewRequest } from './state';
import { hasPreviewSignature } from './formats';

/** 每次显式重试创建新的惰性类型；普通渲染与布局切换保持原实例。 */
function createViewerComponent() {
  return lazy(() => import('./Viewer'));
}

/** 渲染错误限定在附件内部，不影响正文编辑。 */
class PreviewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  /** 当前附件渲染是否失败。 */
  override state = { failed: false };
  /** 异常进入局部回退界面。 */
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /** 错误时继续提供外层下载、关闭与重试。 */
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** 应用级预览宿主，模式变化不卸载正文编辑器。 */
export function FilePreview() {
  /** 当前请求由正文或白板的附件入口发布。 */
  const request = usePreview();
  /** 侧边占工作区比例，仅修改阅读布局。 */
  const [share, setShare] = useState(45);
  /** 拖动时记录指针起点及可用宽度，避免遗留全局事件。 */
  const drag = useRef<{ x: number; share: number; width: number } | null>(null);
  /** 共享语言提供控件名称。 */
  const { t } = useTranslation();
  /** 固定 portal 目标，切换布局只搬动容器，保留解析结果、页码与缩放。 */
  const [mount] = useState(() => {
    /** 该容器由 React portal 持有内容，外层布局仅移动它。 */
    const element = document.createElement('div');
    element.className = 'file-preview-mount';
    return element;
  });
  /** 在新布局提交时搬动同一个预览根，不重新挂载引擎。 */
  const place = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) element.append(mount);
      else mount.remove();
    },
    [mount],
  );
  if (!request) return null;
  /** 预览内容始终位于同一 portal 分支。 */
  const content = createPortal(
    <PreviewPanel key={`${request.id}:${request.name}`} request={request} />,
    mount,
  );
  /** 各种布局的挂载槽，不负责创建预览内容。 */
  const slot = <div className="file-preview-slot" ref={place} />;
  if (request.mode === 'window') {
    return (
      <>
        {content}
        <Dialog
          title={request.name}
          onClose={() => closePreview()}
          size="large"
          className="file-preview-dialog"
        >
          {slot}
        </Dialog>
      </>
    );
  }
  if (request.mode === 'inline' && request.host?.isConnected)
    return (
      <>
        {content}
        {createPortal(slot, request.host)}
      </>
    );
  return (
    <>
      {content}
      <aside
        className="file-preview-side"
        style={{ '--preview-share': `${share}%` } as CSSProperties}
        aria-label={t('filePreview.side')}
      >
        <div
          className="file-preview-resizer"
          role="separator"
          tabIndex={0}
          aria-label={t('filePreview.resize')}
          aria-orientation="vertical"
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={share}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setShare((value) => Math.max(30, Math.min(70, value + (event.key === 'ArrowLeft' ? 5 : -5))));
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              share,
              width: event.currentTarget.parentElement!.parentElement!.clientWidth,
            };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setShare(
              Math.max(
                30,
                Math.min(
                  70,
                  drag.current.share - ((event.clientX - drag.current.x) / drag.current.width) * 100,
                ),
              ),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            if (drag.current) setShare(drag.current.share);
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
        {slot}
      </aside>
    </>
  );
}

/** 单文件读取与预览，异步结果不得覆盖后来打开的附件。 */
function PreviewPanel({ request }: { request: PreviewRequest }) {
  /** 引擎公开控制器仅用于保存和恢复阅读位置。 */
  const controller = useRef<FileViewerHandle | null>(null);
  /** 切换布局前保存文档页码、缩放与锚点。 */
  const savedView = useRef<ViewerViewState | null>(null);
  useEffect(() => {
    /** 等新容器及引擎 ResizeObserver 完成适配后恢复阅读位置。 */
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (savedView.current) {
          void controller.current?.applyViewState(savedView.current);
          savedView.current = null;
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [request.mode]);
  /** 内嵌高度通过模式切换保存，避免浏览器 resize 的行内高度污染侧边布局。 */
  const [inlineHeight, setInlineHeight] = useState(420);
  /** 实际面板用于读取用户拖动后的高度。 */
  const panel = useRef<HTMLElement | null>(null);
  /** 当前文件载入结果。 */
  const [file, setFile] = useState<File | null>(null);
  /** 读取失败时保留原文件下载。 */
  const [failed, setFailed] = useState(false);
  /** 解析失败的稳定回调，避免引擎因回调引用变化重新加载。 */
  const onFailure = useCallback(() => setFailed(true), []);
  /** 重试世代同时重置局部异常边界。 */
  const [attempt, setAttempt] = useState(0);
  /** 重试生成新的惰性组件类型，避免 React 缓存首次网络加载失败。 */
  const [Viewer, setViewer] = useState(createViewerComponent);
  /** 所有可见操作跟随应用语言。 */
  const { t } = useTranslation();
  useEffect(() => {
    /** 清理后忽略迟到结果，释放原文件引用。 */
    let live = true;
    void getSession()
      .getFile(request.id)
      .then((stored) => {
        if (!live) return;
        if (!stored || !hasPreviewSignature(request.name, stored.data)) {
          setFailed(true);
          return;
        }
        setFile(new File([stored.data], request.name, { type: stored.meta.type }));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [request.id, request.name, attempt]);
  /** 读取或引擎失败共用可恢复提示。 */
  const fallback = (
    <div className="file-preview-status" role="alert">
      <p>{t('filePreview.failed')}</p>
      <button
        className="button small"
        onClick={() => {
          setFile(null);
          setFailed(false);
          setAttempt((value) => value + 1);
          setViewer(createViewerComponent());
        }}
      >
        {t('filePreview.retry')}
      </button>
    </div>
  );
  return (
    <section
      ref={panel}
      style={{ height: request.mode === 'inline' ? inlineHeight : '100%' }}
      className={`file-preview-panel file-preview-mode-${request.mode}`}
      aria-label={request.name}
      contentEditable={false}
    >
      <header className="file-preview-header">
        <strong title={request.name}>{request.name}</strong>
        <span className="muted small">{t('filePreview.readonly')}</span>
        <Select
          label={t('filePreview.mode')}
          value={request.mode}
          options={(['side', 'inline', 'window'] as const)
            .filter((mode) => mode !== 'inline' || request.host?.isConnected)
            .map((mode) => ({ value: mode, label: t(`filePreview.${mode}`) }))}
          onChange={(mode) => {
            if (request.mode === 'inline') setInlineHeight(panel.current?.offsetHeight ?? 420);
            savedView.current = controller.current?.getViewState() ?? null;
            setPreviewMode(mode);
          }}
        />
        <button
          className="icon-button"
          aria-label={t('filePreview.download')}
          onClick={() => void downloadFile(request.id)}
        >
          <Download size={16} />
        </button>
        {request.mode !== 'window' && (
          <button
            className="icon-button"
            aria-label={t('filePreview.collapse')}
            onClick={() => closePreview()}
          >
            <X size={16} />
          </button>
        )}
      </header>
      <div className="file-preview-content">
        {failed ? (
          fallback
        ) : file ? (
          <PreviewBoundary key={attempt} fallback={fallback}>
            <Suspense
              fallback={
                <div className="file-preview-status" role="status">
                  {t('filePreview.loading')}
                </div>
              }
            >
              <Viewer file={file} controller={controller} onFailure={onFailure} />
            </Suspense>
          </PreviewBoundary>
        ) : (
          <div className="file-preview-status" role="status">
            {t('filePreview.loading')}
          </div>
        )}
      </div>
    </section>
  );
}
