import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';

export interface VaultChange {
  // a page file, or a folder when dir is set
  path: string;
  // null when the path no longer exists
  text: string | null;
  mtime: number;
  birthtime: number;
  dir?: boolean;
  // set for files other than pages, such as images
  other?: boolean;
}

export interface VaultFileInfo {
  path: string;
  size: number;
  mtime: number;
}

// everything the vault storage needs from the file system, the desktop shell provides it
export interface VaultBridge {
  readonly root: string;
  /** Web 冲突必须交给用户处理，不能自动重放覆盖磁盘正文。 */
  readonly strictConflicts?: boolean;
  /** Web 独立读取和写入使用自己的版本，成功后可由活动桥接采纳。 */
  fork?(): VaultBridge;
  /** 读取本桥接写入所使用的服务器版本。 */
  getRevision?(): string;
  /** 是否有等待或正在执行的 Web 写入。 */
  isWriting?(): boolean;
  /** 已确认采用该快照时同步写入版本。 */
  adoptRevision?(revision: string): void;
  scan(): Promise<VaultScan>;
  // runs operations in order and stops at the first one that fails, the result has one entry per attempt
  apply(ops: VaultOp[]): Promise<VaultOpResult[]>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<ArrayBuffer | null>;
  // creates a new file, never replaces one
  createFile(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(dir: string): Promise<VaultFileInfo[]>;
  onChange(listener: (changes: VaultChange[]) => void): () => void;
  fileUrl(path: string): string | null;
}
