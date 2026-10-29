/* Offline web runtime for the core UI.
 * Stands in for the Electron main process + preload bridge, so the renderer
 * runs in "desktop" mode inside a normal Chrome tab:
 *   - library folder (File System Access API) or browser storage (OPFS)
 *   - SQLite (sqlite-wasm worker) persisted as a real file in that folder
 *   - attachments stored as real files in <folder>/files/<account>/<id>
 *   - no network: every cross-origin request is refused
 */
(function () {
  'use strict';
  const W = window;
  const ORIGINAL_UA = navigator.userAgent;
  // GitHub project Pages live under /repository/, not at the domain root.
  // Keep the virtual attachment URLs inside this app's service-worker scope.
  const APP_BASE = new URL('../', document.currentScript.src);
  function scopedAssetURL(value) {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/__pf/')) return APP_BASE.pathname.replace(/\/$/, '') + value;
    return value;
  }
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (/^(src|href|poster)$/i.test(name)) value = scopedAssetURL(value);
    return originalSetAttribute.call(this, name, value);
  };
  for (const Ctor of [HTMLImageElement, HTMLMediaElement, HTMLSourceElement, HTMLIFrameElement, HTMLAnchorElement]) {
    for (const name of ['src', 'href', 'poster']) {
      const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, name);
      if (!descriptor || !descriptor.set || !descriptor.configurable) continue;
      Object.defineProperty(Ctor.prototype, name, {
        ...descriptor,
        set(value) { descriptor.set.call(this, scopedAssetURL(value)); }
      });
    }
  }
  const APP_ENTRY = './assets/main-Bf8WTPXb.js';
  const CFG_DB = 'offline-runtime';
  const CFG_STORE = 'kv';

  /* ------------------------------------------------------------ utils */
  const log = (...a) => console.log('%c[offline]', 'color:#178f92', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(CFG_DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(CFG_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function cfgGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(CFG_STORE).objectStore(CFG_STORE).get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  }
  async function cfgSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(CFG_STORE, 'readwrite');
      tx.objectStore(CFG_STORE).put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function cfgDel(k) {
    const db = await idb();
    return new Promise((res) => {
      const tx = db.transaction(CFG_STORE, 'readwrite');
      tx.objectStore(CFG_STORE).delete(k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  function toBytes(data) {
    if (data == null) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Uint8Array.from(data.data);
    return data; // Blob / File are fine for createWritable().write
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ------------------------------------------- 1. identify as desktop */
  try {
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      configurable: true,
      get: () => ORIGINAL_UA + ' Electron/33.0.0',
    });
  } catch (e) { console.warn(e); }
  W.__OFFLINE_RUNTIME__ = { originalUserAgent: ORIGINAL_UA };
  W.__OFFLINE_DEBUG__ = /[?&]debug\b/.test(location.search);

  /* ------------------------------------------ local profile (no sign-in) */
  function localStable(key, make) {
    let v = localStorage.getItem(key);
    if (!v) { v = make(); localStorage.setItem(key, v); }
    return v;
  }
  const PROFILE_CREATED = +localStable('offline:profileCreated', () => String(Date.now()));
  W.__OFFLINE_RUNTIME__.localAccountId = () => localStable('offline:accountId', () => crypto.randomUUID());
  W.__OFFLINE_RUNTIME__.authUser = () => ({
    email: 'me@this.computer',
    creationTime: PROFILE_CREATED,
    lastSignInTime: PROFILE_CREATED + 60000,
    accessToken: 'offline',
    refreshToken: 'offline',
    expirationTime: 8.64e15,
  });
  W.__OFFLINE_RUNTIME__.subscription = () => {
    const start = Math.floor(PROFILE_CREATED / 1000);
    return {
      id: 'local-subscription', cancel_at_period_end: false, start_date: start, current_period_end: 4102444800, status: 'active',
      items: { data: [{ subscription: 'local-subscription', price: { id: 'price_1T65pjFRQokYInZjk3m46uHF', unit_amount: 0 } }] },
    };
  };

  // Tutorials point at online videos and an AI onboarding; start with all of them completed.
  W.__OFFLINE_RUNTIME__.finishTutorials = (t) => {
    for (const k of Object.keys(t)) if (/Step$/.test(k) && typeof t[k] === 'number') t[k] = 999;
    t.isRewatchReminderOpenedBefore = true;
    t.isFirstCardCreationSnackbarOpenedBefore = true;
    return t;
  };

  /* ------------------------------------------------ 2. no network */
  const SAME = location.origin;
  function isLocalUrl(u) {
    try {
      const url = new URL(u, location.href);
      return url.origin === SAME || url.protocol === 'blob:' || url.protocol === 'data:';
    } catch (_) { return true; }
  }
  const blocked = new Set();
  function noteBlocked(u) {
    try {
      const host = new URL(u, location.href).host;
      if (!blocked.has(host)) { blocked.add(host); log('blocked network request to', host); }
    } catch (_) {}
  }
  const realFetch = W.fetch.bind(W);
  // The explicit sync UI alone can reach this project's API.
  W.__OFFLINE_RUNTIME__.syncRequest = (path, options) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
      throw new Error('Invalid API path');
    return realFetch('https://rieznphxjocdpynhiokv.supabase.co' + path, { ...options, redirect: 'error', credentials: 'omit' });
  };
  W.fetch = function (input, init) {
    if (typeof input === 'string') input = scopedAssetURL(input);
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!isLocalUrl(u)) { noteBlocked(u); return Promise.reject(new TypeError('Failed to fetch')); }
    return realFetch(input, init);
  };
  const RealXHR = W.XMLHttpRequest;
  const xOpen = RealXHR.prototype.open;
  RealXHR.prototype.open = function (method, url, ...rest) {
    this.__offlineBlocked = !isLocalUrl(url);
    if (this.__offlineBlocked) noteBlocked(url);
    return xOpen.call(this, method, this.__offlineBlocked ? 'data:,' : url, ...rest);
  };
  const xSend = RealXHR.prototype.send;
  RealXHR.prototype.send = function (body) {
    if (this.__offlineBlocked) {
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent('error'));
        if (typeof this.onerror === 'function') this.onerror(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
      return;
    }
    return xSend.call(this, body);
  };
  const RealWS = W.WebSocket;
  W.WebSocket = function (url) {
    noteBlocked(url);
    const fake = new EventTarget();
    fake.readyState = 3; fake.url = url; fake.send = () => {}; fake.close = () => {};
    setTimeout(() => { const ev = new Event('error'); fake.dispatchEvent(ev); fake.onerror && fake.onerror(ev); const c = new CloseEvent('close', { code: 1006 }); fake.dispatchEvent(c); fake.onclose && fake.onclose(c); }, 0);
    return fake;
  };
  Object.assign(W.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  W.WebSocket.prototype = RealWS.prototype;
  if (navigator.sendBeacon) navigator.sendBeacon = (u) => { if (!isLocalUrl(u)) { noteBlocked(u); return false; } return true; };
  // Scripts/images injected from remote hosts (analytics, widgets) are dropped too.
  const realSetAttr = Element.prototype.setAttribute;
  const guardSrc = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { if (typeof v === 'string' && /^https?:/i.test(v) && !isLocalUrl(v)) { noteBlocked(v); return; } d.set.call(this, v); },
    });
  };
  guardSrc(HTMLScriptElement.prototype, 'src');

  /* --------------------------------------------- 3. library storage */
  const store = {
    mode: null,        // 'folder' | 'browser'
    root: null,        // FileSystemDirectoryHandle
    name: '',
  };

  async function dirPath(parts, create) {
    let d = store.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async function fileHandle(accountId, id, create) {
    const d = await dirPath(['files', String(accountId)], create);
    return d.getFileHandle(String(id), { create });
  }
  async function writeFile(accountId, id, data) {
    const fh = await fileHandle(accountId, id, true);
    const w = await fh.createWritable();
    await w.write(toBytes(data));
    await w.close();
  }
  async function readFileObj(accountId, id) {
    const fh = await fileHandle(accountId, id, false);
    return fh.getFile();
  }
  async function exists(accountId, id) {
    try { await fileHandle(accountId, id, false); return true; } catch (_) { return false; }
  }
  W.__OFFLINE_RUNTIME__.store = store;
  W.__OFFLINE_RUNTIME__.readFileObj = readFileObj;
  W.__OFFLINE_RUNTIME__.cfgGet = cfgGet;
  W.__OFFLINE_RUNTIME__.cfgSet = cfgSet;
  W.__OFFLINE_RUNTIME__.useFolder = useFolder;

  /* --------------------------------------------------- 4. database */
  let dbWorker = null, dbSeq = 0;
  const dbPending = new Map();
  function startDbWorker() {
    dbWorker = new Worker('./offline/db-worker.js');
    dbWorker.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === 'log') { (console[m.status] || console.log)('[sqlite-worker]', m.message, m.extra || ''); return; }
      if (m && m.type === 'saved') { W.__OFFLINE_RUNTIME__.lastSaved = m; setSaveState('saved'); return; }
      if (m && m.type === 'saveError') { setSaveState('error', m.error); return; }
      const p = dbPending.get(m.id);
      if (!p) return;
      dbPending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else { const e = new Error(m.error.message); e.code = m.error.code; p.reject(e); }
    };
    dbWorker.onerror = (e) => console.error('[sqlite-worker] crashed', e.message || e);
  }
  function dbCall(name, param) {
    if (W.__OFFLINE_DEBUG__ && (name === 'run' || name === 'execute')) console.log('[db]', name, (param.sql || (param.statements || []).map((x) => x.sql).join(' ; ')).slice(0, 300));
    return new Promise((resolve, reject) => {
      const id = ++dbSeq;
      dbPending.set(id, { resolve, reject });
      dbWorker.postMessage({ id, name, param });
    });
  }
  W.__OFFLINE_RUNTIME__.dbCall = (n, p) => dbCall(n, p);
  const flushDb = () => dbWorker && dbCall('flush').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDb(); });
  W.addEventListener('pagehide', flushDb);

  /* --------------------------------- small save indicator (unobtrusive) */
  let saveDot = null;
  function setSaveState(state, err) {
    if (!saveDot) return;
    saveDot.dataset.state = state;
    saveDot.title = state === 'error' ? 'Could not write to the library folder: ' + err : 'Saved to ' + (store.mode === 'folder' ? 'folder “' + store.name + '”' : 'browser storage');
  }

  /* ------------------------------------- 5. main-process message port */
  let mainPort = null;
  const portHandlers = {};
  function sendToRenderer(msg) { if (mainPort) mainPort.postMessage(msg); }
  W.__OFFLINE_RUNTIME__.sendToRenderer = sendToRenderer;
  W.addEventListener('message', (ev) => {
    if (ev.source !== W || ev.data !== 'main-port-sent' || !ev.ports || !ev.ports[0]) return;
    ev.stopImmediatePropagation();
    mainPort = ev.ports[0];
    mainPort.onmessage = (e) => {
      const m = e.data || {};
      const h = portHandlers[m.type];
      if (h) { try { h(m); } catch (err) { console.warn('[offline] port handler failed', m.type, err); } }
      else if (W.__OFFLINE_DEBUG__) log('main port message (ignored):', m.type, m);
    };
    mainPort.postMessage({ type: 'mainPortReceived' });
  }, true);
  portHandlers.ready = () => {};
  portHandlers.user = () => {};
  portHandlers.idToken = () => {};
  portHandlers.checkForUpdates = () => sendToRenderer({ type: 'updateNotAvailable' });
  portHandlers.getConnectionSecuritySettings = () => {};
  portHandlers.givepentaFileLocation = () => {};
  document.addEventListener('fullscreenchange', () => sendToRenderer({ type: document.fullscreenElement ? 'enterFullScreen' : 'leaveFullScreen' }));

  /* -------------------------------- 6. navigation entries (history) */
  const nav = { entries: [], index: -1 };
  function navInit() {
    const st = history.state || {};
    if (st.__offlineNavIndex == null) {
      history.replaceState({ ...st, __offlineNavIndex: 0 }, '');
      nav.entries = [{ url: location.href, title: document.title }];
      nav.index = 0;
    }
  }
  const rawPush = history.pushState.bind(history), rawReplace = history.replaceState.bind(history);
  history.pushState = function (state, title, url) {
    const i = nav.index + 1;
    rawPush({ ...(state || {}), __offlineNavIndex: i }, title, url);
    nav.entries.length = i;
    nav.entries[i] = { url: location.href, title: document.title };
    nav.index = i;
  };
  history.replaceState = function (state, title, url) {
    const i = Math.max(nav.index, 0);
    rawReplace({ ...(state || {}), __offlineNavIndex: i }, title, url);
    nav.entries[i] = { url: location.href, title: document.title };
    nav.index = i;
  };
  W.addEventListener('popstate', (e) => {
    const i = e.state && e.state.__offlineNavIndex;
    if (typeof i === 'number') { nav.index = i; nav.entries[i] = { url: location.href, title: document.title }; }
  });
  W.addEventListener('hashchange', () => {
    const i = (history.state && history.state.__offlineNavIndex);
    if (typeof i !== 'number') {
      const n = nav.index + 1;
      rawReplace({ ...(history.state || {}), __offlineNavIndex: n }, '');
      nav.entries.length = n; nav.entries[n] = { url: location.href, title: document.title }; nav.index = n;
    }
  });
  navInit();

  /* ------------------------------------------- 7. the preload bridge */
  const noop = () => {};
  const unsub = () => noop;
  let deviceId = localStorage.getItem('offline:deviceId');
  if (!deviceId) { deviceId = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('offline:deviceId', deviceId); }
  const chunkUploads = new Map();

  const api = {
    getDeviceName: async () => 'Chrome',
    getMacAddress: async () => deviceId,
    getAppWindowCount: async () => 1,
    getWebSocketPort: async () => null,
    getIsFullScreen: async () => !!document.fullscreenElement,
    initAutoSync: noop,
    destroyAutoSync: noop,
    closeApp: () => { flushDb(); W.close(); },
    setNativeTheme: (t) => { try { localStorage.setItem('offline:nativeTheme', String(t)); } catch (_) {} },
    setDatadogUser: noop,
    // -------- files
    downloadFile: async ({ id, transmissionId }) => {
      // Cloud downloads are not available offline.
      setTimeout(() => sendToRenderer({ type: 'failTransmission', data: { id, transmissionId } }), 0);
      throw new Error('Offline: cloud file download is unavailable');
    },
    retryDownloadFile: async () => { throw new Error('Offline: cloud file download is unavailable'); },
    addFile: async ({ data, id, accountId }) => { await writeFile(accountId, id, data); },
    addFileChunk: async ({ data, id, accountId, isFirstChunk, isLastChunk }) => {
      const key = accountId + '/' + id;
      if (isFirstChunk || !chunkUploads.has(key)) chunkUploads.set(key, []);
      chunkUploads.get(key).push(toBytes(data));
      if (isLastChunk) {
        const parts = chunkUploads.get(key);
        chunkUploads.delete(key);
        await writeFile(accountId, id, new Blob(parts));
      }
    },
    readFile: async ({ id, accountId }) => {
      try {
        const f = await readFileObj(accountId, id);
        return { data: new Uint8Array(await f.arrayBuffer()), lastModifiedTime: new Date(f.lastModified).toISOString() };
      } catch (e) { return { error: new Error('Failed to read file') }; }
    },
    readFileChunk: async ({ id, accountId, thisChunkSize, start, isLastChunk }) => {
      try {
        const f = await readFileObj(accountId, id);
        const data = new Uint8Array(await f.slice(start, start + thisChunkSize).arrayBuffer());
        return isLastChunk ? { data, lastModifiedTime: new Date(f.lastModified).toISOString() } : { data };
      } catch (e) { return { error: new Error('Failed to read file chunk') }; }
    },
    deleteFile: async ({ id, accountId }) => {
      const d = await dirPath(['files', String(accountId)], false);
      await d.removeEntry(String(id));
    },
    deleteFilesByOwner: async ({ accountId }) => {
      try { const d = await dirPath(['files'], false); await d.removeEntry(String(accountId), { recursive: true }); } catch (_) {}
    },
    listFiles: async ({ fileIds, accountId }) => {
      const out = [];
      for (const fileId of fileIds || []) {
        try { const f = await readFileObj(accountId, fileId); out.push({ fileId, lastModifiedTime: new Date(f.lastModified).toISOString() }); } catch (_) {}
      }
      return out;
    },
    putFile: async ({ data, id, accountId }) => { await writeFile(accountId, id, data); },
    checkDoesFileExist: async ({ id, accountId }) => exists(accountId, id),
    exportFile: async ({ accountId, fileId, filename }) => {
      const f = await readFileObj(accountId, fileId);
      downloadBlob(f, filename);
      return filename;
    },
    saveJsonFile: async (p) => {
      const data = p && (p.data ?? p.json ?? p.content);
      const name = (p && (p.filename || p.fileName || p.name)) || 'export.json';
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      downloadBlob(new Blob([text], { type: 'application/json' }), name);
      return { canceled: false };
    },
    getpentaFileFullPath: async ({ accountId, fileId }) => `${store.name || 'library'}/files/${accountId}/${fileId}`,
    startInitLocalpentaData: noop,
    endInitLocalpentaData: noop,
    startBackup: noop,
    cancelBackup: noop,
    refreshSessionId: noop,
    signIn: noop,
    signOut: noop,
    printToPdf: () => setTimeout(() => W.print(), 50),
    createWindow: () => { W.open(location.href.split('#')[0] + location.hash, '_blank', 'noopener'); },
    featureToggle: { set: noop },
    freezeDiagnostics: { getState: async () => ({ isEnabled: false, canUseDevHelpers: false }), capture: noop, simulateMainStall: noop, simulateRendererStall: async () => {} },
    onUpdateUrl: unsub,
    onZoteroOAuthCallback: unsub,
    setTrafficLightPosition: noop,
    webView: {
      extractBackgroundColor: async () => null,
      extractHtmlContent: async () => null,
      seekToYoutubeTimestamp: async (p) => W.__OFFLINE_RUNTIME__.webviewCall && W.__OFFLINE_RUNTIME__.webviewCall('seekYoutube', p),
      canGoBack: async () => false,
      archiveWebPage: async () => ({ error: 'Archiving web pages is not available in the browser version.' }),
      getLinkInterceptPreloadUrl: async () => '',
    },
    bookmark: { getMetadata: async () => null },
    navigation: {
      getAllEntries: async () => nav.entries.slice(),
      getActiveIndex: async () => nav.index,
      navigateToEntry: async (p) => {
        const target = typeof p === 'number' ? p : (p && (p.index ?? p.entryIndex));
        if (typeof target === 'number' && target !== nav.index) history.go(target - nav.index);
      },
      setCustomProtocolsForExternalOpen: noop,
    },
    db: {
      open: (p) => { W.__OFFLINE_RUNTIME__.dbName = p && p.dbName; return dbCall('open', p); },
      close: (p) => dbCall('close', p),
      query: (p) => dbCall('query', p),
      run: (p) => dbCall('run', p),
      execute: (p) => dbCall('execute', p),
    },
    localFileMvp: {
      getPathForFile: () => null,
      add: async () => { throw new Error('Linking local files is not available in the browser version.'); },
      hydrate: async () => [],
      acquirePreview: async () => null,
      fetchPreview: async () => null,
      releasePreview: async () => {},
      onBindingChange: unsub,
      open: async () => {},
      relink: async () => null,
      clearData: async () => {},
      updateInstances: async () => {},
      duplicateInstances: async () => {},
      deleteInstances: async () => {},
      restoreDeletedInstances: async () => {},
    },
    cli: {
      commitImportFile: async () => {},
      onRequest: unsub,
      sendResponse: noop,
      setEnabled: noop,
      install: async () => false,
      uninstall: async () => false,
      checkInstalled: async () => false,
    },
  };
  W.pentaElectronApi = api;

  /* --------------------------------------- 8. attachment URL server */
  async function startFileServer() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', async (ev) => {
      const m = ev.data;
      if (!m || m.type !== 'offline-file-request') return;
      const port = ev.ports[0];
      try {
        const f = await readFileObj(m.accountId, m.id);
        port.postMessage({ ok: true, file: f });
      } catch (e) {
        port.postMessage({ ok: false, error: String(e && e.message || e) });
      }
    });
    try {
      const reg = await navigator.serviceWorker.register('./offline-sw.js', { scope: './' });
      if (!navigator.serviceWorker.controller) {
        await new Promise((res) => {
          const done = () => res();
          navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
          setTimeout(done, 4000);
        });
      }
      const ctrl = navigator.serviceWorker.controller || (reg.active);
      if (ctrl) ctrl.postMessage({ type: 'offline-root', mode: store.mode, root: store.mode === 'folder' ? store.root : null });
    } catch (e) { console.warn('[offline] file server unavailable', e); }
  }

  /* -------------------------------------------- 9. library picker UI */
  const css = `
  #offline-gate{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 20% 10%,#1d6f70 0%,transparent 60%),#0f2626;color:#eaf4f2;
    font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #offline-gate .card{width:min(520px,92vw);padding:36px 36px 30px;border-radius:18px;background:rgba(10,30,30,.72);
    box-shadow:0 30px 80px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(20px)}
  #offline-gate h1{margin:0 0 6px;font-size:26px;font-weight:650;letter-spacing:-.01em}
  #offline-gate p{margin:0 0 22px;color:#b9d3cf}
  #offline-gate .row{display:flex;gap:10px;flex-wrap:wrap}
  #offline-gate button{font:inherit;font-weight:600;border:0;border-radius:11px;padding:12px 18px;cursor:pointer}
  #offline-gate .primary{background:#4fb6ca;color:#06282b}
  #offline-gate .primary:hover{background:#6cc6d7}
  #offline-gate .ghost{background:transparent;color:#cfe5e1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
  #offline-gate .ghost:hover{background:rgba(255,255,255,.06)}
  #offline-gate .hint{margin-top:18px;font-size:14px;color:#8fb3ae}
  #offline-gate .err{margin-top:14px;font-size:14px;color:#ffb4a6;min-height:1em}
  [class*="z-onboarding-spotlight"]{display:none!important}
  #offline-save-dot{position:fixed;right:10px;bottom:10px;z-index:2147483645;width:8px;height:8px;border-radius:50%;
    background:#178f92;opacity:.0;transition:opacity .4s;pointer-events:auto}
  #offline-save-dot[data-state=saved]{opacity:.55}
  #offline-save-dot[data-state=error]{opacity:1;background:#e5533d;width:12px;height:12px}
  `;
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) { if (k === 'onclick') e.onclick = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (const c of kids) e.append(c);
    return e;
  }

  async function verifyPermission(handle, ask) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (ask && (await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  async function useFolder(handle) {
    store.mode = 'folder'; store.root = handle; store.name = handle.name;
    await cfgSet('mode', 'folder');
    await cfgSet('rootDir', handle);
  }
  async function useBrowserStorage() {
    store.mode = 'browser'; store.root = await navigator.storage.getDirectory(); store.name = 'browser storage';
    try { await navigator.storage.persist(); } catch (_) {}
    await cfgSet('mode', 'browser');
  }

  function showGate({ title, text, primary, secondary, tertiary }) {
    return new Promise((resolve) => {
      const style = el('style'); style.textContent = css; document.head.appendChild(style);
      const err = el('div', { class: 'err' });
      const buttons = el('div', { class: 'row' });
      const gate = el('div', { id: 'offline-gate' },
        el('div', { class: 'card' }, el('h1', {}, title), el('p', {}, text), buttons, err,
          el('div', { class: 'hint' }, 'Data stays on this device. Use one open tab per library, and back up your folder. Browser storage does not sync across devices.')));
      const mk = (spec, cls) => spec && buttons.append(el('button', { class: cls, onclick: async () => {
        err.textContent = '';
        try { if (await spec.run()) { gate.remove(); resolve(); } } catch (e) {
          if (e && e.name === 'AbortError') return;
          err.textContent = (e && e.message) || String(e);
        }
      } }, spec.label));
      mk(primary, 'primary'); mk(secondary, 'ghost'); mk(tertiary, 'ghost');
      (document.body || document.documentElement).appendChild(gate);
    });
  }

  const pickFolder = {
    label: 'Choose library folder',
    run: async () => {
      if (!W.showDirectoryPicker) throw new Error('This browser cannot open folders. Use Chrome or Edge, or keep the library in browser storage.');
      const h = await W.showDirectoryPicker({ id: 'library', mode: 'readwrite', startIn: 'documents' });
      if (!(await verifyPermission(h, true))) throw new Error('Permission to edit that folder was not granted.');
      await useFolder(h);
      return true;
    },
  };
  const pickBrowser = { label: 'Keep it in browser storage', run: async () => { await useBrowserStorage(); return true; } };

  async function resolveStorage() {
    const forced = new URLSearchParams(location.search).get('storage');
    if (forced === 'browser') { await useBrowserStorage(); return; }
    const mode = await cfgGet('mode');
    if (mode === 'browser') { await useBrowserStorage(); return; }
    if (mode === 'folder') {
      const h = await cfgGet('rootDir');
      if (h && (await verifyPermission(h, false))) { await useFolder(h); return; }
      if (h) {
        await showGate({
          title: 'Reopen your library',
          text: `Chrome needs your OK to keep editing the folder “${h.name}”.`,
          primary: { label: `Open “${h.name}”`, run: async () => { if (await verifyPermission(h, true)) { await useFolder(h); return true; } throw new Error('Permission was not granted.'); } },
          secondary: { label: 'Pick a different folder', run: pickFolder.run },
        });
        return;
      }
    }
    await showGate({
      title: 'Where should your library live?',
      text: 'Choose a folder in desktop Chrome or Edge, or use browser-only storage. A folder can be backed up or synced by your own cloud app; browser storage is local to this browser.',
      primary: pickFolder,
      secondary: pickBrowser,
    });
  }

  /* -------------------------------------------- 10. settings hooks */
  W.__OFFLINE_RUNTIME__.changeLibraryFolder = async () => {
    await flushDb();
    await cfgDel('mode');
    await cfgDel('rootDir');
    location.reload();
  };
  W.__OFFLINE_RUNTIME__.downloadDatabaseCopy = async () => {
    const bytes = await dbCall('exportDb', { dbName: W.__OFFLINE_RUNTIME__.dbName || 'pentabase.db' });
    downloadBlob(new Blob([bytes], { type: 'application/x-sqlite3' }), 'library-copy.sqlite');
  };

  /* ------------------- 10b. hide entry points of removed features */
  // AI chat/agent, collaboration chat. Done at the DOM level so new UI paths stay covered.
  const HIDE_EXACT = new Set(['New session', 'Chat', 'AI', 'Ask AI', 'AI Chat', 'Earn rewards', 'Upgrade', 'Invite', 'Share', 'Publish']);
  const HIDE_POPOVER = [/^Start a new AI session/, /AI (session|agent|tutor)/i];
  const AUTO_SKIP = /^Getting started:/;
  function clickableAncestor(n) {
    for (let e = n, i = 0; e && i < 5; e = e.parentElement, i++) {
      if (e.matches && e.matches('button,a,[role=button],[role=menuitem],[role=tab]')) return e;
      if (e.classList && (e.classList.contains('cursor-pointer'))) return e;
    }
    return null;
  }
  function cleanUi(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const s = t.nodeValue.trim();
      if (!s) continue;
      if (HIDE_EXACT.has(s)) hits.push(['exact', t]);
      else if (HIDE_POPOVER.some((r) => r.test(s)) && s.length < 60) hits.push(['pop', t]);
      else if (AUTO_SKIP.test(s)) hits.push(['skip', t]);
      else if (s === 'Get started') hits.push(['checklist', t]);
    }
    for (const [kind, t] of hits) {
      const p = t.parentElement;
      if (!p || p.closest('[data-offline-keep]')) continue;
      if (p.closest('[contenteditable=true],.ProseMirror,textarea')) continue;
      if (kind === 'exact') {
        const c = clickableAncestor(p);
        if (c && c.textContent.trim() === t.nodeValue.trim()) c.style.setProperty('display', 'none', 'important');
      } else if (kind === 'pop') {
        const box = p.closest('[class*="z-onboarding"],[class*="animate-slide-up"],[role=dialog],[role=tooltip]');
        if (box) box.style.setProperty('display', 'none', 'important');
        document.querySelectorAll('.bg-scrim[class*="z-onboarding"]').forEach((sc) => sc.style.setProperty('display', 'none', 'important'));
      } else if (kind === 'checklist') {
        // onboarding checklist: mostly AI / collaboration / online videos
        const btn = p.closest('button');
        if (btn) { btn.style.setProperty('display', 'none', 'important'); continue; }
        for (let e = p.parentElement, i = 0; e && i < 6; e = e.parentElement, i++) {
          if (/completed/.test(e.textContent) && e.getBoundingClientRect().width < 520) { e.style.setProperty('display', 'none', 'important'); break; }
        }
      } else if (kind === 'skip') {
        const box = p.parentElement && p.parentElement.parentElement;
        const skip = box && [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip');
        if (skip && !skip.__offlineClicked) { skip.__offlineClicked = true; setTimeout(() => skip.click(), 50); }
      }
    }
  }
  let cleanQueued = false;
  function queueClean() {
    if (cleanQueued) return; cleanQueued = true;
    requestAnimationFrame(() => { cleanQueued = false; try { cleanUi(document.body); } catch (e) { /* never break the app */ } });
  }
  W.__OFFLINE_RUNTIME__.startUiCleanup = () => {
    new MutationObserver(queueClean).observe(document.body, { childList: true, subtree: true, characterData: true });
    queueClean();
  };

  // A folder is the library: recover its account ID from its own SQLite
  // before the app starts, rather than silently inventing one per browser.
  function switchLocalIdentity(id) {
    try {
      const account = JSON.parse(localStorage.getItem('offline:account') || 'null');
      if (account && account.id !== id) localStorage.removeItem('offline:account');
    } catch (_) { localStorage.removeItem('offline:account'); }
    localStorage.setItem('offline:accountId', id);
  }
  async function restoreLibraryIdentity() {
    let file;
    try {
      file = await store.root.getFileHandle('penta.db');
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
      switchLocalIdentity(crypto.randomUUID());
      return;
    }
    if (!(await file.getFile()).size) throw new Error('The library database is empty. Restore a backup instead of opening it.');
    let rows;
    try {
      rows = await dbCall('query', { dbName: 'penta.db', sql: 'SELECT account_id FROM miscellany' });
    } finally {
      await dbCall('close', { dbName: 'penta.db' });
    }
    if (rows.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rows[0].account_id)) {
      throw new Error('This library does not have one valid local account. No changes were made; restore a backup or inspect the database.');
    }
    switchLocalIdentity(rows[0].account_id);
  }

  // The SQLite worker writes a complete snapshot, so concurrent tabs can
  // overwrite one another. The lock only protects tabs of this origin.
  async function lockLibrary() {
    if (!navigator.locks) return;
    await new Promise((resolve, reject) => {
      navigator.locks.request('pentabase-library-writer', { ifAvailable: true }, (lock) => {
        if (!lock) { reject(new Error('Pentabase is already open in another tab. Close it before opening this library.')); return; }
        resolve();
        return new Promise(() => {});
      }).catch(reject);
    });
  }

  /* ------------------------------------------------------- 11. boot */
  async function boot() {
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    await lockLibrary();
    await resolveStorage();
    // DOM ids for the save dot
    const style = document.getElementById('offline-runtime-style') || el('style', { id: 'offline-runtime-style' });
    style.textContent = css; document.head.appendChild(style);
    saveDot = el('div', { id: 'offline-save-dot' }); document.body.appendChild(saveDot);
    W.__OFFLINE_RUNTIME__.startUiCleanup();
    startDbWorker();
    await dbCall('setRoot', { dir: store.root });
    await restoreLibraryIdentity();
    await startFileServer();
    log('library:', store.mode, store.name);
    await import(new URL(APP_ENTRY, document.baseURI).href);
  }
  W.__OFFLINE_RUNTIME__.booted = boot().catch((e) => {
    console.error('[offline] boot failed', e);
    document.body && (document.body.innerHTML = '<pre style="padding:24px;font:14px/1.5 monospace;white-space:pre-wrap">The app could not start.\n\n' + String(e && (e.stack || e.message) || e) + '</pre>');
  });
})();
