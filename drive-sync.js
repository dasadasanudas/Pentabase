/* Google Drive manual snapshots. Every upload is immutable: concurrent
   writers create separate branches rather than overwriting each other. */
(() => {
  'use strict';
  const rt = window.__OFFLINE_RUNTIME__;
  if (!rt) return;
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const META = '.pentabase-drive-sync.json';
  const LIMIT = 64 * 1024 * 1024;
  let accessToken = null, userId = null, busy = false, googleReady = false;
  const enc = new TextEncoder();
  function text(s) { document.getElementById('drive-status').textContent = s; }
  function to64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  }
  function from64(s) {
    const x = atob(s), a = new Uint8Array(x.length);
    for (let i = 0; i < x.length; i++) a[i] = x.charCodeAt(i);
    return a;
  }
  async function sha(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function compress(bytes, mode) {
    const stream = new Blob([bytes]).stream().pipeThrough(mode === 'pack' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
    const reader = stream.getReader(), chunks = []; let size = 0;
    const max = mode === 'pack' ? LIMIT * 2 : LIMIT * 2;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw Error('Snapshot is too large for this browser build.'); }
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }
  async function api(path, options = {}) {
    if (!accessToken) throw Error('Connect Google Drive first.');
    const headers = { Authorization: `Bearer ${accessToken}`, ...options.headers };
    const response = await rt.driveRequest(path, { ...options, headers });
    if (!response.ok) {
      if (response.status === 401) { accessToken = null; throw Error('Google authorization expired. Connect again.'); }
      throw Error(`Google Drive request failed (${response.status}). Your local library is unchanged.`);
    }
    return response;
  }
  async function list() {
    const files = []; let token;
    do {
      const query = new URLSearchParams({
        q: "trashed = false and appProperties has { key='pentabaseSync' and value='v1' }",
        fields: 'nextPageToken,files(id,name,createdTime,size,appProperties)', pageSize: '1000',
      });
      if (token) query.set('pageToken', token);
      const result = await (await api('/drive/v3/files?' + query)).json();
      files.push(...result.files); token = result.nextPageToken;
    } while (token);
    return files;
  }
  function heads(files) {
    const parents = new Set(files.map(f => f.appProperties?.parent || '').filter(Boolean));
    return files.filter(f => !parents.has(f.id));
  }
  async function getMeta(root) {
    try { return JSON.parse(await (await (await root.getFileHandle(META)).getFile()).text()); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }
  async function write(root, path, data) {
    const parts = path.split('/'), name = parts.pop(); let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(name, { create: true }), writer = await handle.createWritable();
    try { await writer.write(data); await writer.close(); }
    catch (e) { await writer.abort().catch(() => {}); throw e; }
  }
  async function saveMeta(root, snapshotId, accountId) {
    await write(root, META, enc.encode(JSON.stringify({ snapshotId, accountId, driveUser: userId })));
  }
  async function collect(root, dbBytes) {
    let total = 0; const records = [];
    async function add(path, file) {
      total += file.size;
      if (total > LIMIT) throw Error('This test build supports libraries up to 64 MiB. Local data was not changed.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      records.push({ path, size: bytes.length, sha256: await sha(bytes), data: to64(bytes) });
    }
    await add('penta.db', new Blob([dbBytes]));
    async function walk(dir, prefix) {
      for await (const [name, item] of dir.entries()) {
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw Error('Invalid filename.');
        if (item.kind === 'directory') await walk(item, `${prefix}/${name}`);
        else if (item.kind === 'file') await add(`${prefix}/${name}`, await item.getFile());
      }
    }
    try { await walk(await root.getDirectoryHandle('files'), 'files'); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    return records;
  }
  async function connect() {
    const clientId = document.getElementById('drive-client').value.trim();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(clientId)) throw Error('Enter the Google OAuth web client ID.');
    if (!googleReady || !window.google?.accounts?.oauth2) throw Error('Google sign-in did not load. Check the network and try again.');
    const credential = await new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE,
        callback: response => response.error ? reject(Error('Google authorization was not completed.')) : resolve(response.access_token),
        error_callback: () => reject(Error('Google sign-in was cancelled or blocked.')),
      });
      client.requestAccessToken();
    });
    accessToken = credential;
    await rt.cfgSet('driveClientId', clientId);
    try {
      const about = await (await api('/drive/v3/about?fields=user(permissionId)')).json();
      if (!about.user?.permissionId) throw Error('Google did not identify the Drive account.');
      userId = about.user.permissionId;
      document.getElementById('drive-connect').hidden = true;
      document.getElementById('drive-actions').hidden = false;
      text('Connected. The access token is held in this tab only.');
    } catch (e) { accessToken = null; userId = null; throw e; }
  }
  async function upload() {
    const root = rt.store.root, all = await list(), tip = heads(all), meta = await getMeta(root);
    if (tip.length > 1) throw Error('Multiple cloud versions exist. Nothing was overwritten; resolve the copies before syncing.');
    if (tip.length && (!meta || meta.driveUser !== userId || meta.snapshotId !== tip[0].id || meta.accountId !== rt.localAccountId()))
      throw Error('This device is not linked to the latest cloud snapshot. Restore to a separate empty folder first.');
    if (!tip.length && meta) throw Error('The linked cloud snapshot is missing. No upload was made.');
    let accounts;
    try { accounts = await rt.dbCall('query', { dbName: rt.dbName || 'penta.db', sql: 'SELECT account_id FROM miscellany' }); }
    catch (_) { throw Error('The library is still initializing. Try again shortly.'); }
    if (accounts.length !== 1 || accounts[0].account_id !== rt.localAccountId()) throw Error('Library identity is not ready. No upload was made.');
    text('Building an immutable snapshot of the library…');
    const data = await rt.dbCall('exportDb', { dbName: rt.dbName || 'penta.db' });
    const records = await collect(root, data);
    const accountId = rt.localAccountId();
    const zipped = await compress(enc.encode(JSON.stringify({ format: 'pentabase-drive-snapshot-v1', accountId, records })), 'pack');
    const boundary = 'penta-' + crypto.randomUUID();
    const metadata = { name: `Pentabase snapshot ${new Date().toISOString()}.gz`, mimeType: 'application/gzip',
      appProperties: { pentabaseSync: 'v1', parent: tip[0]?.id || '', account: accountId } };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`, zipped, `\r\n--${boundary}--`
    ]);
    text('Uploading a new snapshot. Your earlier versions will remain in Drive…');
    const created = await (await api('/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    })).json();
    if (!created.id) throw Error('Google did not return a snapshot ID. Check Drive before retrying.');
    await saveMeta(root, created.id, accountId);
    const after = heads(await list());
    if (after.length !== 1 || after[0].id !== created.id) throw Error('Concurrent snapshots detected. Both were preserved; resolve them before syncing again.');
    text(`Snapshot saved to Google Drive (${records.length} files). Close this app and allow sync to finish before using another device.`);
  }
  async function restore() {
    if (!window.showDirectoryPicker) throw Error('Restore needs desktop Chrome or Edge and a new empty folder.');
    const target = await window.showDirectoryPicker({ id: 'pentabase-drive-restore', mode: 'readwrite' });
    for await (const _ of target.entries()) throw Error('Choose a completely empty folder. No files were changed.');
    const tip = heads(await list());
    if (!tip.length) throw Error('No snapshot found. First sync from the original device.');
    if (tip.length !== 1) throw Error('There are multiple cloud versions. Neither will be overwritten; resolve the versions first.');
    text('Downloading and validating the snapshot…');
    const response = await api(`/drive/v3/files/${encodeURIComponent(tip[0].id)}?alt=media`);
    const zipped = new Uint8Array(await response.arrayBuffer());
    if (zipped.length > LIMIT * 2) throw Error('Snapshot too large for this build.');
    const bytes = await compress(zipped, 'unpack');
    let pack; try { pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { throw Error('Invalid snapshot.'); }
    if (pack.format !== 'pentabase-drive-snapshot-v1' || !Array.isArray(pack.records) || !/^[0-9a-f-]{36}$/i.test(pack.accountId)) throw Error('Unsupported snapshot.');
    const checked = [], paths = new Set(); let total = 0;
    for (const record of pack.records) {
      const path = record.path;
      if (typeof path !== 'string' || !/^(penta\.db|files\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)$/.test(path) || path.split('/').some(s => s === '.' || s === '..') || paths.has(path)) throw Error('Unsafe or duplicate path.');
      paths.add(path);
      const content = from64(record.data);
      if ((total += content.length) > LIMIT || content.length !== record.size || await sha(content) !== record.sha256) throw Error('Snapshot integrity check failed.');
      checked.push({ path, content });
    }
    const db = checked.find(x => x.path === 'penta.db');
    if (!db || new TextDecoder().decode(db.content.slice(0, 15)) !== 'SQLite format 3') throw Error('Snapshot has no valid database.');
    const current = heads(await list());
    if (current.length !== 1 || current[0].id !== tip[0].id) throw Error('Cloud changed during download. Try again.');
    if (!confirm(`Restore ${checked.length} files into the empty folder “${target.name}”? Your current library will not be overwritten.`)) { text('Restore cancelled.'); return; }
    for (const f of checked) await write(target, f.path, f.content);
    await saveMeta(target, tip[0].id, pack.accountId);
    await rt.useFolder(target);
    text('Restored. Reopening Pentabase…'); location.replace(location.pathname);
  }
  async function run(fn) {
    if (busy) return; busy = true;
    const buttons = document.querySelectorAll('#drive-panel button'); buttons.forEach(b => b.disabled = true);
    try { await fn(); } catch (e) { text(e.name === 'AbortError' ? 'Cancelled.' : e.message || String(e)); }
    finally { buttons.forEach(b => b.disabled = false); busy = false; }
  }
  async function mount() {
    const style = document.createElement('style');
    style.textContent = '#drive-launch{position:fixed;right:16px;bottom:15px;z-index:2147483644;border:1px solid #627371;border-radius:8px;background:#18312f;color:#fff;padding:9px 12px;font:600 13px system-ui;cursor:pointer}#drive-panel[hidden]{display:none}#drive-panel{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0009;font:15px/1.5 system-ui;color:#edf5f2}#drive-panel .card{width:min(520px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:#122b29;border:1px solid #516b65;border-radius:14px;padding:24px;box-sizing:border-box}#drive-panel h2{font-size:21px;margin:0 0 8px}#drive-panel p{color:#c2d4cf;margin:8px 0 14px}#drive-panel input{display:block;width:100%;box-sizing:border-box;padding:11px;border:1px solid #708781;border-radius:8px;color:#fff;background:#10201f;font:inherit}#drive-panel button{border:1px solid #78938d;background:#25554e;color:#fff;border-radius:8px;padding:10px 13px;margin:5px 5px 5px 0;font:600 14px system-ui;cursor:pointer}#drive-panel button:disabled{opacity:.5}#drive-status{min-height:1.5em;white-space:pre-wrap;color:#d7e9e3}';
    document.head.append(style);
    const launch = document.createElement('button'); launch.id = 'drive-launch'; launch.textContent = 'Drive sync';
    const panel = document.createElement('div'); panel.id = 'drive-panel'; panel.hidden = true;
    panel.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-labelledby="drive-title"><h2 id="drive-title">Google Drive sync</h2><p>Save separate snapshots to your own Drive. They are private unless you share them, but Google can access them. This is not end-to-end encrypted.</p><div id="drive-connect"><p>Enter your Google OAuth web client ID, then connect with Google. The client ID is not a password. The app only requests access to files it creates.</p><input id="drive-client" autocomplete="off" aria-label="Google OAuth client ID" placeholder="Google OAuth client ID"><button id="drive-connect-button" type="button">Connect Google Drive</button></div><div id="drive-actions" hidden><p>Sync saves a new snapshot. Restore needs desktop Chrome or Edge and writes to a new empty folder. Concurrent versions are preserved, not merged. Test-build limit: 64 MiB.</p><button id="drive-upload" type="button">Sync to Drive</button><button id="drive-restore" type="button">Restore to empty folder</button><button id="drive-disconnect" type="button">Disconnect</button></div><p id="drive-status" role="status" aria-live="polite"></p><button id="drive-close" type="button">Close</button></div>';
    document.body.append(launch, panel);
    document.getElementById('drive-client').value = await rt.cfgGet('driveClientId') || '';
    launch.onclick = () => { panel.hidden = false; };
    document.getElementById('drive-close').onclick = () => { if (!busy) panel.hidden = true; };
    document.getElementById('drive-connect-button').onclick = () => run(connect);
    document.getElementById('drive-upload').onclick = () => run(upload);
    document.getElementById('drive-restore').onclick = () => run(restore);
    document.getElementById('drive-disconnect').onclick = () => { accessToken = null; userId = null; document.getElementById('drive-connect').hidden = false; document.getElementById('drive-actions').hidden = true; text('Disconnected in this tab.'); };
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = () => { googleReady = true; }; script.onerror = () => text('Google sign-in could not load.');
    document.head.append(script);
  }
  rt.booted.then(() => { if (rt.store.root) mount(); });
})();
