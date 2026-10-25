/**
 * 功能：让桌面原生菜单、文件对话框与简体中文界面保持一致。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:51:21
 */
/** 原生界面语言，首次启动默认简体中文。 */
let locale = 'zh-CN';
/** 桌面原生控件的中文文案；系统动作仍使用 Electron 原有实现。 */
const chinese: Record<string, string> = {
  'Settings…': '设置…',
  Edit: '编辑',
  Undo: '撤销',
  Redo: '重做',
  Window: '窗口',
  'New Tab': '新建标签页',
  'Close Tab': '关闭标签页',
  'Add to dictionary': '添加到词典',
  'Export as PDF': '导出为 PDF',
  'Choose a folder for your notes': '选择笔记文件夹',
  'Use this folder': '使用此文件夹',
  About: '关于 Morrow',
  Hide: '隐藏 Morrow',
  'Hide Others': '隐藏其他应用',
  'Show All': '全部显示',
  Quit: '退出 Morrow',
  Cut: '剪切',
  Copy: '复制',
  Paste: '粘贴',
  'Select All': '全选',
  Close: '关闭窗口',
  Minimize: '最小化',
  Zoom: '缩放',
  'Bring All to Front': '全部置于前台',
  'Choose a folder.': '请选择文件夹。',
  'That folder does not exist any more.': '该文件夹已不存在。',
  'Choose a folder of its own for your notes, not your whole drive or home folder.':
    '请为笔记选择独立文件夹，不要选择整个磁盘或用户主目录。',
  'No vault is open.': '尚未打开笔记库。',
  'That folder does not exist.': '该文件夹不存在。',
  'Choose a folder outside this vault.': '请选择当前笔记库以外的文件夹。',
  'Invalid path.': '文件路径无效。',
  'That path is outside the vault.': '该路径不在笔记库中。',
  'Invalid file data.': '文件数据无效。',
  'A file with that name already exists.': '已存在同名文件。',
  'Invalid folder.': '文件夹无效。',
  'Choose an empty folder for the copy.': '请选择空文件夹来存放副本。',
  'Invalid text.': '文本无效。',
  'Only Morrow files can be deleted.': '仅允许删除 Morrow 内部文件。',
  'Unknown operation.': '未知操作。',
  'Invalid operations.': '操作列表无效。',
  'Invalid file.': '文件无效。',
  'Add an API key first.': '请先添加 API 密钥。',
  'Add an API key in Settings first.': '请先在设置中添加 API 密钥。',
  'Choose a model in Settings first.': '请先在设置中选择模型。',
  'The service sent back an empty reply.': '服务返回了空回复。',
  'There is no update to install.': '没有可安装的更新。',
  'The download did not match the release, so it was not installed.':
    '下载内容与发布文件不一致，已取消安装。',
  'This copy of Morrow can not update itself.': '当前版本不支持自动更新，请手动下载安装。',
};

/** 只接受已支持的界面语言，防止任意配置进入主进程。 */
export function setNativeLocale(value: unknown): void {
  if (typeof value === 'string' && ['zh-CN', 'en', 'es', 'pt'].includes(value)) locale = value;
}

/** 读取原生中文文案，其他语言沿用原先的英文原生菜单。 */
export function nativeText(text: string): string {
  return locale === 'zh-CN' ? (chinese[text] ?? text) : text;
}
