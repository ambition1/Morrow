/**
 * 功能：快速记录到指定笔记，支持图片附件并在保存失败时保留待处理内容。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:42:24
 */
import { useEffect, useRef, useState } from 'react';
import { formatShortcut } from '../actions';
import { captureToToday, ensureToday } from '../operations';
import { useTranslation } from '../i18n';
import { displayTitle } from '../i18n/labels';
import { closeDialog, toast } from '../ui';
import { getSession, useWorkspace } from '../workspace';
import { webRecovery } from '../platform/webRecovery';
import { pickFiles } from '../platform/files';
import { storeFiles, MAX_FILE_BYTES } from '../platform/attachments';
import { livePages } from '../../core/tree';
import { Dialog } from './primitives';
import { Select } from './Select';

/** 上传逐个确认，失败重试不会重新追加正文或上传已经确认的文件。 */
export function CaptureDialog() {
  /** 所有新增文案通过现有词典。 */
  const { t } = useTranslation();
  /** 下拉选项随页面删除和改名更新。 */
  const state = useWorkspace();
  /** 输入内容只在用户关闭或确认保存后清空。 */
  const [text, setText] = useState('');
  /** 空目标表示今日笔记。 */
  const [target, setTarget] = useState('');
  /** 尚未上传的原始文件保留供失败重试。 */
  const [files, setFiles] = useState<File[]>([]);
  /** 先读取持久草稿再允许保存，防止空初始状态覆盖旧内容。 */
  const [ready, setReady] = useState(!webRecovery);
  /** 本机草稿失败单独提示，不能宣称已保存。 */
  const [localError, setLocalError] = useState(false);
  /** 引用已追加但检查点尚未确认的附件，重试时不能再次插入。 */
  const appendedFile = useRef<File | null>(null);
  /** 同一个弹窗一次提交只追加一次正文。 */
  const committed = useRef(false);
  /** 首次提交后冻结目标，重试不创建另一篇每日笔记。 */
  const destination = useRef<string | null>(null);
  /** 忙碌期间所有提交入口共用同步锁。 */
  const saving = useRef(false);
  /** React状态仅用于禁用及显示反馈。 */
  const [busy, setBusy] = useState(false);
  /** 错误在弹窗内保留，不能只有短暂toast。 */
  const [error, setError] = useState(false);
  /** 提交后继续保留输入，但防止失败重试重复追加同一段正文。 */
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    /** 关闭窗口后不再更新状态；读取本身不改变存储。 */
    let cancelled = false;
    if (!webRecovery) return;
    void webRecovery
      .readCapture()
      .then((draft) => {
        if (cancelled) return;
        if (draft) {
          setText(draft.text);
          setTarget(draft.target);
          setFiles(draft.files);
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setReady(true);
          setLocalError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!ready || !webRecovery || busy) return;
    /** 输入防抖独立于服务器保存；首次读取完成之前不执行。 */
    const timer = setTimeout(() => {
      void (async () => {
        if (saving.current) return;
        /** 只清理本次检查点开始时已经追加的文件，迟到回调不动新上传。 */
        const appended = appendedFile.current;
        /** 检查点排除已受目标页保护的附件。 */
        const remaining = files.filter((file) => file !== appended);
        if (committed.current && destination.current)
          await webRecovery?.ensurePageProtected(destination.current);
        if (saving.current) return;
        await webRecovery?.saveCapture(submitted ? '' : text, destination.current ?? target, remaining);
        if (!saving.current && appended && appendedFile.current === appended) {
          setFiles(remaining);
          appendedFile.current = null;
        }
      })()
        .then(() => setLocalError(false))
        .catch(() => setLocalError(true));
    }, 200);
    return () => clearTimeout(timer);
  }, [text, target, files, ready, busy, submitted]);
  /** 关闭前等待本机存储确认；不可用时保留窗口和原始附件。 */
  const close = async () => {
    if (busy || saving.current || !ready) return;
    try {
      if (committed.current && destination.current)
        await webRecovery?.ensurePageProtected(destination.current);
      await webRecovery?.saveCapture(
        submitted ? '' : text,
        destination.current ?? target,
        files.filter((file) => file !== appendedFile.current),
      );
      appendedFile.current = null;
      closeDialog();
    } catch {
      setLocalError(true);
    }
  };
  /** 上传完成只在正文也成功保存后显示成功。 */
  const save = async () => {
    if (!ready || saving.current || (!text.trim() && !files.length && !committed.current)) return;
    saving.current = true;
    setBusy(true);
    setError(false);
    /** 本机检查点完成前暂缓新的正文保存，避免刷新重放已经提交的记录。 */
    const release = getSession().queue.hold();
    try {
      // 重试先确认目标页已有持久副本，禁止先清空唯一可靠的快速记录来源。
      if (committed.current && destination.current)
        await webRecovery?.ensurePageProtected(destination.current);
      /** 之前已插入但未完成检查点的文件只需确认，不再次上传和追加。 */
      const pendingFiles = files.filter((file) => file !== appendedFile.current);
      await webRecovery?.saveCapture(submitted ? '' : text, destination.current ?? target, pendingFiles);
      if (appendedFile.current) {
        setFiles(pendingFiles);
        appendedFile.current = null;
      }
      destination.current ??= target || ensureToday();
      if (!destination.current) throw new Error('No capture destination');
      if (!committed.current && text.trim()) {
        if (!captureToToday(text, destination.current)) throw new Error('Capture refused');
        committed.current = true;
        setSubmitted(true);
        await webRecovery?.ensurePageProtected(destination.current);
        await webRecovery?.saveCapture('', destination.current, pendingFiles);
      }
      // 每个附件保存确认后从待上传队列移除，下次只处理失败项。
      /** 本次请求的附件队列，逐个确认后才更新持久副本。 */
      let remaining = [...pendingFiles];
      for (const file of [...pendingFiles]) {
        /** 过大文件不能静默跳过并显示成功。 */
        if (file.size > MAX_FILE_BYTES) throw new Error('File too large');
        /** 使用现有附件层，服务端拒绝陈旧版本时保留原文件。 */
        const stored = await storeFiles([file]);
        if (stored.length !== 1) throw new Error('Upload failed');
        if (!captureToToday('', destination.current, stored)) throw new Error('Capture refused');
        appendedFile.current = file;
        committed.current = true;
        setSubmitted(true);
        await webRecovery?.ensurePageProtected(destination.current);
        remaining = remaining.filter((item) => item !== file);
        setFiles(remaining);
        await webRecovery?.saveCapture('', destination.current, remaining);
        appendedFile.current = null;
      }
      /** 最后一个本机检查点对应本次实际发送，迟到响应不能清除新记录。 */
      const captureToken = webRecovery?.captureToken();
      release();
      await getSession().flush();
      if (getSession().saveStatus.state !== 'saved') throw new Error('Save failed');
      await webRecovery?.clearCapture(captureToken);
      closeDialog();
      toast(t('dialogs.captureSaved'));
    } catch {
      setError(true);
    } finally {
      release();
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('dialogs.quickNote')}
      size="small"
      onClose={() => void close()}
      footer={
        <>
          <span className="muted small dialog-hint">
            {t('common.toSave', { shortcut: formatShortcut('Mod+Enter') })}
          </span>
          <button type="button" className="button" disabled={busy || !ready} onClick={() => void close()}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!ready || busy || (!text.trim() && !files.length && !submitted)}
            onClick={() => void save()}
          >
            {t('dialogs.captureSave')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('dialogs.captureLocation')}</span>
        <Select
          value={target}
          label={t('dialogs.captureLocation')}
          disabled={!ready || busy || submitted}
          options={[
            { value: '', label: t('dialogs.addToToday') },
            ...livePages(state.pages)
              .filter((page) => page.kind === 'page' && !page.encrypted)
              .map((page) => ({ value: page.id, label: displayTitle(page) })),
          ]}
          onChange={setTarget}
        />
      </label>
      <textarea
        className="text-input capture-input"
        data-autofocus
        rows={5}
        disabled={!ready || busy || submitted}
        aria-label={t('dialogs.quickNote')}
        placeholder={t('dialogs.quickNotePlaceholder')}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <label className="field">
        <span>{t('dialogs.captureFiles')}</span>
        <button
          type="button"
          className="button"
          disabled={!ready || busy || submitted}
          onClick={() =>
            void pickFiles('', true).then((picked) => setFiles((current) => [...current, ...picked]))
          }
        >
          {t('dialogs.captureFiles')}
        </button>
      </label>
      {files.length > 0 && (
        <ul className="capture-files">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <span>{file.name}</span>
              <button
                type="button"
                className="button small"
                disabled={busy}
                onClick={() => setFiles((current) => current.filter((_item, at) => at !== index))}
              >
                {t('dialogs.captureRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {localError && (
        <p className="field-error" role="alert">
          {t('dialogs.captureLocalFailed')}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {t('dialogs.captureFailed')}
        </p>
      )}
    </Dialog>
  );
}
