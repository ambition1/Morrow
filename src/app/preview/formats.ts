/**
 * 功能：定义首批预览格式并识别明显损坏的文档容器，避免错误文件卡在解析阶段。
 * 作者：xuanli
 * 创建时间：2026-11-03 12:25:43
 */
/** 仅开放已安装且纳入首批范围的格式。 */
const extensions = new Set(
  (
    'pdf ofd doc docx dot dotx docm dotm rtf odt xlsx xls xlsm xlsb csv tsv ods fods ppt pptx pptm pot potx potm ppsx ppsm odp ' +
    'zip zipx 7z rar tar gz gzip tgz bz2 bzip2 tbz tbz2 xz txz lzma zst tzst cab ar cpio iso xar lha lzh jar war ear apk cbz cbr ' +
    'eml msg mbox xmind drawio dio excalidraw mermaid mmd plantuml puml ' +
    'txt md markdown json jsonc json5 yaml yml xml sql log js mjs cjs css java py html htm jsx ts tsx vue ini sh bash go rs php c cpp cc h hpp cs diff patch ipynb toml proto hcl tex rb swift kt ' +
    'png jpg jpeg gif webp avif svg bmp ico mp3 wav ogg oga m4a aac flac opus weba mp4 webm mov m4v ogv'
  ).split(/\s+/),
);
/** 大小写无关地识别已开放扩展名。 */
export function canPreview(name: string): boolean {
  return extensions.has(/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '');
}

/** 只检查强制签名，完整结构与编码兼容性仍交给各格式解析器。 */
export function hasPreviewSignature(name: string, data: ArrayBuffer): boolean {
  /** 扩展名用于选择有明确容器签名的文档类型。 */
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  /** 文档头最多检查 1024 字节，不复制整个大文件。 */
  const header = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
  if (extension === 'pdf') return new TextDecoder('latin1').decode(header).includes('%PDF-');
  if (
    /^(docx|docm|dotx|dotm|xlsx|xlsm|xlsb|pptx|pptm|potx|potm|ppsx|ppsm|odt|ods|odp|ofd|xmind)$/.test(
      extension,
    )
  ) {
    return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
  }
  return true;
}
