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

    /**
     * First message queued into a session created from the workbench "新建"
     * button: it starts the justSkill route in an empty workspace and keeps the
     * agent from creating the file before the idea is confirmed.
     */
    const NEW_DESIGN_PROMPT = [
      `/${SKILL}`,
      '',
      '在这个工作区新建一个设计。',
      '',
      '请先按 justSkill 的流程来：用一两句话确认我要做什么、给谁用（不清楚就问我 2-3 个关键问题），',
      '然后给出最小方案（1-5 个页面、每页的任务、需要的空/加载/错误状态），等我确认。',
      '确认后再创建 design.html（node design.mjs new design.html --name home），',
      '并用 justskill_canvas 打开画布；不要运行 design.mjs serve，也不要自己打开浏览器。',
    ].join('\n');

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

    /* ------------------------------------------------------------------ *
     * Version / update reminder (matches docs/design/workbench.html)
     * ------------------------------------------------------------------ */

    const UPDATE_DISMISS_KEY = 'justskill-design:update-dismiss';
    const UPDATE_DISMISS_MS = 24 * 60 * 60 * 1000;

    function readUpdateDismiss() {
      try {
        const raw = localStorage.getItem(UPDATE_DISMISS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        if (typeof parsed.latest !== 'string' || typeof parsed.until !== 'number') return null;
        return parsed;
      } catch {
        return null;
      }
    }

    function writeUpdateDismiss(latest, until = Date.now() + UPDATE_DISMISS_MS) {
      try {
        localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify({ latest, until }));
      } catch {
        /* private mode / quota — reminder just comes back next time */
      }
    }

    function isUpdateDismissed(latest, now = Date.now()) {
      const entry = readUpdateDismiss();
      if (entry === null) return false;
      if (entry.latest !== latest) return false;
      return entry.until > now;
    }

    function updateCommands(latest) {
      const pin = typeof latest === 'string' && latest !== '' ? `@${latest}` : '';
      return {
        dsh: `dsh plugin --profile web add justskill-design${pin}`,
        skill: 'npx skills update',
      };
    }

    function usePackageUpdate() {
      const [info, setInfo] = useState({
        local: null,
        latest: null,
        source: null,
        updateAvailable: false,
        open: false,
      });

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const value = await post('version', {});
            if (cancelled || value === null || typeof value !== 'object') return;
            const local = typeof value.local === 'string' ? value.local : null;
            const latest = typeof value.latest === 'string' ? value.latest : null;
            const updateAvailable = value.updateAvailable === true
              && latest !== null
              && !isUpdateDismissed(latest);
            setInfo((current) => ({
              ...current,
              local,
              latest,
              source: typeof value.source === 'string' ? value.source : null,
              updateAvailable,
              open: updateAvailable ? current.open : false,
            }));
          } catch {
            /* offline / host route missing — show nothing beyond a local version if we ever get one */
          }
        })();
        return () => { cancelled = true; };
      }, []);

      const dismiss = useCallback(() => {
        setInfo((current) => {
          if (typeof current.latest === 'string' && current.latest !== '') {
            writeUpdateDismiss(current.latest);
          }
          return { ...current, updateAvailable: false, open: false };
        });
      }, []);

      const toggleOpen = useCallback(() => {
        setInfo((current) => (
          current.updateAvailable ? { ...current, open: !current.open } : current
        ));
      }, []);

      const closeOpen = useCallback(() => {
        setInfo((current) => ({ ...current, open: false }));
      }, []);

      return { info, dismiss, toggleOpen, closeOpen };
    }

    function VersionBadge(props) {
      const { info, onToggle, popover } = props;
      if (typeof info.local !== 'string' || info.local === '') return null;
      return h('span', { className: 'jsk-version-wrap' },
        h('span', { className: 'jsk-version' }, `v${info.local}`),
        info.updateAvailable ? h('button', {
          type: 'button',
          className: 'jsk-update-badge',
          'aria-expanded': info.open ? 'true' : 'false',
          onClick: onToggle,
        }, `有新版 ${info.latest}`) : null,
        info.open ? popover : null);
    }

    function UpdatePopover(props) {
      const { info, onDismiss, onClose, className } = props;
      const commands = updateCommands(info.latest);
      const sourceLabel = info.source === 'npm' ? 'npm' : 'GitHub';
      return h('div', {
        className: className || 'jsk-update-pop',
        role: 'dialog',
        'aria-label': '有新版本可用',
      },
        h('div', { className: 'jsk-update-pop-head' },
          h('strong', null, '有新版本可用'),
          h('span', null, `当前 v${info.local} · 最新 ${info.latest}（${sourceLabel}）`)),
        h('div', { className: 'jsk-update-cmd' },
          h('span', null, 'DSH 插件'),
          h('code', null, commands.dsh)),
        h('div', { className: 'jsk-update-cmd' },
          h('span', null, 'Skill'),
          h('code', null, commands.skill)),
        h('div', { className: 'jsk-update-pop-foot' },
          h('span', null, '24 小时内不再提醒'),
          h('div', { className: 'jsk-update-pop-actions' },
            h('button', { type: 'button', className: 'jsk-link', onClick: onClose }, '关闭'),
            h('button', { type: 'button', className: 'jsk-button jsk-button-primary jsk-update-dismiss', onClick: onDismiss }, '知道了'))));
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

    // The Canvas tab keeps what it is showing in module state, keyed by the tab
    // id, so the body and its tab title agree without rewriting the tab's
    // navigation params. Two things can override the tab's params, and they are
    // not the same: a file the reader picked here, and the picker itself (the
    // reader asked to switch). A *new* navigation wins over both — otherwise an
    // agent opening another file would be silently ignored by the file this tab
    // remembered from an earlier pick.
    const tabFiles = new Map();
    const tabPicking = new Set();
    const tabFileListeners = new Set();
    /** Last navigation revision seen per tab, so a re-render is not a navigation. */
    const tabRevisions = new Map();

    function notifyTabFile() {
      for (const listener of tabFileListeners) listener();
    }

    function setTabFile(tabId, file) {
      if (typeof tabId !== 'string' || tabId === '') return;
      if (typeof file === 'string' && file !== '') {
        tabFiles.set(tabId, file);
        tabPicking.delete(tabId);
      } else {
        // "Show me the picker": the params of the tab still name the old file,
        // so dropping the stored one alone would just fall back to it.
        tabFiles.delete(tabId);
        tabPicking.add(tabId);
      }
      notifyTabFile();
    }

    function forgetTabChoice(tabId) {
      if (typeof tabId !== 'string' || tabId === '') return;
      tabFiles.delete(tabId);
      tabPicking.delete(tabId);
      tabRevisions.delete(tabId);
    }

    /**
     * Drop this tab's own choice when the tab is navigated somewhere with a file.
     * @param tabId - the tab.
     * @param revision - the navigation revision it reports.
     * @param paramsFile - the file the navigation named, if any.
     */
    function noteTabNavigation(tabId, revision, paramsFile) {
      if (typeof tabId !== 'string' || tabId === '') return;
      const previous = tabRevisions.get(tabId);
      tabRevisions.set(tabId, revision);
      if (previous === undefined || previous === revision) return;
      if (typeof paramsFile !== 'string' || paramsFile === '') return;
      if (tabFiles.get(tabId) === undefined && !tabPicking.has(tabId)) return;
      tabFiles.delete(tabId);
      tabPicking.delete(tabId);
      notifyTabFile();
    }

    /**
     * What one Canvas tab is showing: a picked file, the picker, or nothing (the
     * body falls back to the tab's navigation params).
     * @param tabId - the tab.
     * @returns {{file: string|undefined, picking: boolean}} the tab's own choice.
     */
    function useTabChoice(tabId) {
      const [, force] = useState(0);
      useEffect(() => {
        if (typeof tabId !== 'string' || tabId === '') return undefined;
        const listener = () => force((value) => value + 1);
        tabFileListeners.add(listener);
        return () => tabFileListeners.delete(listener);
      }, [tabId]);
      if (typeof tabId !== 'string' || tabId === '') return { file: undefined, picking: false };
      return { file: tabFiles.get(tabId), picking: tabPicking.has(tabId) };
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
      doc: (size = 14) => svg(h('path', { d: 'M5.4 3.4h6.2l3 3v10.2H5.4z' }), h('path', { d: 'M11.6 3.4v3h3' }), size),
      canvas: (size = 15) => svg(h('rect', { x: 3.2, y: 4.4, width: 13.6, height: 10.4, rx: 2.2 }), h('path', { d: 'M3.2 8.1h13.6M6.6 4.4v10.4' }), size),
      arrow: (size = 15) => svg(h('path', { d: 'M5 10h10M11 6l4 4-4 4' }), size),
      alert: (size = 15) => svg(h('circle', { cx: 10, cy: 10, r: 6.4 }), h('path', { d: 'M10 8.6v4.4M10 6v.1' }), size),
      stop: (size = 15) => svg(h('rect', { x: 6, y: 6, width: 8, height: 8, rx: 2, fill: 'currentColor', stroke: 'none' }), size),
      plus: (size = 15) => svg(h('path', { d: 'M10 4.5v11M4.5 10h11' }), size),
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
      const [state, setState] = useState({ phase: 'loading', workspaces: [], scannedAt: 0, incomplete: false, stopped: false });
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [query, setQuery] = useState('');
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [busy, setBusy] = useState(null);
      const [pickerOpen, setPickerOpen] = useState(false);
      const [pickerQuery, setPickerQuery] = useState('');
      const [creating, setCreating] = useState(null);
      const [createError, setCreateError] = useState(null);
      const { info: updateInfo, dismiss: dismissUpdate, toggleOpen: toggleUpdate, closeOpen: closeUpdate } = usePackageUpdate();
      const controller = useRef(null);
      const stopping = useRef(false);
      const pickerInput = useRef(null);
      const newButton = useRef(null);

      const stop = useCallback(() => {
        stopping.current = true;
        if (controller.current !== null) controller.current.abort();
      }, []);

      const closePicker = useCallback(() => {
        setPickerOpen(false);
        setCreateError(null);
      }, []);

      useEffect(() => {
        if (!pickerOpen) return undefined;
        pickerInput.current?.focus?.();
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            closePicker();
            newButton.current?.focus?.();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [pickerOpen, closePicker]);

      const load = useCallback(() => {
        if (controller.current !== null) controller.current.abort();
        stopping.current = false;
        if (workspaces.length === 0) {
          controller.current = null;
          setState({ phase: 'empty', workspaces: [], scannedAt: 0, incomplete: false, stopped: false });
          return;
        }
        const abort = new AbortController();
        controller.current = abort;
        const entries = new Map();
        const snapshot = () => [...entries.values()];
        setError(null);
        setState({ phase: 'loading', workspaces: [], scannedAt: 0, incomplete: false, stopped: false });

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
          if (abort.signal.aborted) {
            if (!stopping.current || controller.current !== abort) return;
            for (const workspace of entries.values()) {
              if (workspace.done !== true) {
                workspace.done = true;
                workspace.incomplete = true;
              }
            }
            setState((current) => ({
              ...current,
              phase: 'ready',
              stopped: true,
              incomplete: true,
              workspaces: snapshot(),
            }));
            return;
          }
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
          setNotice({ sessionId, message: `已新建会话并打开画布：${basename(file.path)}` });
          prompting.catch((cause) => {
            console.error('[justskill-design] initial prompt failed:', cause);
          });
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(null);
        }
      }, [busy]);

      const createDesign = useCallback(async (workspace) => {
        if (creating !== null) return;
        setCreating(workspace.id);
        setCreateError(null);
        setError(null);
        setNotice(null);
        try {
          const sessions = runtime === null ? undefined : runtime.get('sessions');
          const uiWorkspace = runtime === null ? undefined : runtime.get('uiWorkspace');
          if (sessions === undefined || typeof sessions.create !== 'function') {
            throw new Error('DSH sessions 服务不可用，无法新建会话');
          }
          const sessionId = await sessions.create({ workspaceId: workspace.id });
          try {
            uiWorkspace?.openSession?.(sessionId);
          } catch {
            /* navigation is best effort; the session is the important half */
          }
          const prompting = typeof sessions.using === 'function'
            ? sessions.using(sessionId, { source: SKILL }, async (reference) => {
              const session = reference && reference.binding ? reference.binding.session : undefined;
              if (session === undefined || typeof session.prompt !== 'function') {
                throw new Error('无法向新会话发送新建提示词');
              }
              try {
                await session.rename?.(`${workspace.title || basename(workspace.path)} · 新建设计`);
              } catch {
                /* a title is a convenience, never a blocker */
              }
              await session.prompt([{ type: 'text', text: NEW_DESIGN_PROMPT }], 'queue');
            })
            : Promise.reject(new Error('DSH sessions.using 不可用'));
          await prompting;
          setPickerOpen(false);
          setPickerQuery('');
          setNotice({
            sessionId,
            message: `已在 ${workspace.title || basename(workspace.path)} 新建会话，等待你描述设计`,
          });
        } catch (cause) {
          setCreateError(errorText(cause));
        } finally {
          setCreating(null);
        }
      }, [creating]);

      const pickerWorkspaces = useMemo(() => {
        const needle = pickerQuery.trim().toLowerCase();
        const counts = new Map();
        for (const workspace of state.workspaces) {
          counts.set(workspace.id, Array.isArray(workspace.files) ? workspace.files.length : undefined);
        }
        return workspaces
          .filter((workspace) => needle === '' || `${workspace.title} ${workspace.path}`.toLowerCase().includes(needle))
          .map((workspace) => ({ ...workspace, count: counts.get(workspace.id) }));
      }, [workspaces, state.workspaces, pickerQuery]);

      const totalLabel = totals.files === 1 ? '1 个设计文件' : `${totals.files} 个设计文件`;
      const workspaceLabel = totals.workspaces === 1 ? '1 个工作区' : `${totals.workspaces} 个工作区`;
      const scanningNow = state.phase === 'loading' || state.phase === 'scanning';
      const stopped = state.stopped === true;

      return h('div', { className: 'jsk-page' },
        h('header', { className: 'jsk-head' },
          h('div', { className: 'jsk-brand' },
            h('span', { className: 'jsk-brand-icon' }, icon.logo(24)),
            h('div', { className: 'jsk-brand-text' },
              h('div', { className: 'jsk-title-row' },
                h('h1', null, 'JustSkill Design 工作台'),
                h(VersionBadge, {
                  info: updateInfo,
                  onToggle: toggleUpdate,
                  popover: h(UpdatePopover, {
                    info: updateInfo,
                    onDismiss: dismissUpdate,
                    onClose: closeUpdate,
                  }),
                })),
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
              ref: newButton,
              className: 'jsk-button jsk-new',
              disabled: workspaces.length === 0 || creating !== null,
              title: workspaces.length === 0 ? '先在 DSH 左侧栏添加一个工作区' : '在某个工作区新建设计',
              onClick: () => {
                setPickerQuery('');
                setCreateError(null);
                setPickerOpen(true);
              },
            }, icon.plus(15), '新建'),
            scanningNow
              ? h('button', {
                type: 'button',
                className: 'jsk-button jsk-button-primary',
                onClick: stop,
              }, icon.stop(15), '停止扫描')
              : h('button', {
                type: 'button',
                className: 'jsk-button jsk-button-primary',
                onClick: () => load(),
              }, icon.refresh(), stopped ? '重新扫描' : '刷新'))),
        error !== null ? h('div', { className: 'jsk-error' }, icon.alert(), h('span', null, error)) : null,
        notice !== null ? h('div', { className: 'jsk-notice' },
          h('span', null, notice.message),
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
        stopped ? h('div', { className: 'jsk-notice' },
          icon.stop(14),
          h('span', null, `已停止扫描，仅显示已找到的 ${totals.files} 个文件`),
          h('button', { type: 'button', className: 'jsk-link', onClick: () => load() }, '重新扫描')) : null,
        h('div', { className: 'jsk-stats' },
          h('span', null, h('b', null, totals.workspaces), ' 个工作区'),
          h('i', { className: 'jsk-sep' }),
          h('span', null, h('b', null, totals.files), ' 个设计文件'),
          h('i', { className: 'jsk-sep' }),
          h('span', null, '最近更新 ', h('b', null, totals.newest === 0 ? '—' : formatTime(totals.newest))),
          h('span', { className: 'jsk-stats-right' },
            scanningNow ? '扫描中…' : stopped ? '已停止扫描' : `上次扫描 ${formatTime(state.scannedAt || Date.now())}`),
          scanningNow ? h('span', { className: 'jsk-badge-live' }, `扫描中 · 已找到 ${totals.files} 个`) : null,
          stopped ? null : state.incomplete ? h('span', { className: 'jsk-badge-warn' }, '部分工作区扫描未完成') : null),
        h('div', { className: 'jsk-list' },
          state.phase === 'loading' ? h('div', { className: 'jsk-empty' }, h('span', { className: 'jsk-spinner' }), '正在扫描工作区…') : null,
          state.phase === 'empty' ? h('div', { className: 'jsk-empty' },
            h('strong', null, '还没有工作区'),
            h('span', null, '在 DSH 左侧栏添加一个工作区后，这里会列出其中的设计文件。')) : null,
          state.phase === 'error' ? h('div', { className: 'jsk-empty' }, h('strong', null, '扫描失败'), h('span', null, error || '请稍后重试')) : null,
          groups.length === 0 && state.phase === 'ready' ? h('div', { className: 'jsk-empty' },
            h('strong', null, stopped
              ? '已停止扫描，还没有找到设计文件'
              : query.trim() === '' ? '没有找到设计文件' : '没有匹配的设计文件'),
            h('span', null, stopped
              ? '点右上角「重新扫描」可以继续。'
              : query.trim() === '' ? '设计文件需要带有 <meta name="design-schema"> 标记；让 agent 用 justSkill 新建一个 design.html 试试。' : '换一个关键词，或清空搜索。')) : null,
          groups.map((workspace) => {
            const isCollapsed = collapsed.has(workspace.id);
            return h('section', { className: 'jsk-group', key: workspace.id },
              h('button', { type: 'button', className: 'jsk-group-head', onClick: () => toggleGroup(workspace.id) },
                h('span', { className: `jsk-chevron ${isCollapsed ? 'jsk-chevron-closed' : ''}` }, icon.chevron()),
                h('span', { className: 'jsk-ws-badge' }, (workspace.title || '?').slice(0, 1)),
                h('span', { className: 'jsk-ws-name' }, workspace.title || basename(workspace.path)),
                h('span', { className: 'jsk-ws-path' }, workspace.path),
                h('span', { className: 'jsk-count' }, `${workspace.files.length} 个文件${workspace.done === false && !stopped ? '…' : ''}`)),
              isCollapsed ? null : h('div', { className: 'jsk-grid' },
                workspace.done === false && !stopped && workspace.files.length > 0
                  ? h('div', { className: 'jsk-picker-status' }, h('span', { className: 'jsk-spinner' }), '扫描中，列表还会继续增加…')
                  : null,
                workspace.incomplete === true && workspace.files.length > 0
                  ? h('div', { className: 'jsk-picker-note' }, stopped ? '已停止扫描，列表可能不完整' : '扫描达到时间上限，列表可能不完整')
                  : null,
                workspace.files.length === 0
                  ? h('div', { className: 'jsk-row-empty' },
                    stopped ? '已停止扫描'
                      : workspace.done === false ? '正在扫描…'
                        : workspace.incomplete === true ? '扫描达到时间上限，暂时没扫到设计文件' : '这个工作区里还没有设计文件')
                  : workspace.files.map((file) => renderFileCard(file, workspace, busy, activate))));
          }),
        ),
        h('footer', { className: 'jsk-foot' },
          h('span', { className: 'jsk-step' }, h('i', null, '1'), '点设计文件'),
          h('span', { className: 'jsk-arrow' }, '→'),
          h('span', { className: 'jsk-step' }, h('i', null, '2'), '该工作区自动新建会话'),
          h('span', { className: 'jsk-arrow' }, '→'),
          h('span', { className: 'jsk-step' }, h('i', null, '3'), '右侧栏打开画布，边聊边改')),
        pickerOpen ? h('div', { className: 'jsk-modal-backdrop', onClick: closePicker },
          h('div', {
            className: 'jsk-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '选择工作区新建设计',
            onClick: (event) => event.stopPropagation(),
          },
          h('div', { className: 'jsk-modal-head' },
            h('p', { className: 'jsk-modal-title' }, '在哪个工作区新建设计？'),
            h('p', { className: 'jsk-modal-sub' }, '会为该工作区新建会话，并带过去一条「新建设计」提示词。')),
          h('label', { className: 'jsk-modal-search' },
            icon.search(15),
            h('input', {
              ref: pickerInput,
              value: pickerQuery,
              placeholder: '搜索工作区…',
              spellCheck: false,
              onChange: (event) => setPickerQuery(event.target.value),
            })),
          h('div', { className: 'jsk-modal-list' },
            pickerWorkspaces.length === 0
              ? h('div', { className: 'jsk-modal-empty' }, '没有匹配的工作区')
              : pickerWorkspaces.map((workspace) => h('button', {
                type: 'button',
                key: workspace.id,
                className: 'jsk-modal-row',
                disabled: creating !== null,
                onClick: () => createDesign(workspace),
              },
              h('span', { className: 'jsk-modal-badge' }, (workspace.title || '?').slice(0, 1)),
              h('span', { className: 'jsk-modal-info' },
                h('span', { className: 'jsk-modal-name' }, workspace.title || basename(workspace.path)),
                h('span', { className: 'jsk-modal-path' }, workspace.path)),
              creating === workspace.id
                ? h('span', { className: 'jsk-spinner' })
                : h('span', { className: 'jsk-modal-count' },
                  workspace.count === undefined ? '—'
                    : workspace.count === 0 ? '还没有文件'
                      : `${workspace.count} 个文件`)))),
          createError !== null ? h('div', { className: 'jsk-modal-error' }, createError) : null,
          h('div', { className: 'jsk-modal-foot' },
            h('span', { className: 'jsk-modal-hint' }, '没有想要的工作区？在 DSH 左侧栏添加'),
            h('button', { type: 'button', className: 'jsk-link', onClick: closePicker }, '取消')))) : null);
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
      const navigation = info && info.tab ? info.tab.navigation : undefined;
      const paramsFile = navigation && navigation.params ? navigation.params.file : undefined;
      const navigationRevision = navigation ? navigation.revision : undefined;
      const choice = useTabChoice(tabId);
      const file = choice.picking
        ? undefined
        : typeof choice.file === 'string' && choice.file !== ''
          ? choice.file
          : paramsFile;
      const [state, setState] = useState({ phase: file ? 'loading' : 'pick' });
      const [ticket, setTicket] = useState(0);

      // A navigation that names a file replaces whatever this tab chose itself.
      useEffect(() => {
        noteTabNavigation(tabId, navigationRevision, paramsFile);
      }, [tabId, navigationRevision, paramsFile]);

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
        forgetTabChoice(tabId);
      }, [tabId]);

      // The chip route addresses this exact tab: it is the one that can be
      // pointed at another file, and the one whose iframe receives the select.
      useEffect(() => {
        if (typeof tabId !== 'string' || tabId === '') return undefined;
        canvasTabId = tabId;
        return () => {
          if (canvasTabId === tabId) canvasTabId = undefined;
        };
      }, [tabId]);

      if (typeof file !== 'string' || file === '') {
        return h(CanvasPicker, {
          sessionId: props.sessionId,
          onPick: (picked) => setTabFile(tabId, picked),
        });
      }

      if (state.phase === 'ready') {
        // Every displayed canvas can switch files: the tab is the reader's to
        // aim, whether the file arrived from the workbench, an agent tool or the
        // picker inside this tab.
        return h(React.Fragment, null,
          h('iframe', {
            className: 'jsk-frame',
            src: state.url,
            title: `JustSkill Design canvas — ${basename(file)}`,
            referrerPolicy: 'no-referrer',
            // The only window a chip's `select` command is addressed to. The
            // canvas posts its element list up from this frame; see canvas/app.mjs.
            ref: (node) => { if (node !== null) canvasFrame = node; },
          }),
          h('button', {
            type: 'button',
            className: 'jsk-switch',
            title: '换一个设计文件',
            onClick: () => setTabFile(tabId, undefined),
          }, icon.folder(13), '设计文件'));
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
      const navigation = info && info.tab ? info.tab.navigation : undefined;
      const paramsFile = navigation && navigation.params ? navigation.params.file : undefined;
      const choice = useTabChoice(tabId);
      const file = choice.picking
        ? undefined
        : typeof choice.file === 'string' && choice.file !== ''
          ? choice.file
          : paramsFile;
      return h('span', { className: 'jsk-tab-title' }, icon.canvas(14), h('span', null, typeof file === 'string' && file !== '' ? basename(file) : 'Canvas'));
    }

    function PanelIcon() {
      return h('span', { className: 'jsk-panel-icon', title: 'JustSkill Design 工作台' }, icon.logo(20));
    }

    /* ------------------------------------------------------------------ *
     * Canvas references in the composer
     *
     * The canvas tab posts its element list up through `postMessage` (see
     * `canvas/app.mjs`). That list is everything the composer needs: the `@`
     * menu lists it, the composer recognises those names in pasted text, and a
     * clicked chip resolves against it. The plugin never reads the file — the
     * canvas is the only reader, so "what exists right now" has one answer.
     *
     * A chip is an atomic node the composer stores as
     * `{ source, ref, label, appearance, clipboardText }`; `ref` is the element
     * id, `clipboardText` is `@<id>`, and `codec.serialize` is what the model
     * receives. That split is the point: the composer shows one short chip and
     * the model gets the whole pointer sentence.
     *
     * Three ways in, in the order people meet them:
     *
     *   1. ⌘C on the canvas, then paste here — the capture listener claims the
     *      pointer and inserts one chip (see "Paste" below).
     *   2. type `@` — the menu lists elements, a pick inserts the same chip.
     *   3. paste a bare `@<id>` — the lexicon makes it clickable text, which is
     *      the only shape a plain-text paste can take (the composer deliberately
     *      grows no chip out of text it did not intercept).
     * ------------------------------------------------------------------ */

    /** Source name the composer stores on every chip and routes clicks by. */
    const CANVAS_SOURCE = 'justskill-canvas';
    /**
     * Whether `@` also lists the canvas's elements. Off — the default — leaves
     * the source registered (paste, recognition and chip clicks keep working)
     * and only drops the menu, whose rows would be the file's own layer names
     * (`list`, `root`, `empty`): a 2600-element file turns that menu into a
     * directory listing of the source. Element references enter by ⌘C + paste,
     * the way the reader already points at things.
     */
    const CANVAS_MENU = false;
    /** How long a chip may wait for a canvas that is still opening. */
    const PENDING_SELECT_MS = 15_000;

    /** What the on-screen canvas last said it contains, this file only. */
    let canvasIndex = {
      file: null, path: null, revision: null, rows: [], names: [], byRef: new Map(),
    };
    const canvasIndexListeners = new Set();
    /** The mounted canvas frame — the only window these commands address. */
    let canvasFrame = null;
    /** The mounted canvas tab, so a chip can point that same tab at another file. */
    let canvasTabId;
    /** A chip whose element the canvas has not been told about yet. */
    let pendingSelect = null;

    function canvasIndexChanged() {
      for (const listener of canvasIndexListeners) {
        try {
          listener();
        } catch {
          /* one listener must not silence the rest */
        }
      }
    }

    function setCanvasIndex(payload) {
      const rows = [];
      const names = [];
      const byRef = new Map();
      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      for (const element of elements) {
        if (element === null || typeof element !== 'object') continue;
        const ref = typeof element.id === 'string' ? element.id : '';
        if (ref === '') continue;
        const label = typeof element.name === 'string' && element.name !== '' ? element.name : ref;
        const text = typeof element.text === 'string' ? element.text : '';
        const pageId = typeof element.pageId === 'string' && element.pageId !== '' ? element.pageId : null;
        const pageName = typeof element.pageName === 'string' ? element.pageName : '';
        rows.push({ ref, label, text, pageId, pageName });
        byRef.set(ref, { ref, label, text, pageId, pageName });
        // Only names the composer can see in plain text are worth handing it.
        if (/^[\w-]+$/.test(ref)) names.push(ref);
      }
      canvasIndex = {
        file: typeof payload.file === 'string' ? payload.file : null,
        path: typeof payload.path === 'string' ? payload.path : null,
        revision: typeof payload.revision === 'string' ? payload.revision : null,
        rows,
        names,
        byRef,
      };
      canvasIndexChanged();
    }

    function postToCanvas(command, payload) {
      const frame = canvasFrame;
      if (frame === null || frame.isConnected === false) return false;
      const target = frame.contentWindow;
      if (target === null || typeof target.postMessage !== 'function') return false;
      target.postMessage({ type: 'jsk-canvas', command, ...payload }, '*');
      return true;
    }

    /** `C:\a\b.html` → `file:///c%3A/a/b.html`, `/a/b.html` → `file:///a/b.html`. */
    function fileUriOf(absolute) {
      const slashed = String(absolute).replace(/\\/g, '/');
      const drive = /^([A-Za-z]):\//.exec(slashed);
      const rest = drive ? `/${drive[1].toLowerCase()}%3A${slashed.slice(2)}` : slashed;
      return `file://${rest.split('/').map((part, index) => (drive && index === 1 ? part : encodeURIComponent(part))).join('/')}`;
    }

    /**
     * What the model reads in place of a chip. The same pointer the canvas's
     * own ⌘C copies, so a chip and a pasted sentence mean one thing to the agent.
     * @param {string} ref element id.
     * @returns {string} the prompt text.
     */
    /**
     * A chip's `ref` is opaque to the composer, so it carries the whole pointer:
     * `fileUri`, `pageId`, element `id`. That is what lets a pasted chip keep
     * working after the canvas switches to another file, and what lets the model
     * get the same sentence the canvas copied without depending on the canvas
     * still being open. A NUL separates the fields: it cannot occur in a path or
     * an id, and `ref` is never displayed.
     */
    const REF_SEPARATOR = '\u0000';

    /**
     * @param {{uri?: string|null, pageId?: string|null, id: string}} target pointer fields.
     * @returns {string} the chip ref.
     */
    function encodeRef(target) {
      return [target.uri ?? '', target.pageId ?? '', target.id].join(REF_SEPARATOR);
    }

    /**
     * @param {string} ref chip ref.
     * @returns {{uri: string|null, pageId: string|null, id: string}} pointer fields.
     */
    function decodeRef(ref) {
      const parts = String(ref === undefined || ref === null ? '' : ref).split(REF_SEPARATOR);
      if (parts.length < 3) return { uri: null, pageId: null, id: parts[0] ?? '' };
      return {
        uri: parts[0] === '' ? null : parts[0],
        pageId: parts[1] === '' ? null : parts[1],
        id: parts[2] ?? '',
      };
    }

    /**
     * The pointer sentence the canvas itself copies — the model-facing half of
     * every chip, byte for byte the same text ⌘C puts on the clipboard.
     * @param {{uri: string|null, pageId: string|null, id: string}} target pointer fields.
     * @returns {string} the prompt text.
     */
    function canvasRefSentence(target) {
      const uri = target.uri !== null && target.uri !== ''
        ? target.uri
        : (typeof canvasIndex.path === 'string' && canvasIndex.path !== '' ? fileUriOf(canvasIndex.path) : '');
      const where = target.pageId !== null && target.pageId !== '' && target.pageId !== target.id
        ? `. Page id: ${target.pageId}`
        : '';
      return `Use justSkill tools. Current file ${uri}${where}. Selected node ids: ${target.id}`;
    }

    /**
     * A `file://` uri back to an absolute path, for reopening the canvas a chip
     * names. Mirrors `fileUriOf`, including the Windows drive form.
     * @param {string} uri the uri.
     * @returns {string|null} an absolute path, or null when it is not a file uri.
     */
    function pathFromFileUri(uri) {
      if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
      const rest = uri.slice('file://'.length);
      const parts = rest.split('/').map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
      if (/^\/[A-Za-z]%3A/.test(rest) || /^\/[A-Za-z]:/.test(rest)) {
        return `${parts[1]}/${parts.slice(2).join('/')}`;
      }
      return parts.join('/');
    }

    /**
     * The display name of one element, when the canvas on screen can name it.
     * @param {string} id element id.
     * @returns {string} the element name, or the id itself.
     */
    function labelOfCanvasRef(id) {
      const row = canvasIndex.byRef.get(id);
      return row === undefined ? id : row.label;
    }

    /**
     * Put a click on the canvas where the chip says. The canvas may be on
     * screen already (post straight through) or still opening (queue the id, and
     * the element list it posts when it is ready flushes it).
     * @param {string} ref element id.
     * @returns {boolean} whether this plugin accepted the click.
     */
    function requestCanvasSelect(target) {
      if (target.id === '') return false;
      // The canvas on screen can answer immediately; one showing another file
      // has to be switched first, and the switch loses the old file's id.
      const onScreen = typeof canvasIndex.path === 'string'
        && canvasIndex.path !== ''
        && (target.path === null || target.path === canvasIndex.path);
      if (onScreen && postToCanvas('select', { id: target.id })) return true;
      const absolute = target.path ?? (typeof canvasIndex.path === 'string' ? canvasIndex.path : '');
      if (absolute === '') return false;
      // An open canvas tab keeps its file in module state, which outranks the
      // tab's navigation params — so a chip pointing at another file has to
      // hand that state the file, or the tab would keep showing the old one.
      if (canvasTabId !== undefined) setTabFile(canvasTabId, absolute);
      const sidebarRight = runtime === null ? undefined : runtime.get('sidebarRight');
      if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') return false;
      pendingSelect = { id: target.id, path: absolute, at: Date.now() };
      void (async () => {
        try {
          let sessionId;
          try {
            sessionId = sidebarRight.mounted?.getSnapshot?.();
          } catch {
            sessionId = undefined;
          }
          if (typeof sessionId === 'string' && sessionId !== '') {
            await waitForMounted(sidebarRight, sessionId, 3000);
          }
          await openCanvasTab(sidebarRight, absolute);
        } catch {
          /* the tab is already there, or the sidebar is busy: the queue still tries */
        }
        flushPendingSelect();
      })();
      return true;
    }

    function flushPendingSelect() {
      const pending = pendingSelect;
      if (pending === null) return;
      if (Date.now() - pending.at > PENDING_SELECT_MS) {
        pendingSelect = null;
        return;
      }
      // Wait for the canvas that holds the element, not just any canvas.
      if (typeof canvasIndex.path !== 'string' || canvasIndex.path !== pending.path) return;
      if (postToCanvas('select', { id: pending.id })) pendingSelect = null;
    }

    /** One candidate's opaque payload (the menu hands it back on pick). */
    function readCanvasCandidateValue(value) {
      if (typeof value !== 'string') return null;
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.ref === 'string') {
          return { ref: parsed.ref };
        }
      } catch {
        /* a value this source did not write */
      }
      return null;
    }

    /**
     * The `@` source: canvas elements as atomic reference chips.
     * @returns {object} the trigger source registered with `ctx.inputTriggers`.
     */
    function canvasReferenceSource() {
      return {
        trigger: '@',
        name: CANVAS_SOURCE,
        order: 20,
        // The built-in file/session source renders no group row and names its
        // sections per row; this one does the same and puts the page there.
        showGroupTitle: false,
        async candidates(_session, request) {
          const rows = canvasIndex.rows;
          if (!CANVAS_MENU || rows.length === 0) return [];
          const query = typeof request.query === 'string' ? request.query.trim().toLowerCase() : '';
          const out = [];
          for (const row of rows) {
            // The menu is a picker, not a page: a file with hundreds of rows is
            // narrowed by typing instead of scrolled.
            if (out.length >= 24) break;
            if (query !== ''
              && !row.label.toLowerCase().includes(query)
              && !row.ref.toLowerCase().includes(query)) continue;
            // The id is the description only when the label is something else;
            // otherwise the element's own text is what tells two rows apart.
            const description = row.label === row.ref ? row.text : row.ref;
            out.push({
              name: row.label,
              ...(description === '' ? {} : { description }),
              icon: 'file',
              section: row.pageName !== '' ? row.pageName : '画布',
              value: JSON.stringify({ ref: row.ref }),
            });
          }
          return out;
        },
        onPick(pick) {
          const value = readCanvasCandidateValue(pick.candidate.value);
          if (value === null) return undefined;
          const row = canvasIndex.byRef.get(value.ref);
          const uri = typeof canvasIndex.path === 'string' && canvasIndex.path !== ''
            ? fileUriOf(canvasIndex.path)
            : null;
          return {
            insert: {
              source: CANVAS_SOURCE,
              ref: encodeRef({ uri, pageId: row === undefined ? null : row.pageId, id: value.ref }),
              label: labelOfCanvasRef(value.ref),
              appearance: 'file',
              clipboardText: `@${value.ref}`,
            },
          };
        },
        // The names the composer decorates in plain text — this is what makes a
        // pasted `@home__hero-title` clickable without being an atomic chip.
        lexicon() {
          return canvasIndex.names.length === 0 ? undefined : canvasIndex.names;
        },
        subscribeLexicon(_session, listener) {
          canvasIndexListeners.add(listener);
          return () => canvasIndexListeners.delete(listener);
        },
        openReference(_session, reference) {
          const raw = String(reference === undefined || reference === null || reference.ref === undefined
            ? ''
            : reference.ref);
          if (raw === '') return false;
          // A chip carries the encoded pointer; editable text carries only the
          // visible `@id` token, and then the canvas on screen is the only file
          // it can mean.
          if (raw.startsWith('@')) return requestCanvasSelect({ id: raw.slice(1), path: null });
          const decoded = decodeRef(raw);
          return requestCanvasSelect({
            id: decoded.id,
            path: decoded.uri === null ? null : pathFromFileUri(decoded.uri),
          });
        },
        codec: {
          clipboardText: (ref) => `@${decodeRef(ref).id}`,
          serialize: async (ref) => canvasRefSentence(decodeRef(ref)),
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Paste: a copied pointer becomes one chip
     *
     * The canvas copies a pointer sentence (`Use justSkill tools. Current file
     * … Selected node ids: …`). Pasting it here replaces it with one atomic chip
     * whose visible half is the element name and whose model half is that same
     * sentence — the composer's own display/serialize split.
     *
     * This has to happen before the editor sees the paste: the composer reads
     * only `text/plain` and deliberately grows no chip out of pasted text (it
     * strips the private-use placeholder one would need). A capture listener on
     * the window runs first; the insert then goes through the public input face,
     * exactly as a menu pick would.
     * ------------------------------------------------------------------ */

    /** The ⌘C pointer a canvas selection copies. */
    const POINTER_PASTE_RE = /^Use justSkill tools\. Current file (\S+?)(?:\. Page id: (\S+?))?\. Selected node ids: ([\w-]+)$/;
    /** A bare reference — what copying a chip out of the composer puts on the clipboard. */
    const BARE_PASTE_RE = /^@([\w-]+)$/;

    /**
     * The composer face of the session on screen. Captured by the pass-through
     * slot entry below, because a paste outside any slot still needs the public
     * `captureInsertion()` span and the session-scope input facade.
     */
    let inputFace = null;

    /**
     * Read one paste as a canvas reference.
     * @param {string} text clipboard `text/plain`.
     * @returns {{ref: string, label: string, raw: string}|null} the reference, or null to leave the paste alone.
     */
    function readPointerPaste(text) {
      const trimmed = text.trim();
      const bare = BARE_PASTE_RE.exec(trimmed);
      if (bare !== null) {
        // A bare token has no file of its own, so it must be an element the
        // canvas on screen knows — otherwise `@word` is just prose.
        const row = canvasIndex.byRef.get(bare[1]);
        return row === undefined ? null : { uri: null, pageId: row.pageId, id: row.ref, label: row.label, raw: text };
      }
      const pointer = POINTER_PASTE_RE.exec(trimmed);
      if (pointer === null) return null;
      // The sentence names its own file: the chip must not depend on the canvas
      // it came from still being the one on screen.
      const id = pointer[3];
      const row = canvasIndex.byRef.get(id);
      return {
        uri: pointer[1],
        pageId: typeof pointer[2] === 'string' && pointer[2] !== '' ? pointer[2] : null,
        id,
        label: row === undefined ? id : row.label,
        raw: text,
      };
    }

    /**
     * Say why one paste could not become a chip. Silently degrading is what made
     * the first three attempts unreadable; this is the one line to ask for.
     * @param {string} stage where it stopped.
     * @param {unknown} [cause] the thrown value, when there was one.
     */
    function notePasteFailure(stage, cause) {
      const detail = cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`;
      console.info(`[justskill-design] pointer paste: no chip (${stage})${detail}`);
    }

    /**
     * The session one composer face belongs to.
     *
     * A conversation slot's standard props carry the input face but not always a
     * session id, and the substance is that the face is *for* the session the
     * right sidebar is showing — that is the composer on screen.
     * @param {{sessionId?: string}} face captured composer face.
     * @returns {string} the session id, or '' when the plugin cannot tell.
     */
    function sessionIdOfFace(face) {
      if (typeof face.sessionId === 'string' && face.sessionId !== '') return face.sessionId;
      const sidebarRight = runtime === null ? undefined : runtime.get('sidebarRight');
      if (sidebarRight === undefined || sidebarRight === null || sidebarRight.mounted === undefined) return '';
      try {
        const mounted = sidebarRight.mounted.getSnapshot();
        return typeof mounted === 'string' ? mounted : '';
      } catch {
        return '';
      }
    }

    /**
     * The per-session input registry.
     *
     * It lives on the root `conversation` service (the scope-addressed
     * ConversationController), not on the `uiConversation` assembly registry —
     * those are two services with similar names and only one has `input`.
     * @returns {object|null} the resolver, or null when neither service is up.
     */
    function inputResolver() {
      if (runtime === null) return null;
      for (const name of ['conversation', 'uiConversation']) {
        const service = runtime.get(name);
        if (service === undefined || service === null) continue;
        const resolver = service.input;
        if (resolver !== undefined && resolver !== null && typeof resolver.for === 'function') return resolver;
      }
      return null;
    }

    /**
     * The session-scope input facade for one session.
     * @param {string} sessionId session whose composer receives the chip.
     * @returns {object|null} the facade, or null when the session is not retained.
     */
    function sessionInputOf(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const resolver = inputResolver();
      if (resolver === null) return null;
      const sessions = runtime === null ? undefined : runtime.get('sessions');
      if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return null;
      const binding = sessions.binding(sessionId);
      if (binding === undefined || binding === null || binding.ctx === undefined) return null;
      try {
        return resolver.for(binding.ctx);
      } catch {
        return null;
      }
    }

    /**
     * Insert the parsed pointer as one chip at the caret.
     * @param {{ref: string, label: string, raw: string}} parsed the reference.
     * @returns {'inserted'|'text'|'failed'} what the editor accepted.
     */
    function insertPastedReference(parsed) {
      const face = inputFace;
      if (face === null || face.inputActions === undefined || face.inputActions === null) {
        notePasteFailure('no composer face');
        return 'failed';
      }
      let span;
      try {
        span = face.inputActions.captureInsertion();
      } catch (cause) {
        notePasteFailure('no caret', cause);
        return 'failed';
      }
      const insert = {
        source: CANVAS_SOURCE,
        ref: encodeRef({ uri: parsed.uri, pageId: parsed.pageId, id: parsed.id }),
        label: parsed.label,
        appearance: 'file',
        clipboardText: `@${parsed.id}`,
      };
      const input = sessionInputOf(sessionIdOfFace(face));
      if (input === null) {
        notePasteFailure('no session input facade');
      } else {
        const state = input.state !== undefined && input.state !== null && typeof input.state.getSnapshot === 'function'
          ? input.state.getSnapshot()
          : null;
        // The chip replaces the caret, which no locked phase allows. A locked
        // composer takes no edit at all, not even the text fallback.
        if (state !== null && state.phase !== 'plain') {
          notePasteFailure(`composer is ${state.phase}`);
          return 'failed';
        } else if (input.insertReference(insert, span) === true) {
          try {
            input.focus();
          } catch {
            /* focus is cosmetic here: the paste already happened where the caret was */
          }
          return 'inserted';
        } else {
          notePasteFailure('the editor refused the chip');
        }
      }
      // The chip is out of reach; the clipboard is read-only during a paste, so
      // the degrade is done by editing: land the visible token, which the
      // source's lexicon turns into a clickable reference on the next scan.
      try {
        if (face.inputActions.insertText(`@${parsed.id}`, span) === true) return 'text';
      } catch (cause) {
        notePasteFailure('no text fallback', cause);
      }
      return 'failed';
    }

    /**
     * The composer a paste is heading into, if any.
     *
     * The event's own path says where it goes, which is truer than the focused
     * element (a paste can be dispatched at the editor while focus sits on a
     * control). The focused element is the fallback for engines that do not
     * compose the path.
     * @param {ClipboardEvent} event the paste.
     * @returns {boolean} whether the paste lands in a composer.
     */
    function pasteTargetsComposer(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (node === null || node === undefined || typeof node !== 'object') continue;
        if (typeof node.closest === 'function' && node.closest('[data-composer-input]') !== null) return true;
      }
      const active = document.activeElement;
      if (active === null || typeof active !== 'object' || typeof active.closest !== 'function') return false;
      return active.closest('[data-composer-input]') !== null;
    }

    /**
     * Capture-phase paste: turn a copied pointer into one chip.
     *
     * Three outcomes, and the clipboard is only claimed once one of the first
     * two is certain — losing a paste is worse than leaving it as text:
     *   - the chip landed → claim the paste;
     *   - the chip could not be built but the sentence could be typed → claim it;
     *   - neither → rewrite the clipboard to the bare `@<id>` and let the normal
     *     paste run, which the source's lexicon decorates into a clickable
     *     reference. The paste never becomes nothing.
     * @param {ClipboardEvent} event the paste.
     */
    function handleReferencePaste(event) {
      const clipboard = event.clipboardData;
      if (clipboard === null || clipboard === undefined || typeof clipboard.getData !== 'function') return;
      const text = clipboard.getData('text/plain');
      if (typeof text !== 'string' || text === '') return;
      const parsed = readPointerPaste(text);
      if (parsed === null) return;
      // Only the composer's own editor: a settings field, or another session's
      // composer, keeps its ordinary paste.
      if (!pasteTargetsComposer(event)) return;
      const face = inputFace;
      const outcome = face === null ? 'failed' : insertPastedReference(parsed);
      if (outcome === 'failed') {
        // Recognised, but unreachable: the ordinary paste stays, which is still a
        // sentence the agent can read. The console line above says where it stopped.
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }

    /**
     * Pass-through slot entry: it renders nothing and exists to keep the current
     * composer face reachable from a paste handler that runs outside any slot.
     * The same null-rendering entry the trigger menu uses on this slot.
     * @param {object} props session-scope slot props.
     * @returns {null} nothing to draw.
     */
    function ComposerInputBridge(props) {
      inputFace = { sessionId: props.sessionId, inputActions: props.inputActions };
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Sent text: the pointer sentence reads as the chip again
     *
     * A sent message carries the model form (`codec.serialize`), so the history
     * otherwise shows the whole sentence where the composer showed one short
     * chip. This registers the same sentence as a UserText node: the text is
     * untouched — copying and editing still give the sentence back — but it is
     * drawn as the chip the reader wrote.
     * ------------------------------------------------------------------ */

    /** The pointer sentence inside sent text (never global: `match` slices). */
    const SENT_POINTER_RE = /Use justSkill tools\. Current file (\S+?)(?:\. Page id: (\S+?))?\. Selected node ids: ([\w-]+)/;

    /** One pointer sentence as one inline node. */
    const canvasPointerRule = {
      id: 'justskill',
      order: 40,
      /**
       * @param {string} text the whole user message.
       * @param {number} from where the calculator resumes.
       * @returns {{id: string, start: number, end: number, data: object}|undefined} the next node.
       */
      match(text, from) {
        const found = SENT_POINTER_RE.exec(text.slice(from));
        if (found === null) return undefined;
        const start = from + found.index;
        const id = found[3];
        return {
          id: 'justskill',
          start,
          end: start + found[0].length,
          data: {
            ref: encodeRef({
              uri: found[1],
              pageId: typeof found[2] === 'string' && found[2] !== '' ? found[2] : null,
              id,
            }),
            label: labelOfCanvasRef(id),
          },
        };
      },
    };

    /**
     * Draw one sent pointer as the chip the composer showed.
     * @param {object} props UserText node props (`node.data`, `raw`, `interactive`).
     * @returns {object} the inline chip.
     */
    function CanvasUserText(props) {
      const data = props.node !== undefined && props.node !== null && typeof props.node.data === 'object' && props.node.data !== null
        ? props.node.data
        : {};
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const decoded = decodeRef(ref);
      const label = typeof data.label === 'string' && data.label !== '' ? data.label : decoded.id;
      const interactive = props.interactive === true && ref !== '';
      const activate = () => {
        if (ref === '') return;
        requestCanvasSelect({ id: decoded.id, path: decoded.uri === null ? null : pathFromFileUri(decoded.uri) });
      };
      return h('span', {
        className: `jsk-refchip${interactive ? ' jsk-refchip-on' : ''}`,
        title: typeof props.raw === 'string' ? props.raw : label,
        ...(interactive
          ? {
            role: 'button',
            tabIndex: 0,
            onClick: activate,
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              activate();
            },
          }
          : {}),
      },
      h('span', { className: 'jsk-refchip-icon' }, icon.doc(14)),
      h('span', { className: 'jsk-refchip-label' }, label));
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.jsk-page{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;padding:24px 32px 0;background:var(--dsw-alias-bg-layer-1,#fbfbfc);color:var(--dsw-alias-label-primary,#1b1f26);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Segoe UI",sans-serif;box-sizing:border-box}
.jsk-page *{box-sizing:border-box}
.jsk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.jsk-brand{display:flex;align-items:center;gap:13px;min-width:0}
.jsk-brand-icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:#fff;flex:none;background:linear-gradient(135deg,#5a73ff,#93a2ff);box-shadow:0 6px 16px rgba(79,107,254,.22)}
.jsk-brand-text{display:flex;flex-direction:column;gap:5px;min-width:0}
.jsk-title-row{display:flex;align-items:center;gap:8px;min-width:0;position:relative;flex-wrap:wrap}
.jsk-brand h1{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.2px}
.jsk-brand p{margin:0;color:var(--dsw-alias-label-secondary,#68707d);font-size:12.5px;line-height:1.45}
.jsk-version-wrap{display:inline-flex;align-items:center;gap:6px;position:relative;flex:none}
.jsk-version{padding:2px 7px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f4f5f8);color:var(--dsw-alias-label-secondary,#68707d);font-size:11px;font-weight:500;line-height:1.4;white-space:nowrap}
.jsk-update-badge{padding:2px 8px;border:0;border-radius:999px;background:#fdf3e3;color:#a06a12;font:inherit;font-size:11px;font-weight:600;line-height:1.4;cursor:pointer;white-space:nowrap}
.jsk-update-badge:hover{filter:brightness(.97)}
.jsk-update-pop{position:absolute;left:0;top:calc(100% + 8px);z-index:30;display:flex;flex-direction:column;gap:12px;width:320px;padding:14px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 12px 32px -12px rgba(16,24,40,.4)}
.jsk-update-pop-head{display:flex;flex-direction:column;gap:4px}
.jsk-update-pop-head strong{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1f26)}
.jsk-update-pop-head span{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#68707d)}
.jsk-update-cmd{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid #eef0f4;border-radius:10px;background:#f7f8fa}
.jsk-update-cmd span{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-update-cmd code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-primary,#1b1f26);white-space:pre-wrap;word-break:break-all}
.jsk-update-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.jsk-update-pop-foot>span{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-update-pop-actions{display:flex;align-items:center;gap:10px}
.jsk-update-dismiss{height:30px;padding:0 12px;font-size:12px}
.jsk-actions{display:flex;align-items:center;gap:9px;padding-top:2px;flex:none}
.jsk-search{width:280px;height:35px;display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-search input{width:100%;border:0;outline:0;background:none;color:var(--dsw-alias-label-primary,#1b1f26);font:inherit}
.jsk-search input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-button{height:35px;display:inline-flex;align-items:center;gap:7px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#3c4452);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.jsk-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f7)}
.jsk-button:disabled{opacity:.55;cursor:default}
.jsk-button-primary{background:var(--dsw-alias-brand-primary,#4f6bfe);border-color:var(--dsw-alias-brand-primary,#4f6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 2px 6px rgba(79,107,254,.22)}
.jsk-button-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 88%,#000);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 88%,#000)}
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
.jsk-modal-backdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,17,21,.28);backdrop-filter:blur(2px)}
.jsk-modal{width:460px;max-width:100%;max-height:72%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:16px;box-shadow:0 24px 60px -24px rgba(16,24,40,.38);overflow:hidden}
.jsk-modal-head{display:flex;flex-direction:column;gap:4px;padding:18px 18px 12px}
.jsk-modal-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.jsk-modal-sub{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#68707d)}
.jsk-modal-search{display:flex;align-items:center;gap:8px;margin:0 18px 10px;padding:0 11px;height:35px;border:1px solid var(--dsw-alias-border-l2,#e7e9ee);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-modal-search input{width:100%;border:0;outline:0;background:none;color:var(--dsw-alias-label-primary,#1b1f26);font:inherit;font-size:12.5px}
.jsk-modal-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:0 8px 8px}
.jsk-modal-row{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.jsk-modal-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f6fa)}
.jsk-modal-row:disabled{cursor:default;opacity:.72}
.jsk-modal-badge{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6bfe) 10%,transparent);color:var(--dsw-alias-brand-primary,#4658d9);font-size:12px;font-weight:700}
.jsk-modal-info{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.jsk-modal-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-modal-path{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa2af);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jsk-modal-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#68707d);white-space:nowrap}
.jsk-modal-empty{padding:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#68707d)}
.jsk-modal-error{margin:0 18px 10px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 24%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 7%,transparent);color:var(--dsw-alias-state-error-primary,#a33);font-size:12px}
.jsk-modal-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l2,#e7e9ee);background:var(--dsw-alias-bg-layer-2,#fbfbfc)}
.jsk-modal-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa2af)}
.jsk-modal-foot .jsk-link{margin-left:auto;font-size:12px}
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
.jsk-refchip{display:inline-flex;align-items:baseline;gap:3px;max-width:240px;padding:0 4px;border-radius:var(--dsw-radius-sm,5px);color:var(--dsw-alias-state-business-primary,#4f6bfe);background:transparent;vertical-align:baseline;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.jsk-refchip-on{cursor:pointer}
@media (hover: hover){.jsk-refchip-on:hover{background:var(--dsw-alias-state-business-tertiary,rgba(79,107,254,.12))}}
.jsk-refchip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f6bfe);outline-offset:1px}
.jsk-refchip-icon{display:inline-flex;align-self:center;flex:none}
.jsk-refchip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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

        // The canvas speaks first: it posts its element list once a file is
        // parsed, and again whenever either writer changes it. Only the frame
        // this plugin mounted is believed — the message carries no origin we
        // could check (the canvas is served from its own loopback port).
        ctx.effect(() => {
          const onMessage = (event) => {
            const data = event.data;
            if (data === null || typeof data !== 'object' || data.type !== 'jsk-canvas') return;
            const frame = canvasFrame;
            if (frame !== null && event.source !== frame.contentWindow) return;
            if (data.event === 'elements') {
              setCanvasIndex(data);
              flushPendingSelect();
            }
          };
          window.addEventListener('message', onMessage);
          return () => window.removeEventListener('message', onMessage);
        }, 'justskill-design: canvas element index');

        // Chips for canvas elements, and the `@` names a paste can be recognised by.
        ctx.inject(['inputTriggers'], (scope) => {
          const inputTriggers = scope.get('inputTriggers');
          if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') return;
          scope.effect(
            () => inputTriggers.registerSource(canvasReferenceSource()),
            'justskill-design: canvas @ source',
          );
        });

        // Sent messages carry the model form, so the history draws the same
        // pointer as the chip again. The text itself stays the sentence.
        ctx.slots.inject('conversation.user.text.node', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.user.text.node',
              key: 'justskill',
              priority: 100,
            }, CanvasUserText);
          } catch (cause) {
            console.warn('[justskill-design] sent-pointer chip unavailable:', cause);
            return () => {};
          }
        });

        ctx.inject(['uiConversation'], (scope) => {
          const conversation = scope.get('uiConversation');
          if (conversation === undefined || conversation === null || conversation.userText === undefined) return;
          scope.effect(
            () => conversation.userText.register(canvasPointerRule),
            'justskill-design: pointer text rule',
          );
        });

        // Keep the current composer's public input face reachable: a paste
        // happens outside every slot, and turning a pointer into a chip needs
        // `captureInsertion()` plus the session-scope insert. Contained, because
        // this entry renders nothing: losing it must not cost the workbench and
        // the canvas tab their registrations.
        ctx.slots.inject('conversation.input.overlay', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.input.overlay',
              id: 'justskill-reference-paste',
              order: 40,
            }, ComposerInputBridge);
          } catch (cause) {
            console.warn('[justskill-design] composer input face unavailable:', cause);
            return () => {};
          }
        });

        ctx.effect(() => {
          window.addEventListener('paste', handleReferencePaste, true);
          return () => window.removeEventListener('paste', handleReferencePaste, true);
        }, 'justskill-design: pointer paste');

        // Keep the current composer's public input face reachable: a paste
        // happens outside every slot, and turning a pointer into a chip needs
        // `captureInsertion()` plus the session-scope insert. Contained, because
        // this entry renders nothing: losing it must not cost the workbench and
        // the canvas tab their registrations.
        ctx.slots.inject('conversation.input.overlay', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.input.overlay',
              id: 'justskill-reference-paste',
              order: 40,
            }, ComposerInputBridge);
          } catch (cause) {
            console.warn('[justskill-design] composer input face unavailable:', cause);
            return () => {};
          }
        });


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
