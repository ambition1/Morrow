/**
 * 功能：验证附件格式路由、显示方式切换及节点生命周期清理。
 * 作者：xuanli
 * 创建时间：2026-11-03 12:06:09
 */
import { hasPreviewSignature } from './formats';
import { afterEach, describe, expect, it } from 'vitest';
import { canPreview, closePreview, getPreview, openPreview, setPreviewMode } from './state';

/** 用轻量容器替身验证归属规则，不依赖浏览器全局环境。 */
const host = { isConnected: true } as HTMLElement;
/** 每次测试恢复默认模式并释放请求。 */
afterEach(() => {
  openPreview({ id: 'reset', name: 'reset.pdf', host });
  setPreviewMode('side');
  closePreview();
});

describe('附件预览', () => {
  it('识别首批文档、数据、压缩包、邮件、导图及媒体，兼容大小写', () => {
    for (const name of [
      '方案.DOCX',
      '旧版.doc',
      '预算.XLSX',
      '表格.csv',
      '演示.ppt',
      '演示.pptx',
      '票据.ofd',
      '资料.PDF',
      '附件.7z',
      '邮件.msg',
      '邮件.eml',
      '导图.xmind',
      '流程.drawio',
      '图.excalidraw',
      '配置.yaml',
      '数据.json',
      '网页.html',
      '图片.png',
      '视频.mp4',
    ])
      expect(canPreview(name), name).toBe(true);
    for (const name of ['unknown', 'note.pdf.exe', 'draft.', 'model.dwg', 'design.psd', 'apple.pages'])
      expect(canPreview(name), name).toBe(false);
  });
  it('切换布局保留附件与挂载点，不修改来源', () => {
    openPreview({ id: 'one', name: 'one.pdf', host });
    setPreviewMode('inline');
    expect(getPreview()).toEqual({ id: 'one', name: 'one.pdf', host, mode: 'inline' });
    setPreviewMode('window');
    expect(getPreview()?.id).toBe('one');
    expect(getPreview()?.mode).toBe('window');
  });
  it('没有正文容器的白板文件自动回退侧边，不能切换内嵌', () => {
    openPreview({ id: 'one', name: 'one.pdf', host });
    setPreviewMode('inline');
    openPreview({ id: 'canvas', name: 'canvas.csv' });
    expect(getPreview()?.mode).toBe('side');
    setPreviewMode('inline');
    expect(getPreview()?.mode).toBe('side');
  });
  it('旧节点销毁不关闭后来打开的文件', () => {
    openPreview({ id: 'new', name: 'new.eml', host });
    closePreview({ isConnected: true } as HTMLElement);
    expect(getPreview()?.id).toBe('new');
    closePreview(host);
    expect(getPreview()).toBeNull();
  });
  it('不支持的附件不覆盖正在阅读的文件', () => {
    openPreview({ id: 'one', name: 'one.pdf' });
    openPreview({ id: 'two', name: 'two.exe' });
    expect(getPreview()?.id).toBe('one');
  });
});

/** 明显损坏的文档应立即进入可恢复提示，不启动重型引擎。 */
it('检查 PDF 和 Office 容器签名，普通文本不强制二进制头', () => {
  /** 文本编码器生成最小签名样本。 */
  const bytes = (text: string) => new TextEncoder().encode(text).buffer;
  expect(hasPreviewSignature('资料.pdf', bytes('%PDF-1.7'))).toBe(true);
  expect(hasPreviewSignature('资料.pdf', bytes('invalid'))).toBe(false);
  expect(hasPreviewSignature('资料.docx', bytes('PK\x03\x04container'))).toBe(true);
  expect(hasPreviewSignature('资料.xlsx', bytes('invalid'))).toBe(false);
  expect(hasPreviewSignature('资料.pptx', bytes(''))).toBe(false);
  expect(hasPreviewSignature('说明.txt', bytes('正文'))).toBe(true);
});
