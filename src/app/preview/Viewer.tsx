/**
 * 功能：按需装载本地文件预览引擎及首批格式渲染器。
 * 作者：xuanli
 * 创建时间：2026-11-03 12:06:09
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileViewer from '@file-viewer/react';
import type { FileViewerHandle, ViewerOptions, ViewerState } from '@file-viewer/react';
import standardPreset, { mergeFullAssetOptions } from '@file-viewer/preset-standard';
import { drawingRenderer } from '@file-viewer/renderer-drawing';
import { mindmapRenderer } from '@file-viewer/renderer-mindmap';
import { pptRenderer } from '@file-viewer/renderer-ppt';
import { useTranslation } from '../i18n';
import { resolvedTheme, usePreferences } from '../platform/preferences';

/** 只读引擎入口；外层已完成文件读取、关闭与下载管理。 */
export default function Viewer({
  file,
  controller,
  onFailure,
}: {
  file: File;
  controller: React.RefObject<FileViewerHandle | null>;
  onFailure: () => void;
}) {
  /** 跟随应用的语言与主题设置。 */
  const { locale } = useTranslation();
  /** 使用共享偏好，不创建第二套主题开关。 */
  const prefs = usePreferences();
  /** 引擎自行跟随系统主题，手动主题则明确指定。 */
  const theme = prefs.theme === 'system' ? 'system' : resolvedTheme(prefs.theme);
  /** 保持配置引用稳定，避免普通父层重绘重新解析附件。 */
  const options = useMemo<ViewerOptions>(
    () =>
      mergeFullAssetOptions(
        {
          preset: standardPreset,
          // 上游浏览器渲染器使用 HTMLDivElement，公共配置泛型默认 HTMLElement；宿主始终是 div。
          renderers: [drawingRenderer, mindmapRenderer, pptRenderer] as unknown as ViewerOptions['renderers'],
          rendererMode: 'replace',
          autoRenderers: false,
          theme,
          locale,
          styleIsolation: 'shadow',
          ui: { density: 'compact' },
          toolbar: {
            download: false,
            exportHtml: false,
            print: false,
            theme: false,
            position: 'top',
          },
          archive: { cache: false, maxArchiveSize: 100 * 1024 * 1024, maxEntryPreviewSize: 20 * 1024 * 1024 },
          drawing: { preferOfficial: false },
        },
        new URL(`${import.meta.env.BASE_URL}file-viewer/`, document.baseURI).href,
      ),
    [theme, locale],
  );
  /** 引擎解析失败时切换到应用的可重试提示，不暴露内部堆栈。 */
  const onStateChange = useCallback(
    (state: ViewerState) => {
      if (state.error) onFailure();
    },
    [onFailure],
  );
  // 保留原有原生音视频格式，避免上游较窄的扩展名表导致兼容性回退。
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|mp4|webm|mov|m4v|ogv)$/i.test(file.name))
    return <NativeMedia file={file} />;
  return (
    <FileViewer
      ref={controller}
      className="file-preview-engine"
      file={file}
      filename={file.name}
      options={options}
      onStateChange={onStateChange}
    />
  );
}

/** 音视频沿用浏览器原生解码能力，同时支持三种布局与关闭释放资源。 */
function NativeMedia({ file }: { file: File }) {
  /** 媒体 DOM 直接接收对象地址，不把地址写入笔记。 */
  const media = useRef<HTMLMediaElement | null>(null);
  /** 浏览器不支持编码时显示明确回退。 */
  const [failed, setFailed] = useState(false);
  /** 共享错误文案。 */
  const { t } = useTranslation();
  /** 根据原有支持范围区分音频和视频。 */
  const video = /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
  useEffect(() => {
    /** 每个活动文件只生成一个地址，关闭后立即回收。 */
    const url = URL.createObjectURL(file);
    /** 清理时暂停播放并解除媒体引用。 */
    const element = media.current;
    if (element) element.src = url;
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);
  if (failed)
    return (
      <div className="file-preview-status" role="alert">
        {t('filePreview.failed')}
      </div>
    );
  return video ? (
    <video
      className="file-preview-native"
      ref={(node) => {
        media.current = node;
      }}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      aria-label={file.name}
    />
  ) : (
    <audio
      className="file-preview-native"
      ref={(node) => {
        media.current = node;
      }}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      aria-label={file.name}
    />
  );
}
