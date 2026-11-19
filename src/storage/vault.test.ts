import { describe, expect, it } from 'vitest';
import { canvasFromDoc } from '../core/canvas';
import type { Command } from '../core/commands';
import type { DocNode, PageId } from '../core/model';
import { sampleCommands } from '../core/sample';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import type { VaultBridge } from './vaultBridge';

import { VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `id${++counter}`;

const doc = (...texts: string[]): DocNode => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const session = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!session.ok) throw new Error(session.error);
  return session.value;
}

function idOf(session: WorkspaceSession, title: string): PageId {
  const page = Object.values(session.getState().pages).find((candidate) => candidate.title === title);
  if (!page) throw new Error(`no page ${title}`);
  return page.id;
}

async function run(session: WorkspaceSession, command: Command): Promise<void> {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

const OBSIDIAN = {
  'Welcome.md': '---\ntags: [start]\ncssclasses: wide\n---\n# Hello\n\nSee [[Projects/Garden|the garden]].\n',
  'Projects.md': 'All my projects.\n',
  'Projects/Garden.md': 'Back to [[Welcome]].\n\n* loose   formatting  kept\n',
  'Ideas/Loose idea.md': 'Just a thought with ![[pic.png]]\n',
  'attachments/pic.png': 'PNG',
  'Board.canvas': JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'hello', x: 0, y: 0, width: 200, height: 80 },
      { id: 'b', type: 'file', file: 'Projects/Garden.md', x: 300, y: 0, width: 200, height: 80 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  }),
  '.obsidian/app.json': '{}',
};

describe('opening a folder of markdown files', () => {
  it('reads pages, folders, links, images and canvases', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const state = session.getState();
    const titles = Object.values(state.pages)
      .map((page) => page.title)
      .sort();
    expect(titles).toEqual(['Board', 'Garden', 'Ideas', 'Loose idea', 'Projects', 'Welcome']);
    const garden = idOf(session, 'Garden');
    expect(state.pages[garden]!.parentId).toBe(idOf(session, 'Projects'));
    expect(state.pages[idOf(session, 'Loose idea')]!.parentId).toBe(idOf(session, 'Ideas'));
    expect(state.pages[idOf(session, 'Welcome')]!.tags).toEqual(['start']);
    const link = state.docs[idOf(session, 'Welcome')]!.content![1]!.content![1]!;
    expect(link.attrs).toMatchObject({ id: garden, alias: 'the garden' });
    const image = state.docs[idOf(session, 'Loose idea')]!.content!.find((node) => node.type === 'image');
    expect(image?.attrs?.fileId).toBe('attachments/pic.png');
    const board = canvasFromDoc(state.docs[idOf(session, 'Board')]);
    expect(board.nodes[1]).toMatchObject({ type: 'page', pageId: garden });
    expect(session.firstRun).toBe(false);
    await session.close();
  });

  it('only rewrites the file that was edited and keeps unknown properties', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    await run(session, { type: 'page.setDoc', id: welcome, doc: doc('Rewritten'), now: 5 });
    expect(vault.text('Welcome.md')).toBe('---\ntags: [start]\ncssclasses: wide\n---\nRewritten\n');
    expect(vault.text('Projects/Garden.md')).toBe(OBSIDIAN['Projects/Garden.md']);
    expect(vault.text('Board.canvas')).toBe(OBSIDIAN['Board.canvas']);
    await session.close();
  });

  it('changes only the frontmatter when only an icon or tags change', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    await run(session, { type: 'page.setIcon', id: welcome, icon: '📝', now: 5 });
    await run(session, { type: 'page.setTags', id: welcome, tags: ['start', 'new'], now: 6 });
    const text = vault.text('Welcome.md')!;
    expect(text.slice(text.indexOf('# Hello'))).toBe(
      OBSIDIAN['Welcome.md'].slice(OBSIDIAN['Welcome.md'].indexOf('# Hello')),
    );
    expect(text).toContain('icon: 📝');
    expect(text).toContain('cssclasses: wide');
    await session.close();
  });

  it('renames the file and updates links in other files without touching the rest of them', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    await run(session, { type: 'page.rename', id: idOf(session, 'Welcome'), title: 'Start here', now: 5 });
    expect(vault.text('Welcome.md')).toBeUndefined();
    expect(vault.text('Start here.md')).toBe(OBSIDIAN['Welcome.md']);
    expect(vault.text('Projects/Garden.md')).toBe('Back to [[Start here]].\n\n* loose   formatting  kept\n');
    await session.close();
  });

  it('moves pages with their folders and tidies up empty folders', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    await run(session, { type: 'page.move', id: idOf(session, 'Garden'), parentId: null });
    expect(vault.text('Garden.md')).toContain('Back to [[Welcome]]');
    expect(vault.dirs.has('Projects')).toBe(false);
    // the canvas follows the page to its new path
    expect(JSON.parse(vault.text('Board.canvas')!).nodes[1].file).toBe('Garden.md');
    await run(session, {
      type: 'page.move',
      id: idOf(session, 'Garden'),
      parentId: idOf(session, 'Welcome'),
    });
    expect(vault.text('Welcome/Garden.md')).toBeDefined();
    await session.close();
  });

  it('keeps trashed pages in .trash and puts them back on restore', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const projects = idOf(session, 'Projects');
    await run(session, { type: 'page.trash', id: projects, now: 99 });
    expect(vault.paths()).toEqual(
      expect.arrayContaining(['.trash/Projects.md', '.trash/Projects/Garden.md']),
    );
    expect(vault.text('Projects.md')).toBeUndefined();

    const reopened = await open(vault);
    expect(reopened.getState().pages[projects]!.trashedAt).toBe(99);
    await run(reopened, { type: 'page.restore', id: projects });
    expect(vault.text('Projects/Garden.md')).toBe(OBSIDIAN['Projects/Garden.md']);
    await run(reopened, { type: 'page.trash', id: projects, now: 100 });
    await run(reopened, { type: 'page.deleteForever', id: projects });
    expect(vault.trashed).toEqual(
      expect.arrayContaining(['.trash/Projects.md', '.trash/Projects/Garden.md']),
    );
    await session.close();
    await reopened.close();
  });

  it('remembers ids, order and favourites across restarts', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const ideas = idOf(session, 'Ideas');
    await run(session, { type: 'page.setFavorite', id: ideas, favorite: true });
    await run(session, { type: 'page.move', id: ideas, parentId: null, index: 0 });
    const reopened = await open(vault);
    expect(reopened.getState().pages[ideas]).toMatchObject({ favorite: true, order: 0 });
    await reopened.close();
    await session.close();
  });

  it('treats empty folders as pages, except the attachments folder', async () => {
    const vault = new MemoryVault({ 'Note.md': 'hi\n' });
    vault.dirs.add('attachments');
    vault.dirs.add('Someday');
    const session = await open(vault);
    expect(
      Object.values(session.getState().pages)
        .map((page) => page.title)
        .sort(),
    ).toEqual(['Note', 'Someday']);
    await session.close();
  });

  it('creates files for new pages and suffixes duplicate names', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    expect(session.firstRun).toBe(true);
    await run(session, { type: 'page.create', id: 'a', parentId: null, now: 1, doc: doc('one') });
    await run(session, { type: 'page.create', id: 'b', parentId: null, now: 2, doc: doc('two') });
    await run(session, { type: 'page.create', id: 'c', parentId: 'a', now: 3, title: 'Child' });
    expect(vault.text('Untitled.md')).toBe('one\n');
    expect(vault.text('Untitled 2.md')).toBe('---\ntitle: Untitled\n---\ntwo\n');
    expect(vault.text('Untitled/Child.md')).toBe('');
    await session.close();
  });
});

describe('edits made outside morrow', () => {
  it('does not read its own first save back in as new pages', async () => {
    const vault = new MemoryVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    expect(session.firstRun).toBe(true);
    // a slow disk: the watcher reports the first files while the rest are still being written
    vault.midway = (done) => {
      if (done === 3) vault.report(vault.paths().filter((path) => path.endsWith('.md')));
    };
    const seeded = session.executeAll(sampleCommands(newId, Date.now()));
    if (!seeded.ok) throw new Error(seeded.error);
    await session.flush();
    vault.midway = null;
    const titles = Object.values(session.getState().pages).map((page) => page.title);
    expect(titles.length).toBe(new Set(titles).size);
    await session.close();
  });

  it('does not take a page caught halfway through a move for an edit made elsewhere', async () => {
    const vault = new MemoryVault({
      'Trip.md': 'Look ![](attachments/pic.png)\n',
      'attachments/pic.png': 'PNG',
    });
    const repository = new VaultRepository(vault, newId);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const trip = idOf(session, 'Trip');
    const picture = () => session.getState().docs[trip]!.content!.find((node) => node.type === 'image');
    await run(session, { type: 'page.trash', id: trip, now: 1 });
    await run(session, { type: 'page.restore', id: trip });
    // the watcher read the file right after it was renamed back, before its links were rewritten
    const stale = {
      path: 'Trip.md',
      text: 'Look\n\n![](../attachments/pic.png)\n',
      mtime: Date.now() - 60_000,
      birthtime: 0,
    };
    expect(repository.readChanges([stale], session.getState())).toBeNull();
    expect(picture()?.attrs?.fileId).toBe('attachments/pic.png');
    expect(vault.text('Trip.md')).toBe('Look\n\n![](attachments/pic.png)\n');
    await session.close();
  });

  it('picks up changed, new and deleted files', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const garden = idOf(session, 'Garden');
    vault.external({
      'Projects/Garden.md': 'Edited in another app.\n',
      'Projects/Orchard.md': 'New from git pull.\n',
      'Ideas/Loose idea.md': null,
    });
    const state = session.getState();
    expect(state.docs[garden]).toEqual(doc('Edited in another app.'));
    expect(idOf(session, 'Orchard')).toBeDefined();
    expect(state.pages[idOf(session, 'Orchard')]!.parentId).toBe(idOf(session, 'Projects'));
    expect(Object.values(state.pages).some((page) => page.title === 'Loose idea')).toBe(false);
    // a save afterwards leaves the outside edit alone
    await run(session, { type: 'page.rename', id: idOf(session, 'Welcome'), title: 'Welcome!', now: 9 });
    expect(vault.text('Projects/Garden.md')).toBe('Edited in another app.\n');
    await session.close();
  });

  it('keeps a page when the folder of its subpages goes away', async () => {
    const vault = new MemoryVault({ 'Parent.md': 'p\n', 'Parent/A.md': 'a\n', 'Parent/B.md': 'b\n' });
    const session = await open(vault);
    const parent = idOf(session, 'Parent');
    await run(session, { type: 'page.trash', id: idOf(session, 'A'), now: 5 });
    await run(session, { type: 'page.trash', id: idOf(session, 'B'), now: 6 });
    expect(vault.dirs.has('Parent')).toBe(false);
    // the watcher then reports the emptied folder morrow tidied away
    vault.folderGone('Parent');
    expect(session.getState().pages[parent]).toMatchObject({ title: 'Parent', trashedAt: null });
    expect(vault.text('Parent.md')).toBe('p\n');
    // a folder page is its folder, so it still goes with it
    vault.dirs.add('Someday');
    vault.external({ 'Someday/Idea.md': 'x\n' });
    const someday = idOf(session, 'Someday');
    vault.external({ 'Someday/Idea.md': null });
    vault.folderGone('Someday');
    expect(session.getState().pages[someday]).toBeUndefined();
    await session.close();
  });

  it('treats a file that moved as the same page', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    vault.external({ 'Welcome.md': null, 'Projects/Welcome.md': OBSIDIAN['Welcome.md'] });
    expect(session.getState().pages[welcome]!.parentId).toBe(idOf(session, 'Projects'));
    await session.close();
  });

  it('keeps unsaved edits and saves the other version in page history', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const garden = idOf(session, 'Garden');
    session.execute({ type: 'page.setDoc', id: garden, doc: doc('Mine'), now: 5 });
    vault.external({ 'Projects/Garden.md': 'Theirs\n' });
    expect(session.getState().docs[garden]).toEqual(doc('Mine'));
    await session.flush();
    expect(vault.text('Projects/Garden.md')).toBe('Mine\n');
    const history = await session.listSnapshots(garden);
    expect(history.some((snapshot) => JSON.stringify(snapshot.doc).includes('Theirs'))).toBe(true);
    await session.close();
  });
});

describe('databases and journals in files', () => {
  it('writes row properties as readable frontmatter and reads them back', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    const database = {
      properties: [
        {
          id: 'status',
          name: 'Status',
          type: 'select' as const,
          options: [{ id: 'o1', name: 'Reading', color: 'blue' as const }],
        },
        { id: 'pages', name: 'Pages', type: 'number' as const, options: [] },
      ],
      views: [
        {
          id: 'v',
          name: 'All',
          type: 'table' as const,
          filters: [],
          sorts: [],
          groupBy: null,
          dateProp: null,
          hidden: [],
        },
      ],
    };
    await run(session, {
      type: 'page.create',
      id: 'db',
      parentId: null,
      now: 1,
      title: 'Books',
      kind: 'database',
    });
    await run(session, { type: 'database.set', id: 'db', database, now: 2 });
    await run(session, { type: 'page.create', id: 'row', parentId: 'db', now: 3, title: 'Piranesi' });
    await run(session, {
      type: 'page.setProperties',
      id: 'row',
      values: { status: 'o1', pages: 272 },
      now: 4,
    });
    expect(vault.text('Books/Piranesi.md')).toBe('---\nStatus: Reading\nPages: 272\n---\n');
    expect(vault.text('Books.md')).toContain('kind: database');

    vault.external({ 'Books/Jonathan Strange.md': '---\nStatus: Finished\nPages: 782\n---\nLong.\n' });
    const reopened = await open(vault);
    const row = Object.values(reopened.getState().pages).find((page) => page.title === 'Jonathan Strange')!;
    const db = reopened.getState().pages.db!.database!;
    const finished = db.properties[0]!.options.find((option) => option.name === 'Finished');
    expect(row.properties).toEqual({ status: finished!.id, pages: 782 });
    await session.close();
    await reopened.close();
  });

  it('names daily notes by date and titles them in words', async () => {
    const vault = new MemoryVault({
      'Journal.md': '---\nkind: journal\n---\n',
      'Journal/2026-10-15.md': 'Rain.\n',
    });
    const session = await open(vault);
    const day = Object.values(session.getState().pages).find((page) => page.dailyDate === '2026-10-15');
    expect(day?.title).toMatch(/2026/);
    expect(day?.title).not.toBe('2026-10-15');
    await session.close();
  });
});

describe('encrypted pages in files', () => {
  it('keeps only ciphertext on disk and opens with the right password', async () => {
    const vault = new MemoryVault({ 'Diary.md': '---\ntags: [private]\n---\nDear diary.\n' });
    const session = await open(vault);
    const diary = idOf(session, 'Diary');
    await run(session, { type: 'page.setDoc', id: diary, doc: doc('Dear diary, version two.'), now: 5 });
    expect(vault.paths().some((path) => path.includes('history'))).toBe(false);
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(true);

    const protectedPage = await session.protectPage(diary, 'hunter2 but longer');
    expect(protectedPage.ok).toBe(true);
    const onDisk = vault.text('Diary.md')!;
    expect(onDisk).not.toContain('diary');
    expect(onDisk).not.toContain('private');
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(false);

    // editing an unlocked encrypted page keeps it encrypted
    await run(session, { type: 'page.setDoc', id: diary, doc: doc('Third secret.'), now: 6 });
    expect(vault.text('Diary.md')).not.toContain('Third');
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(false);

    const reopened = await open(vault);
    expect(reopened.getState().pages[diary]!.encrypted).toBe(true);
    expect(reopened.getState().docs[diary]).toBeUndefined();
    expect((await reopened.unlockPage(diary, 'wrong')).ok).toBe(false);
    expect((await reopened.unlockPage(diary, 'hunter2 but longer')).ok).toBe(true);
    expect(reopened.getState().docs[diary]).toEqual(doc('Third secret.'));
    expect(reopened.getState().pages[diary]!.tags).toEqual(['private']);

    await reopened.lockPage(diary);
    expect(reopened.getState().docs[diary]).toBeUndefined();
    expect(vault.text('Diary.md')).not.toContain('Third');

    expect((await reopened.unlockPage(diary, 'hunter2 but longer')).ok).toBe(true);
    await reopened.unprotectPage(diary);
    expect(vault.text('Diary.md')).toBe('---\ntags: [private]\n---\nThird secret.\n');
    await session.close();
    await reopened.close();
  });
});

describe('Web 正文并发保存', () => {
  /** 为每个客户端生成独立版本，底层文件与服务端版本共享。 */
  async function sharedWeb() {
    /** 两页都已落盘，重建不会复用原客户端的整库记录。 */
    const disk = new MemoryVault({ 'Alpha.md': 'Alpha base\n', 'Beta.md': 'Beta base\n' });
    /** 模拟服务器先检查整库版本，再执行文件期望值检查。 */
    let revision = 0;
    /** 独立桥接直到扫描或写入成功才更新自己的版本。 */
    function client(): VaultBridge {
      /** 此客户端的写入基准。 */
      let version = 0;
      return {
        root: disk.root,
        strictConflicts: true,
        fork: client,
        getRevision: () => String(version),
        adoptRevision: (value) => {
          version = Number(value);
        },
        scan: async () => {
          version = revision;
          return disk.scan();
        },
        apply: async (ops) => {
          if (version !== revision)
            throw Object.assign(new Error('stale'), { status: 409, staleVault: true });
          version = ++revision;
          return disk.apply(ops);
        },
        readText: (path) => disk.readText(path),
        readBytes: (path) => disk.readBytes(path),
        createFile: (path, data) => disk.createFile(path, data),
        exists: (path) => disk.exists(path),
        listFiles: (dir) => disk.listFiles(dir),
        onChange: () => () => {},
        fileUrl: () => null,
      };
    }
    /** 由会话记录命令类型并进行真实的保存队列写入。 */
    async function openWeb() {
      /** 仓库使用独立版本，与其他会话共享同一份硬盘模拟。 */
      const repository = new VaultRepository(client(), newId);
      /** 长延时使测试显式控制竞态。 */
      const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
      if (!opened.ok) throw new Error(opened.error);
      return { repository, session: opened.value };
    }
    /** 第一浏览器建立稳定 ID 索引。 */
    const first = await openWeb();
    await first.session.markInitialized();
    return { disk, first, second: await openWeb() };
  }

  it('不同页保存保留双方正文与索引，干净会话能接收远端正文', async () => {
    /** 两个会话加载同一个服务器版本。 */
    const { disk, first, second } = await sharedWeb();
    /** 修改页面与对端打开的页面互不重叠。 */
    const a = idOf(first.session, 'Alpha');
    /** 第二会话编辑独立页面。 */
    const b = idOf(second.session, 'Beta');
    first.session.execute({ type: 'page.setDoc', id: a, doc: doc('From one'), now: 1 });
    second.session.execute({ type: 'page.setDoc', id: b, doc: doc('From two'), now: 2 });
    expect(await first.session.flush()).toBe(true);
    expect(await second.session.flush()).toBe(true);
    expect(disk.text('Alpha.md')).toContain('From one');
    expect(disk.text('Beta.md')).toContain('From two');
    expect(disk.text('.morrow/workspace.json')).toContain(a);
    expect(disk.text('.morrow/workspace.json')).toContain(b);
    /** 读取远端差异之前的会话对象。 */
    const before = first.session.getState();
    expect(
      await first.repository.refreshWeb((patch, adopt) =>
        first.session.acceptWebSnapshot(patch, before, adopt),
      ),
    ).toBe(true);
    expect(first.session.getState().docs[b]).toEqual(doc('From two'));
  });

  it('同页修改保留本机编辑和服务器正文，阻止采用远端快照', async () => {
    /** 两边从同一个页面版本开始。 */
    const { disk, first, second } = await sharedWeb();
    /** 同一个页 ID 用于识别冲突归属。 */
    const id = idOf(first.session, 'Alpha');
    first.session.execute({ type: 'page.setDoc', id, doc: doc('Server'), now: 1 });
    second.session.execute({ type: 'page.setDoc', id, doc: doc('Local'), now: 2 });
    expect(await first.session.flush()).toBe(true);
    expect(await second.session.flush()).toBe(false);
    expect(second.session.saveStatus).toMatchObject({ state: 'conflict', conflictPageId: id, failures: 1 });
    expect(await second.session.flush()).toBe(false);
    expect(second.session.saveStatus.failures).toBe(1);
    /** 有本机编辑时不采用已经读取的快照。 */
    const before = second.session.getState();
    expect(
      await second.repository.refreshWeb((patch, adopt) =>
        second.session.acceptWebSnapshot(patch, before, adopt),
      ),
    ).toBe(false);
    expect(second.session.getState().docs[id]).toEqual(doc('Local'));
    expect(disk.text('Alpha.md')).toContain('Server');
  });

  it('服务端移动页面后，陈旧正文不重新创建旧路径', async () => {
    /** 第二浏览器准备在旧路径写入。 */
    const { disk, first, second } = await sharedWeb();
    /** 目标页面改名后保留原 ID。 */
    const id = idOf(first.session, 'Alpha');
    second.session.execute({ type: 'page.setDoc', id, doc: doc('Local'), now: 2 });
    first.session.execute({ type: 'page.rename', id, title: 'Renamed', now: 3 });
    expect(await first.session.flush()).toBe(true);
    expect(await second.session.flush()).toBe(false);
    expect(disk.text('Alpha.md')).toBeUndefined();
    expect(disk.text('Renamed.md')).toContain('Alpha base');
    expect(second.session.getState().docs[id]).toEqual(doc('Local'));
  });
});
