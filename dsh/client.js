/* eslint-disable no-undef */
/**
 * Browser half of justSkill Design for DeepSeek Harness.
 *
 * Two surfaces, one flow:
 *
 *   `sidebar.panellist` + `main`   JustSkill Design 工作台 — every workspace's
 *                                  design files, grouped by workspace.
 *   `sidebarRightTabs.register`    Canvas tab — the file's live canvas in the
 *                                  session's right sidebar.
 *
 * Clicking a design file creates a session in that file's workspace, opens it,
 * opens the Canvas tab and sends the /justskill-design context message. The
 * canvas itself is the existing loopback service, iframed with `embed=1`.
 */
window.__ModuleLoader__.load({
  id: 'justskill-design',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const ROUTE = 'justskill-design';
    const PANEL_ID = 'justskill-design-workbench';
    const TAB_ID = 'justskill-design/canvas';
    const TAB_KIND = 'justskill-canvas';
    const SKILL = 'justskill-design';

    let runtime = null;

    /* ------------------------------------------------------------------ *
     * Small shared helpers
     * ------------------------------------------------------------------ */

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function errorText(error) {
      if (error instanceof Error) return error.message;
      const message = error && typeof error === 'object' ? error.message : undefined;
      return typeof message === 'string' && message !== '' ? message : String(error);
    }

    function basename(file) {
      const parts = String(file).split(/[\\/]/);
      return parts[parts.length - 1] || String(file);
    }

    async function post(path, payload) {
      const response = await fetch(new URL(`api/${ROUTE}/${path}`, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || body === null || body.ok !== true) {
        const code = body && body.error && body.error.code ? body.error.code : `http-${response.status}`;
        const message = body && body.error && body.error.message ? body.error.message : `request failed (${response.status})`;
        const error = new Error(message);
        error.code = code;
        throw error;
      }
      return body.value;
    }

    /**
     * POST a JSON body and consume the response as NDJSON, one callback per
     * event. The Host streams scan results, so the picker can list a file the
     * moment it is found instead of waiting for the whole workspace.
     */
    async function postStream(path, payload, onEvent, signal) {
      const response = await fetch(new URL(`api/${ROUTE}/${path}`, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        signal,
      });
      if (!response.ok || response.body === null) {
        let message = `request failed (${response.status})`;
        try {
          const body = await response.json();
          if (body !== null && body.error !== undefined && typeof body.error.message === 'string') {
            message = body.error.message;
          }
        } catch {
          /* keep the status-based message */
        }
        const error = new Error(message);
        error.code = `http-${response.status}`;
        throw error;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== '') onEvent(JSON.parse(line));
          newline = buffer.indexOf('\n');
        }
      }
      const rest = buffer.trim();
      if (rest !== '') onEvent(JSON.parse(rest));
    }

    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${bytes} B`;
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const delta = Date.now() - ms;
      if (delta < 60_000) return '刚刚';
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
      if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
      const date = new Date(ms);
      return `${date.getMonth() + 1}月${date.getDate()}日`;
    }

    function readWorkspaceItems() {
      const workspaces = runtime === null ? undefined : runtime.get('workspaces');
      if (workspaces === undefined || workspaces.list === undefined) return [];
      const snapshot = workspaces.list.getSnapshot();
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
      return items.map((item) => ({
        id: item.workspaceId,
        path: item.path,
        title: item.title || basename(item.path),
      }));
    }

    function workspaceSignature(items) {
      return items.map((item) => `${item.id}\u0000${item.path}`).join('\u0001');
    }

    function useWorkspaces() {
      const [items, setItems] = useState(() => readWorkspaceItems());
      useEffect(() => {
        const workspaces = runtime === null ? undefined : runtime.get('workspaces');
        if (workspaces === undefined || workspaces.list === undefined) return undefined;
        const read = () => setItems(readWorkspaceItems());
        read();
        return workspaces.list.subscribe(read);
      }, []);
      return items;
    }

    function readTabInfo(props) {
      try {
        return props && typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      } catch {
        return null;
      }
    }

    // The Canvas tab keeps the file it picked in module state, keyed by the tab
    // id, so the body and its tab title agree without rewriting the tab's
    // navigation params. A workbench-opened tab still gets its file from
    // `navigation.params`; a tab opened from the right-sidebar guide starts with
    // the workspace picker and switches to the picked file here.
    const tabFiles = new Map();
    const tabFileListeners = new Set();

    function setTabFile(tabId, file) {
      if (typeof tabId !== 'string' || tabId === '') return;
      if (typeof file === 'string' && file !== '') tabFiles.set(tabId, file);
      else tabFiles.delete(tabId);
      for (const listener of tabFileListeners) listener();
    }

    function useTabFile(tabId) {
      const [, force] = useState(0);
      useEffect(() => {
        if (typeof tabId !== 'string' || tabId === '') return undefined;
        const listener = () => force((value) => value + 1);
        tabFileListeners.add(listener);
        return () => tabFileListeners.delete(listener);
      }, [tabId]);
      return typeof tabId === 'string' && tabId !== '' ? tabFiles.get(tabId) : undefined;
    }

    function readSessionWorkspace(sessionId) {
      const sessions = runtime === null ? undefined : runtime.get('sessions');
      const workspaces = runtime === null ? undefined : runtime.get('workspaces');
      const session = sessionId && sessions && sessions.list
        ? sessions.list.getSnapshot()?.byId?.[sessionId]
        : undefined;
      const cwd = session && typeof session.cwd === 'string' ? session.cwd : undefined;
      const items = workspaces && workspaces.list
        ? (workspaces.list.getSnapshot()?.items ?? [])
        : [];
      const matched = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        ?? items.find((item) => cwd !== undefined && item.path === cwd);
      if (matched !== undefined) {
        return {
          id: matched.workspaceId,
          path: matched.path,
          title: matched.title || basename(matched.path),
        };
      }
      if (typeof cwd === 'string' && cwd !== '') {
        return { id: cwd, path: cwd, title: basename(cwd) };
      }
      return null;
    }

    function openWorkbench() {
      try {
        runtime?.get('layout')?.selectPanel?.(PANEL_ID);
        return true;
      } catch {
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    // Icons are written as `svg(child, child, size)`. The size is optional and
    // last, so the helper pulls it off the argument list instead of mistaking the
    // first child for it (which rendered `width="[object Object]"` and showed a
    // giant clipped glyph in the right-sidebar tab title).
    const svg = (...args) => {
      const size = typeof args[args.length - 1] === 'number' ? args.pop() : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, ...args);
    };

    const icon = {
      logo: (size = 22) => h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 4.2, width: 14, height: 10.6, rx: 2.2 }),
        h('path', { d: 'M3 8h14M6.5 4.2v10.6' }),
        h('path', { d: 'M11.4 10.4l3.2 1.3-1.4.8-.8 1.4z', fill: 'currentColor', stroke: 'none' })),
      search: (size = 15) => svg(h('circle', { cx: 9, cy: 9, r: 4.6 }), h('path', { d: 'M12.6 12.6l3.4 3.4' }), size),
      refresh: (size = 15) => svg(h('path', { d: 'M15.6 8.2A6 6 0 1 0 16 11.4' }), h('path', { d: 'M16 4.6v3.9h-3.9' }), size),
      chevron: (size = 13) => svg(h('path', { d: 'M6 8l4 4 4-4' }), size),
      folder: (size = 13) => svg(h('path', { d: 'M3.6 5.6h4l1.6 2h6v7H3.6z' }), size),
      canvas: (size = 15) => svg(h('rect', { x: 3.2, y: 4.4, width: 13.6, height: 10.4, rx: 2.2 }), h('path', { d: 'M3.2 8.1h13.6M6.6 4.4v10.4' }), size),
      arrow: (size = 15) => svg(h('path', { d: 'M5 10h10M11 6l4 4-4 4' }), size),
      alert: (size = 15) => svg(h('circle', { cx: 10, cy: 10, r: 6.4 }), h('path', { d: 'M10 8.6v4.4M10 6v.1' }), size),
    };

    function renderFileCard(file, workspace, busy, activate) {
      const recent = typeof file.mtime === 'number' && Date.now() - file.mtime < 5 * 60_000;
      return h('button', {
        type: 'button',
        key: file.path,
        className: 'jsk-card',
        disabled: busy !== null,
        title: `${file.path}\n在 ${workspace.title || basename(workspace.path)} 新建会话并打开画布`,
        onClick: () => activate(file),
      },
      h('span', { className: 'jsk-card-thumb' },
        h('span', { className: 'jsk-card-screens' },
          h('span', { className: 'jsk-card-mini jsk-mini-a' }),
          h('span', { className: 'jsk-card-mini' }),
          h('span', { className: 'jsk-card-mini jsk-mini-warm' })),
        recent ? h('span', { className: 'jsk-card-tag' }, '刚刚编辑') : null,
        h('span', { className: 'jsk-card-open' },
          busy === file.path ? h('span', { className: 'jsk-spinner jsk-spinner-dark' }) : icon.arrow(14))),
      h('span', { className: 'jsk-card-main' },
        h('span', { className: 'jsk-card-name' }, file.name),
        h('span', { className: 'jsk-card-meta' },
          typeof file.pages === 'number' ? h('span', { className: 'jsk-pill' }, `${file.pages} 页`) : null,
          h('span', null, formatSize(file.size)),
          h('span', null, formatTime(file.mtime))),
        file.title ? h('span', { className: 'jsk-card-title' }, file.title) : null));
    }

    function WorkbenchPage() {
      const workspaces = useWorkspaces();
      const workspaceKey = useMemo(() => workspaceSignature(workspaces), [workspaces]);
      const [state, setState] = useState({ phase: 'loading', workspaces: [], scannedAt: 0, incomplete: false });
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [query, setQuery] = useState('');
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [busy, setBusy] = useState(null);
      const controller = useRef(null);

      const load = useCallback(() => {
        if (controller.current !== null) controller.current.abort();
        if (workspaces.length === 0) {
          controller.current = null;
          setState({ phase: 'empty', workspaces: [], scannedAt: 0, incomplete: false });
          return;
        }
        const abort = new AbortController();
        controller.current = abort;
        const entries = new Map();
        const snapshot = () => [...entries.values()];
        setError(null);
        setState({ phase: 'loading', workspaces: [], scannedAt: 0, incomplete: false });

        postStream('scan/stream', {
          workspaces: workspaces.map((item) => ({ id: item.id, path: item.path, title: item.title })),
        }, (event) => {
          if (abort.signal.aborted) return;
          if (event.type === 'start') {
            for (const workspace of event.workspaces) {
              entries.set(workspace.id, { ...workspace, files: [], incomplete: false, done: false });
            }
            setState((current) => ({ ...current, phase: 'scanning', workspaces: snapshot() }));
            return;
          }
          if (event.type === 'files') {
            const workspace = entries.get(event.workspace);
            if (workspace !== undefined) workspace.files.push(...event.files);
            setState((current) => ({ ...current, phase: 'scanning', workspaces: snapshot() }));
            return;
          }
          if (event.type === 'workspace-done') {
            const workspace = entries.get(event.workspace);
            if (workspace !== undefined) {
              workspace.incomplete = event.incomplete === true;
              workspace.done = true;
              workspace.files.sort((left, right) => right.mtime - left.mtime);
            }
            setState((current) => ({ ...current, workspaces: snapshot() }));
            return;
          }
          if (event.type === 'done') {
            for (const workspace of entries.values()) {
              workspace.files.sort((left, right) => right.mtime - left.mtime);
            }
            setState({
              phase: 'ready',
              workspaces: snapshot(),
              scannedAt: event.scannedAt || Date.now(),
              incomplete: event.incomplete === true,
            });
            return;
          }
          if (event.type === 'error') {
            throw new Error(String(event.message));
          }
        }, abort.signal).then(() => {
          // Settle if the stream ended without a final `done` event, so the
          // panel never sits in "扫描中" forever.
          if (abort.signal.aborted) return;
          for (const workspace of entries.values()) {
            workspace.files.sort((left, right) => right.mtime - left.mtime);
            workspace.done = true;
          }
          setState((current) => (current.phase === 'loading' || current.phase === 'scanning'
            ? {
              phase: 'ready',
              workspaces: snapshot(),
              scannedAt: Date.now(),
              incomplete: [...entries.values()].some((workspace) => workspace.incomplete === true),
            }
            : current));
        }).catch((cause) => {
          if (abort.signal.aborted) return;
          setError(errorText(cause));
          setState((current) => ({ ...current, phase: current.workspaces.length === 0 ? 'error' : 'ready' }));
        });
      }, [workspaces]);

      useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [workspaceKey]);

      useEffect(() => () => {
        if (controller.current !== null) controller.current.abort();
      }, []);

      const groups = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const streaming = state.phase === 'loading' || state.phase === 'scanning';
        return state.workspaces
          .map((workspace) => {
            const workspaceMatches = needle === '' || `${workspace.title} ${workspace.path}`.toLowerCase().includes(needle);
            const files = (Array.isArray(workspace.files) ? workspace.files : [])
              .filter((file) => workspaceMatches || `${file.name} ${file.title || ''}`.toLowerCase().includes(needle))
              .map((file) => ({ ...file, workspaceId: workspace.id, workspaceTitle: workspace.title }));
            return { ...workspace, files };
          })
          .filter((workspace) => workspace.files.length > 0 || (streaming && needle === ''));
      }, [state.workspaces, state.phase, query]);

      const totals = useMemo(() => {
        let files = 0;
        let newest = 0;
        for (const workspace of state.workspaces) {
          for (const file of Array.isArray(workspace.files) ? workspace.files : []) {
            files += 1;
            if (typeof file.mtime === 'number' && file.mtime > newest) newest = file.mtime;
          }
        }
        return { workspaces: state.workspaces.length, files, newest };
      }, [state.workspaces]);

      const toggleGroup = (id) => {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const activate = useCallback(async (file) => {
        if (busy !== null) return;
        setBusy(file.path);
        setError(null);
        setNotice(null);
        try {
          const sessions = runtime === null ? undefined : runtime.get('sessions');
          const uiWorkspace = runtime === null ? undefined : runtime.get('uiWorkspace');
          const sidebarRight = runtime === null ? undefined : runtime.get('sidebarRight');
          if (sessions === undefined || typeof sessions.create !== 'function') {
            throw new Error('DSH sessions 服务不可用，无法新建会话');
          }
          if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') {
            throw new Error('DSH 右侧栏服务不可用，无法打开画布');
          }

          const sessionId = await sessions.create({ workspaceId: file.workspaceId });
          try {
            uiWorkspace?.openSession?.(sessionId);
          } catch {
            /* navigation is best effort; the tab is the important half */
          }

          const prompt = [
            `/${SKILL}`,
            '',
            `Use justSkill tools. Current file ${file.uri}`,
            '',
            'The canvas is already open in the right-sidebar Canvas tab.',
            'Do NOT run `node design.mjs serve` and do NOT open a browser for the canvas.',
            'Wait for my adjustment request.',
          ].join('\n');

          const prompting = typeof sessions.using === 'function'
            ? sessions.using(sessionId, { source: SKILL }, async (reference) => {
              const session = reference && reference.binding ? reference.binding.session : undefined;
              if (session === undefined || typeof session.prompt !== 'function') {
                throw new Error('无法向新会话发送初始消息');
              }
              try {
                await session.rename?.(`${basename(file.name).replace(/\.html?$/i, '')} · 设计调整`);
              } catch {
                /* a title is a convenience, never a blocker */
              }
              await session.prompt([{ type: 'text', text: prompt }], 'queue');
            })
            : Promise.reject(new Error('DSH sessions.using 不可用'));

          const mounted = await waitForMounted(sidebarRight, sessionId, 5000);
          if (!mounted) throw new Error('新会话没有切换成功，画布暂未打开');
          await openCanvasTab(sidebarRight, file.path);
          setNotice({ sessionId, file: file.path });
          prompting.catch((cause) => {
            console.error('[justskill-design] initial prompt failed:', cause);
          });
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(null);
        }
      }, [busy]);

      const totalLabel = totals.files === 1 ? '1 个设计文件' : `${totals.files} 个设计文件`;
      const workspaceLabel = totals.workspaces === 1 ? '1 个工作区' : `${totals.workspaces} 个工作区`;

      return h('div', { className: 'jsk-page' },
        h('header', { className: 'jsk-head' },
          h('div', { className: 'jsk-brand' },
            h('span', { className: 'jsk-brand-icon' }, icon.logo(24)),
            h('div', null,
              h('h1', null, 'JustSkill Design 工作台'),
              h('p', null, '扫描所有工作区里的设计文件，点开就在该工作区新建会话，并在右侧栏打开画布。'))),
          h('div', { className: 'jsk-actions' },
            h('label', { className: 'jsk-search' },
              icon.search(),
              h('input', {
                value: query,
                placeholder: '搜索设计文件、工作区…',
                spellCheck: false,
                onChange: (event) => setQuery(event.target.value),
              })),
            h('button', {
              type: 'button',
              className: 'jsk-button jsk-button-primary',
              onClick: () => load(),
            }, icon.refresh(), state.phase === 'loading' || state.phase === 'scanning' ? '重新扫描' : '刷新'))),
        error !== null ? h('div', { className: 'jsk-error' }, icon.alert(), h('span', null, error)) : null,
        notice !== null ? h('div', { className: 'jsk-notice' },
          h('span', null, '已新建会话并打开画布：', h('b', null, basename(notice.file))),
          h('button', {
            type: 'button',
            className: 'jsk-link',
            onClick: () => {
              try {
                runtime.get('sessions')?.open?.(notice.sessionId);
              } catch {
                /* ignored */
              }
            },
          }, '查看会话')) : null,
        h('div', { className: 'jsk-stats' },
          h('span', null, h('b', null, totals.workspaces), ' 个工作区'),
          h('i', { className: 'jsk-sep' }),
          h('span', null, h('b', null, totals.files), ' 个设计文件'),
          h('i', { className: 'jsk-sep' }),
          h('span', null, '最近更新 ', h('b', null, totals.newest === 0 ? '—' : formatTime(totals.newest))),
          h('span', { className: 'jsk-stats-right' },
            state.phase === 'loading' || state.phase === 'scanning' ? '扫描中…' : `上次扫描 ${formatTime(state.scannedAt || Date.now())}`),
          state.phase === 'scanning' ? h('span', { className: 'jsk-badge-live' }, `扫描中 · 已找到 ${totals.files} 个`) : null,
          state.incomplete ? h('span', { className: 'jsk-badge-warn' }, '部分工作区扫描未完成') : null),
        h('div', { className: 'jsk-list' },
          state.phase === 'loading' ? h('div', { className: 'jsk-empty' }, h('span', { className: 'jsk-spinner' }), '正在扫描工作区…') : null,
          state.phase === 'empty' ? h('div', { className: 'jsk-empty' },
            h('strong', null, '还没有工作区'),
            h('span', null, '在 DSH 左侧栏添加一个工作区后，这里会列出其中的设计文件。')) : null,
          state.phase === 'error' ? h('div', { className: 'jsk-empty' }, h('strong', null, '扫描失败'), h('span', null, error || '请稍后重试')) : null,
          groups.length === 0 && state.phase === 'ready' ? h('div', { className: 'jsk-empty' },
            h('strong', null, query.trim() === '' ? '没有找到设计文件' : '没有匹配的设计文件'),
            h('span', null, query.trim() === '' ? '设计文件需要带有 <meta name="design-schema"> 标记；让 agent 用 justSkill 新建一个 design.html 试试。' : '换一个关键词，或清空搜索。')) : null,
          groups.map((workspace) => {
            const isCollapsed = collapsed.has(workspace.id);
            return h('section', { className: 'jsk-group', key: workspace.id },
              h('button', { type: 'button', className: 'jsk-group-head', onClick: () => toggleGroup(workspace.id) },
                h('span', { className: `jsk-chevron ${isCollapsed ? 'jsk-chevron-closed' : ''}` }, icon.chevron()),
                h('span', { className: 'jsk-ws-badge' }, (workspace.title || '?').slice(0, 1)),
                h('span', { className: 'jsk-ws-name' }, workspace.title || basename(workspace.path)),
                h('span', { className: 'jsk-ws-path' }, workspace.path),
                h('span', { className: 'jsk-count' }, `${workspace.files.length} 个文件${workspace.done === false ? '…' : ''}`)),
              isCollapsed ? null : h('div', { className: 'jsk-grid' },
                workspace.done === false && workspace.files.length > 0
                  ? h('div', { className: 'jsk-picker-status' }, h('span', { className: 'jsk-spinner' }), '扫描中，列表还会继续增加…')
                  : null,
                workspace.done !== false && workspace.incomplete === true && workspace.files.length > 0
                  ? h('div', { className: 'jsk-picker-note' }, '扫描达到时间上限，列表可能不完整')
                  : null,
                workspace.files.length === 0
                  ? h('div', { className: 'jsk-row-empty' },
                    workspace.done === false
                      ? '正在扫描…'
                      : workspace.incomplete === true ? '扫描达到时间上限，暂时没扫到设计文件' : '这个工作区里还没有设计文件')
                  : workspace.files.map((file) => renderFileCard(file, workspace, busy, activate))));
          }),
        ),
        h('footer', { className: 'jsk-foot' },
          h('span', { className: 'jsk-step' }, h('i', null, '1'), '点设计文件'),
          h('span', { className: 'jsk-arrow' }, '→'),
          h('span', { className: 'jsk-step' }, h('i', null, '2'), '该工作区自动新建会话'),
          h('span', { className: 'jsk-arrow' }, '→'),
          h('span', { className: 'jsk-step' }, h('i', null, '3'), '右侧栏打开画布，边聊边改')));
    }

    async function waitForMounted(sidebarRight, sessionId, timeoutMs) {
      // `sidebarRight.mounted` is the "session on screen" snapshot store; the
      // right sidebar's commands target exactly that session. Without this
      // wait, openTab would land on the previous session (or throw while the
      // new session's store is being minted).
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (sidebarRight.mounted?.getSnapshot?.() === sessionId) return true;
        } catch {
          /* the store may not be ready yet */
        }
        await sleep(40);
      }
      return false;
    }

    async function openCanvasTab(sidebarRight, file) {
      let last = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          sidebarRight.openTab(TAB_KIND, { params: { file } });
          return;
        } catch (cause) {
          last = cause;
          await sleep(40);
        }
      }
      throw new Error(`右侧栏画布打开失败${last === null ? '' : `：${errorText(last)}`}`);
    }

    /* ------------------------------------------------------------------ *
     * Canvas right-sidebar tab
     * ------------------------------------------------------------------ */

    function CanvasPicker({ sessionId, onPick }) {
      const [state, setState] = useState({ phase: 'scanning', files: [], incomplete: false, stopped: false });
      const [ticket, setTicket] = useState(0);
      const workspace = useMemo(() => readSessionWorkspace(sessionId), [sessionId]);
      const controller = useRef(null);

      const retry = useCallback(() => {
        setTicket((value) => value + 1);
      }, []);

      const stop = useCallback(() => {
        const current = controller.current;
        if (current !== null) current.abort();
      }, []);

      useEffect(() => {
        if (workspace === null) {
          setState({ phase: 'no-workspace', files: [], incomplete: false, stopped: false });
          return undefined;
        }
        const abort = new AbortController();
        controller.current = abort;
        const collected = [];
        let disposed = false;
        setState({ phase: 'scanning', files: [], incomplete: false, stopped: false });

        // The Host streams the scan: each batch is rendered as it arrives, so
        // the first design file shows up long before the workspace is done.
        postStream('scan/stream', {
          workspaces: [{ id: workspace.id, path: workspace.path, title: workspace.title }],
        }, (event) => {
          if (disposed || abort.signal.aborted) return;
          if (event.type === 'files') {
            collected.push(...event.files);
            setState({ phase: 'scanning', files: collected.slice(), incomplete: false, stopped: false });
            return;
          }
          if (event.type === 'workspace-done' || event.type === 'done') {
            const files = collected.slice().sort((left, right) => right.mtime - left.mtime);
            setState((current) => (current.phase === 'scanning'
              ? { phase: 'ready', files, incomplete: event.incomplete === true, stopped: false }
              : current));
            return;
          }
          if (event.type === 'error') {
            throw new Error(String(event.message));
          }
        }, abort.signal).then(() => {
          // The stream ended without a completion event (a dropped workspace,
          // for instance): settle instead of showing a spinner forever.
          if (disposed) return;
          setState((current) => (current.phase === 'scanning'
            ? { phase: 'ready', files: collected.slice().sort((left, right) => right.mtime - left.mtime), incomplete: false, stopped: false }
            : current));
        }).catch((cause) => {
          if (disposed) return;
          if (abort.signal.aborted) {
            const files = collected.slice().sort((left, right) => right.mtime - left.mtime);
            setState({ phase: 'ready', files, incomplete: true, stopped: true });
            return;
          }
          setState({ phase: 'error', files: collected.slice(), incomplete: false, stopped: false, message: errorText(cause) });
        });

        return () => {
          disposed = true;
          abort.abort();
          if (controller.current === abort) controller.current = null;
        };
      }, [workspace, ticket]);

      const files = Array.isArray(state.files) ? state.files : [];
      const scanning = state.phase === 'scanning';
      const reachedCap = state.phase === 'ready' && state.incomplete === true && state.stopped !== true;

      return h('div', { className: 'jsk-picker' },
        h('div', { className: 'jsk-picker-head' },
          h('div', { className: 'jsk-picker-heading' },
            h('div', { className: 'jsk-picker-title' }, workspace === null ? '当前工作区' : workspace.title),
            h('div', { className: 'jsk-picker-sub' }, workspace === null ? '无法确定当前会话的工作区' : workspace.path)),
          h('button', {
            type: 'button',
            className: 'jsk-picker-workbench',
            title: '打开 JustSkill Design 工作台',
            onClick: () => openWorkbench(),
          }, icon.logo(14), '工作台')),
        scanning ? h('div', { className: 'jsk-scan-bar' },
          h('span', { className: 'jsk-spinner' }),
          h('span', null, files.length === 0 ? '正在扫描当前工作区的设计文件…' : `扫描中 · 已找到 ${files.length} 个，继续扫描中…`),
          h('button', { type: 'button', className: 'jsk-link', onClick: stop }, '停止')) : null,
        state.phase === 'error' ? h('div', { className: 'jsk-picker-state' },
          h('strong', null, '读取失败'),
          h('span', null, state.message),
          h('button', { type: 'button', className: 'jsk-button', onClick: retry }, '重试')) : null,
        state.phase === 'no-workspace' ? h('div', { className: 'jsk-picker-state' },
          h('strong', null, '找不到当前工作区'),
          h('span', null, '这个标签页里没有会话工作区信息；请从 JustSkill Design 工作台点一个设计文件。')) : null,
        state.phase === 'ready' && state.stopped ? h('div', { className: 'jsk-picker-note' },
          `已停止扫描，仅显示已找到的 ${files.length} 个文件 `,
          h('button', { type: 'button', className: 'jsk-link', onClick: retry }, '重新扫描')) : null,
        reachedCap && files.length === 0 ? h('div', { className: 'jsk-picker-state' },
          h('strong', null, '扫描达到时间上限，暂时没扫到设计文件'),
          h('span', null, '已扫描 10 分钟仍未扫完。可以重试，或从左侧 JustSkill Design 工作台打开文件。'),
          h('button', { type: 'button', className: 'jsk-button', onClick: retry }, '重试')) : null,
        state.phase === 'ready' && files.length === 0 && !state.incomplete ? h('div', { className: 'jsk-picker-state' },
          h('strong', null, '这个工作区还没有设计文件'),
          h('span', null, '用 justSkill 新建一个 design.html，再回到这里选择它。')) : null,
        files.length > 0 ? h('div', { className: 'jsk-picker-list' },
          reachedCap ? h('div', { className: 'jsk-picker-note' },
            '扫描达到时间上限，列表可能不完整 ',
            h('button', { type: 'button', className: 'jsk-link', onClick: retry }, '重新扫描')) : null,
          files.map((file) => h('button', {
            type: 'button',
            key: file.path,
            className: 'jsk-pick-card',
            title: file.path,
            onClick: () => onPick(file.path),
          },
          h('span', { className: 'jsk-pick-thumb' },
            h('span', { className: 'jsk-card-screens' },
              h('span', { className: 'jsk-card-mini jsk-mini-a' }),
              h('span', { className: 'jsk-card-mini' }),
              h('span', { className: 'jsk-card-mini jsk-mini-warm' })),
            h('span', { className: 'jsk-pick-arrow' }, icon.arrow(12))),
          h('span', { className: 'jsk-pick-name' }, file.name),
          h('span', { className: 'jsk-pick-meta' },
            typeof file.pages === 'number' ? h('span', { className: 'jsk-pill' }, `${file.pages} 页`) : null,
            h('span', null, formatSize(file.size))),
          h('span', { className: 'jsk-pick-time' }, formatTime(file.mtime))))) : null);
    }

    function CanvasBody(props) {
      const info = readTabInfo(props);
      const tabId = info && info.tab ? info.tab.id : undefined;
      const paramsFile = info && info.tab && info.tab.navigation && info.tab.navigation.params
        ? info.tab.navigation.params.file
        : undefined;
      const storedFile = useTabFile(tabId);
      const file = typeof storedFile === 'string' && storedFile !== '' ? storedFile : paramsFile;
      const [state, setState] = useState({ phase: file ? 'loading' : 'pick' });
      const [ticket, setTicket] = useState(0);

      useEffect(() => {
        if (typeof file !== 'string' || file === '') {
          setState({ phase: 'pick' });
          return undefined;
        }
        let cancelled = false;
        setState({ phase: 'loading' });
        post('canvas', { file }).then(
          (value) => {
            if (cancelled) return;
            const url = String(value.url);
            setState({ phase: 'ready', url: `${url}${url.includes('?') ? '&' : '?'}embed=1` });
          },
          (cause) => {
            if (!cancelled) setState({ phase: 'error', message: errorText(cause) });
          },
        );
        return () => {
          cancelled = true;
        };
      }, [file, ticket]);

      useEffect(() => () => {
        if (typeof tabId === 'string' && tabId !== '') tabFiles.delete(tabId);
      }, [tabId]);

      if (typeof file !== 'string' || file === '') {
        return h(CanvasPicker, {
          sessionId: props.sessionId,
          onPick: (picked) => setTabFile(tabId, picked),
        });
      }

      if (state.phase === 'ready') {
        const fromPicker = !(typeof paramsFile === 'string' && paramsFile !== '') && storedFile === file;
        return h(React.Fragment, null,
          h('iframe', {
            className: 'jsk-frame',
            src: state.url,
            title: `JustSkill Design canvas — ${basename(file)}`,
            referrerPolicy: 'no-referrer',
          }),
          fromPicker ? h('button', {
            type: 'button',
            className: 'jsk-switch',
            title: '换一个设计文件',
            onClick: () => setTabFile(tabId, undefined),
          }, icon.folder(13), '设计文件') : null);
      }
      return h('div', { className: 'jsk-canvas-state' },
        state.phase === 'loading' ? h(React.Fragment, null, h('span', { className: 'jsk-spinner' }), '正在打开画布…') : null,
        state.phase === 'error' ? h(React.Fragment, null,
          h('strong', null, '画布打开失败'),
          h('span', null, state.message),
          h('button', { type: 'button', className: 'jsk-button', onClick: () => setTicket((value) => value + 1) }, '重试')) : null);
    }

    function CanvasTitle(props) {
      const info = readTabInfo(props);
      const tabId = info && info.tab ? info.tab.id : undefined;
      const paramsFile = info && info.tab && info.tab.navigation && info.tab.navigation.params
        ? info.tab.navigation.params.file
        : undefined;
      const storedFile = useTabFile(tabId);
      const file = typeof storedFile === 'string' && storedFile !== '' ? storedFile : paramsFile;
      return h('span', { className: 'jsk-tab-title' }, icon.canvas(14), h('span', null, typeof file === 'string' && file !== '' ? basename(file) : 'Canvas'));
    }

    function PanelIcon() {
      return h('span', { className: 'jsk-panel-icon', title: 'JustSkill Design 工作台' }, icon.logo(20));
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.jsk-page{height:100%;min-height:0;display:flex;flex-direction:column;padding:24px 32px 0;background:var(--dsw-alias-bg-layer-1,#fbfbfc);color:var(--dsw-alias-label-primary,#1b1f26);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;box-sizing:border-box}
.jsk-page *{box-sizing:border-box}
.jsk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.jsk-brand{display:flex;align-items:center;gap:13px;min-width:0}
.jsk-brand-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:#fff;flex:none;background:linear-gradient(135deg,#5a73ff,#93a2ff);box-shadow:0 6px 16px rgba(79,107,254,.22)}
.jsk-brand h1{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.2px}
.jsk-brand p{margin:5px 0 0;color:var(--dsw-alias-label-secondary,#68707d);font-size:12.5px;line-height:1.45}
.jsk-actions{display:flex;align-items:center;gap:9px;padding-top:2px;flex:none}
.jsk-search{width:280px;height:35px;display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-search input{width:100%;border:0;outline:0;background:none;color:var(--dsw-alias-label-primary,#1b1f26);font:inherit}
.jsk-search input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-button{height:35px;display:inline-flex;align-items:center;gap:7px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#3c4452);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.jsk-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f7)}
.jsk-button:disabled{opacity:.55;cursor:default}
.jsk-button-primary{background:var(--dsw-alias-brand-primary,#4f6bfe);border-color:var(--dsw-alias-brand-primary,#4f6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 2px 6px rgba(79,107,254,.22)}
.jsk-error,.jsk-notice{margin-top:14px;display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:9px;font-size:12.5px}
.jsk-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 24%,transparent);color:var(--dsw-alias-state-error-primary,#a33)}
.jsk-notice{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 7%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 24%,transparent);color:var(--dsw-alias-label-secondary,#4d5563)}
.jsk-link{background:none;border:0;padding:0;color:var(--dsw-alias-brand-primary,#4f6bfe);font:inherit;font-weight:600;cursor:pointer}
.jsk-stats{display:flex;align-items:center;gap:15px;margin:18px 0 13px;color:var(--dsw-alias-label-secondary,#68707d);font-size:12px;white-space:nowrap}
.jsk-stats b{color:var(--dsw-alias-label-primary,#3c4452);font-weight:600}
.jsk-sep{width:1px;height:11px;background:var(--dsw-alias-border-l2,#e7e9ee)}
.jsk-stats-right{margin-left:auto;color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-badge-warn{color:#a06a12;background:#fdf3e3;border-radius:5px;padding:1px 6px;font-size:11px}
.jsk-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding-bottom:8px}
.jsk-group{flex:none;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.03)}
.jsk-group-head{width:100%;height:44px;display:flex;align-items:center;gap:9px;padding:0 14px;background:var(--dsw-alias-bg-layer-2,#fcfcfd);border:0;border-bottom:1px solid var(--dsw-alias-border-l2,#f0f2f5);color:inherit;font:inherit;text-align:left;cursor:pointer}
.jsk-group-head:hover{background:var(--dsw-alias-interactive-bg-hover,#f6f7f9)}
.jsk-chevron{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary,#a3aab5);transition:transform .15s ease}
.jsk-chevron-closed{transform:rotate(-90deg)}
.jsk-ws-badge{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 10%,transparent);color:var(--dsw-alias-brand-primary,#4658d9);font-size:10px;font-weight:700;flex:none}
.jsk-ws-name{font-size:12.5px;font-weight:600;white-space:nowrap}
.jsk-ws-path{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9aa2af);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.jsk-count{margin-left:auto;color:var(--dsw-alias-label-secondary,#68707d);background:var(--dsw-alias-bg-layer-2,#f4f5f8);border-radius:6px;padding:2px 7px;font-size:11.5px;white-space:nowrap;flex:none}
.jsk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(208px,1fr));gap:12px;padding:12px}
.jsk-row-empty{padding:14px;color:var(--dsw-alias-label-tertiary,#9aa2af);font-size:12px;grid-column:1/-1}
.jsk-pill{color:var(--dsw-alias-label-secondary,#7a8290);background:var(--dsw-alias-bg-layer-2,#f4f5f8);border-radius:5px;padding:1px 5px;font-size:10.5px}
.jsk-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:10px;border:1px solid var(--dsw-alias-border-l2,#eaecf1);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s ease, box-shadow .15s ease, transform .15s ease}
.jsk-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 45%,var(--dsw-alias-border-l2,#eaecf1));box-shadow:0 8px 22px -14px rgba(16,24,40,.28);transform:translateY(-1px)}
.jsk-card:disabled{opacity:.6;cursor:progress}
.jsk-card-thumb{position:relative;display:flex;align-items:center;justify-content:center;height:112px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#eef0f4);background:radial-gradient(circle at 1px 1px,#e2e6ee 1px,transparent 0) 0 0/14px 14px,linear-gradient(135deg,#f7f8fb,#f1f3f8);overflow:hidden}
.jsk-card-screens{display:flex;align-items:center;gap:5px;transform:translateY(2px)}
.jsk-card-mini{position:relative;width:27px;height:82px;border-radius:5px;background:#fff;border:1px solid #e2e6ee;box-shadow:0 4px 10px -6px rgba(16,24,40,.25);overflow:hidden}
.jsk-card-mini:nth-child(2){height:92px}
.jsk-card-mini:after{content:"";position:absolute;left:3px;right:3px;top:5px;height:5px;border-radius:2px;background:#d9deea}
.jsk-card-mini.jsk-mini-a:after{background:#c7d2ff}
.jsk-card-mini.jsk-mini-warm:after{background:#f3d9b8}
.jsk-card-tag{position:absolute;left:8px;top:8px;padding:1px 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 92%,transparent);color:#fff;font-size:10px;font-weight:600}
.jsk-card-open{position:absolute;right:8px;bottom:8px;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent);color:var(--dsw-alias-label-secondary,#68707d);backdrop-filter:blur(4px);border:1px solid var(--dsw-alias-border-l2,#e7e9ee)}
.jsk-card:hover .jsk-card-open{background:var(--dsw-alias-brand-primary,#4f6bfe);border-color:var(--dsw-alias-brand-primary,#4f6bfe);color:#fff}
.jsk-card-main{display:flex;flex-direction:column;gap:3px;min-width:0;padding:0 2px 2px}
.jsk-card-name{font-size:13px;font-weight:600;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-card-meta{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary,#68707d);white-space:nowrap;overflow:hidden}
.jsk-card-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa2af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-secondary,#68707d);font-size:12.5px;text-align:center;padding:32px}
.jsk-empty strong{color:var(--dsw-alias-label-primary,#3c4452);font-size:13.5px;font-weight:600}
.jsk-foot{flex:none;display:flex;align-items:center;gap:9px;margin:6px 0 16px;padding:10px 14px;border:1px dashed var(--dsw-alias-border-l2,#d9dee8);border-radius:11px;background:var(--dsw-alias-bg-layer-2,#f8f9fc);color:var(--dsw-alias-label-secondary,#68707d);font-size:12px;white-space:nowrap;overflow:hidden}
.jsk-step{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#4d5563);font-weight:500}
.jsk-step i{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 10%,transparent);color:var(--dsw-alias-brand-primary,#4658d9);font-size:10px;font-style:normal;font-weight:700}
.jsk-arrow{color:var(--dsw-alias-label-tertiary,#b3b9c4)}
.jsk-spinner{width:14px;height:14px;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 25%,transparent);border-top-color:var(--dsw-alias-brand-primary,#4f6bfe);border-radius:50%;display:inline-block;animation:jsk-spin .8s linear infinite;flex:none}
.jsk-spinner-dark{border-color:rgba(255,255,255,.35);border-top-color:#fff;width:12px;height:12px}
@keyframes jsk-spin{to{transform:rotate(360deg)}}
.jsk-panel-icon{display:grid;place-items:center;width:100%;height:100%}
.jsk-tab-title{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:180px}
.jsk-tab-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jsk-canvas{position:absolute;inset:0;background:var(--dsw-alias-bg-layer-2,#f1efec)}
.jsk-frame{display:block;width:100%;height:100%;border:0;background:#f1efec}
.jsk-canvas-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:24px;color:var(--dsw-alias-label-secondary,#68707d);font-size:12.5px;text-align:center;background:var(--dsw-alias-bg-layer-1,#fbfbfc)}
.jsk-canvas-state strong{color:var(--dsw-alias-label-primary,#3c4452);font-size:13.5px;font-weight:600}
.jsk-canvas-state strong{color:var(--dsw-alias-label-primary,#3c4452);font-size:13.5px;font-weight:600}
.jsk-picker{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1,#fbfbfc);color:var(--dsw-alias-label-primary,#1b1f26);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif}
.jsk-picker *{box-sizing:border-box}
.jsk-picker-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 12px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#eceef2)}
.jsk-picker-heading{min-width:0;flex:1}
.jsk-picker-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-picker-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa2af);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.jsk-picker-workbench{flex:none;display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4d5563);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.jsk-picker-workbench:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f7)}
.jsk-picker-list{flex:1;min-height:0;overflow:auto;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;align-content:start}
.jsk-picker-note{grid-column:1/-1;margin:0 0 2px;padding:5px 7px;border-radius:6px;background:#fdf3e3;color:#a06a12;font-size:10.5px}
.jsk-picker-status{grid-column:1/-1;display:flex;align-items:center;gap:6px;margin:0 0 2px;padding:5px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f1f3f5);color:var(--dsw-alias-label-secondary,#5f6673);font-size:10.5px}
.jsk-scan-bar{flex:none;display:flex;align-items:center;gap:6px;margin:8px 8px 0;padding:5px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f1f3f5);color:var(--dsw-alias-label-secondary,#5f6673);font-size:10.5px}
.jsk-badge-live{color:var(--dsw-alias-label-secondary,#5f6673);background:var(--dsw-alias-bg-layer-2,#f1f3f5);border-radius:5px;padding:1px 6px;font-size:11px}
.jsk-picker-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#68707d);font-size:12px}
.jsk-picker-state strong{color:var(--dsw-alias-label-primary,#3c4452);font-size:13px;font-weight:600}
.jsk-pick-card{display:flex;flex-direction:column;gap:5px;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l2,#eaecf1);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s ease, box-shadow .15s ease, transform .15s ease}
.jsk-pick-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 45%,var(--dsw-alias-border-l2,#eaecf1));box-shadow:0 6px 18px -12px rgba(16,24,40,.26);transform:translateY(-1px)}
.jsk-pick-thumb{position:relative;display:flex;align-items:center;justify-content:center;height:84px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#eef0f4);background:radial-gradient(circle at 1px 1px,#e2e6ee 1px,transparent 0) 0 0/12px 12px,linear-gradient(135deg,#f7f8fb,#f1f3f8);overflow:hidden}
.jsk-pick-thumb .jsk-card-screens{gap:4px;transform:translateY(1px)}
.jsk-pick-thumb .jsk-card-mini{width:20px;height:58px}
.jsk-pick-thumb .jsk-card-mini:nth-child(2){height:66px}
.jsk-pick-arrow{position:absolute;right:5px;bottom:5px;width:20px;height:20px;border-radius:5px;display:grid;place-items:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 86%,transparent);border:1px solid var(--dsw-alias-border-l2,#e7e9ee);color:var(--dsw-alias-label-secondary,#68707d)}
.jsk-pick-card:hover .jsk-pick-arrow{background:var(--dsw-alias-brand-primary,#4f6bfe);border-color:var(--dsw-alias-brand-primary,#4f6bfe);color:#fff}
.jsk-pick-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-pick-meta{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#68707d);white-space:nowrap;overflow:hidden}
.jsk-pick-time{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa2af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-switch{position:absolute;right:10px;bottom:10px;z-index:3;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent);color:var(--dsw-alias-label-secondary,#4d5563);font:inherit;font-size:11px;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 2px 8px rgba(0,0,0,.08)}
.jsk-switch:hover{background:var(--dsw-alias-bg-layer-1,#fff)}
`;

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        runtime = ctx;

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.dshPlugin = 'justskill-design';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'justskill-design: stylesheet');

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: () => 'JustSkill Design 工作台',
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, WorkbenchPage));

        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.get('sidebarRightTabs');
          if (tabs === undefined || typeof tabs.register !== 'function') return;

          scope.effect(() => tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => 'Canvas',
            guide: [{
              id: 'canvas',
              order: 100,
              title: () => 'JustSkill Canvas',
              description: () => '从工作台点开设计文件后，这里显示它的实时画布',
            }],
          }), 'justskill-design: canvas tab type');

          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, CanvasBody));

          ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID,
          }, CanvasTitle));
        });

        // Host tool → browser handoff. `justskill_canvas` leaves a session-scoped
        // request in the Host; this watcher is the only thing that can turn it
        // into a right-sidebar tab. It is deliberately not tied to the workbench
        // page, so it also works from an ordinary chat session.
        ctx.effect(() => {
          let stopped = false;
          let busy = false;

          const tick = async () => {
            if (stopped || busy) return;
            const sidebarRight = runtime === null ? undefined : runtime.get('sidebarRight');
            if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') return;
            let sessionId;
            try {
              sessionId = sidebarRight.mounted?.getSnapshot?.();
            } catch {
              return;
            }
            if (typeof sessionId !== 'string' || sessionId === '') return;

            busy = true;
            try {
              const value = await post('pending', { sessionId });
              const file = value && value.pending ? value.pending.file : undefined;
              if (typeof file !== 'string' || file === '') return;
              await openCanvasTab(sidebarRight, file);
              if (stopped) return;
              await post('pending/clear', { sessionId, file }).catch(() => {});
            } catch {
              // The sidebar store may not be minted yet; the next tick retries.
            } finally {
              busy = false;
            }
          };

          const timer = setInterval(() => { void tick(); }, 1500);
          void tick();
          return () => {
            stopped = true;
            clearInterval(timer);
          };
        }, 'justskill-design: canvas request watcher');
      },
    };
  },
});
