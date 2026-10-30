/* Manual, immutable snapshots. PDFs remain local, and are relinked by hash.
   This is a prototype: never delete or overwrite existing local libraries. */
(() => {
  'use strict';
  const rt = window.__OFFLINE_RUNTIME__;
  if (!rt) return;
  const PUBLIC_KEY = 'sb_publishable_7T4xVlBUmnJzqZCrL1Pbow_OZrkIS91';
  const BUCKET = 'pentabase-sync';
  const META = '.pentabase-supa-sync.json';
  const LIMIT = 32 * 1024 * 1024;
  const enc = new TextEncoder();
  let session = null, busy = false, missingPdfs = [];

  const message = s => { document.getElementById('supa-status').textContent = s; };
  function b64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(text);
  }
  function un64(text) {
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function digest(data) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function gzip(data, unpack = false) {
    const input = new Blob([data]).stream().pipeThrough(unpack ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
    const reader = input.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > LIMIT * 2) { await reader.cancel(); throw Error('Snapshot is too large for this test build.'); }
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }
  async function request(path, options = {}, authenticated = true) {
    const headers = { apikey: PUBLIC_KEY, ...options.headers };
    if (authenticated) {
      if (!session) throw Error('Sign in first.');
      headers.Authorization = `Bearer ${session.access_token}`;
    }
    const response = await rt.syncRequest(path, { ...options, headers });
    if (!response.ok) {
      if (response.status === 401 && authenticated) session = null;
      throw Error(response.status === 401 ? 'Sign-in expired or credentials were rejected. Sign in again.' : `Cloud request failed (${response.status}). Your local library was not overwritten.`);
    }
    return response;
  }
  async function login() {
    const email = document.getElementById('supa-email').value.trim().toLowerCase();
    const passwordField = document.getElementById('supa-password');
    const password = passwordField.value;
    if (!email || !password) throw Error('Enter your email and Pentabase password.');
    passwordField.value = '';
    const res = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }, false);
    const data = await res.json();
    if (data.user?.email?.toLowerCase() !== email || !data.access_token || !data.user.id) throw Error('Could not verify the signed-in account.');
    session = { access_token: data.access_token, user: data.user };
    let state;
    try {
      const status = await request('/functions/v1/pentabase-recovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' })
      });
      state = await status.json();
      if (typeof state.ready !== 'boolean') throw Error('Recovery service is unavailable. Your library was not changed.');
    } catch (err) { session = null; throw err; }
    document.getElementById('supa-login').hidden = true;
    if (!state.ready) {
      document.getElementById('supa-enroll').hidden = false;
      message('Set up recovery before syncing. Email ownership is not verified.');
    } else {
      document.getElementById('supa-actions').hidden = false;
      message('Signed in. The session stays in this tab only.');
    }
  }
  async function signup() {
    const email = document.getElementById('supa-email').value.trim().toLowerCase();
    const field = document.getElementById('supa-password'), password = field.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Enter a valid email address.');
    if (password.length < 12) throw Error('Use a password with at least 12 characters.');
    field.value = '';
    const res = await request('/auth/v1/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }, false);
    const data = await res.json();
    if (!data.access_token || !data.user?.id || data.user.email?.toLowerCase() !== email)
      throw Error('Account creation was not completed. Check your details and try again.');
    session = { access_token: data.access_token, user: data.user };
    document.getElementById('supa-login').hidden = true;
    document.getElementById('supa-enroll').hidden = false;
    message('Account created. Set up recovery before syncing. Email ownership is not verified.');
  }
  async function enrollRecovery() {
    const question = document.getElementById('recovery-question').value.trim();
    const answer = document.getElementById('recovery-answer').value;
    const password = document.getElementById('recovery-current-password').value;
    if (question.length < 5 || question.length > 120) throw Error('Enter a question between 5 and 120 characters.');
    if (answer.length < 20 || enc.encode(answer).length > 72) throw Error('Use a private answer of at least 20 characters and no more than 72 UTF-8 bytes. Avoid facts someone could guess.');
    if (!password) throw Error('Enter your current password to set recovery.');
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const code = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').match(/.{1,8}/g).join('-');
    const res = await request('/functions/v1/pentabase-recovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enroll', question, answer, code, password })
    });
    const data = await res.json();
    if (!data.ok) throw Error('Recovery setup did not complete. Try again.');
    document.getElementById('recovery-answer').value = '';
    document.getElementById('recovery-current-password').value = '';
    document.getElementById('recovery-question').value = '';
    document.getElementById('supa-enroll').hidden = true;
    document.getElementById('supa-code-display').textContent = code;
    document.getElementById('supa-save-code').hidden = false;
    message('Save this code somewhere safe. It is shown only now. Anyone with it can reset your password.');
  }
  async function recoverPassword() {
    const email = document.getElementById('supa-email').value.trim().toLowerCase();
    const method = document.getElementById('reset-method').value;
    const proof = document.getElementById('reset-proof').value;
    const password = document.getElementById('reset-password').value;
    if (!email || !proof || password.length < 12) throw Error('Enter your email, recovery secret and a new password of at least 12 characters.');
    const res = await request('/functions/v1/pentabase-recovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset', email, method, proof, password })
    }, false);
    const data = await res.json();
    if (!data.ok) throw Error('Recovery failed. Check your details or try later.');
    document.getElementById('reset-proof').value = '';
    document.getElementById('reset-password').value = '';
    document.getElementById('supa-reset').hidden = true;
    message('Password reset. Sign in, then save a new recovery code. No email was sent.');
  }
  async function showQuestion() {
    const email = document.getElementById('supa-email').value.trim().toLowerCase();
    if (!email) throw Error('Enter your account email first.');
    const res = await request('/functions/v1/pentabase-recovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'question', email })
    }, false);
    const data = await res.json();
    if (!data.ok || typeof data.question !== 'string') throw Error('Could not load the recovery hint.');
    document.getElementById('reset-question').textContent = data.question;
    message('Enter your exact private answer and a new password.');
  }
  async function signOut() {
    let revoked = false;
    try {
      if (session) {
        await request('/auth/v1/logout?scope=local', { method: 'POST' });
        revoked = true;
      }
    } catch (_) {
      // Clear local credentials even if the cloud request fails.
    } finally {
      session = null;
      document.getElementById('supa-code-display').textContent = '';
      document.getElementById('supa-password').value = '';
      document.getElementById('supa-actions').hidden = true;
      document.getElementById('supa-enroll').hidden = true;
      document.getElementById('supa-save-code').hidden = true;
      document.getElementById('supa-login').hidden = false;
    }
    message(revoked
      ? 'Signed out of this cloud account. Your local library is still open on this device.'
      : 'Local sign-in cleared, but the cloud session could not be revoked. Your local library is still open on this device.');
  }
  const dir = () => `${session.user.id}/snapshots`;
  const objectPath = (name, download = false) => `/storage/v1/object/${download ? 'authenticated/' : ''}pentabase-sync/${session.user.id}/snapshots/${encodeURIComponent(name)}`;
  async function objects() {
    let list = [], offset = 0;
    for (;;) {
      const res = await request(`/storage/v1/object/list/${BUCKET}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: dir(), limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      const part = await res.json();
      if (!Array.isArray(part)) throw Error('Invalid cloud listing.');
      list.push(...part); if (part.length < 100) return list;
      offset += part.length;
      if (offset > 10000) throw Error('Too many snapshots. No changes were made.');
    }
  }
  function graph(files) {
    const records = files.map(f => {
      const m = /^([0-9a-f-]{36})_([0-9a-f-]{36}|root)\.gz$/i.exec(f.name);
      return m ? { name: f.name, id: m[1], parent: m[2] } : null;
    }).filter(Boolean);
    const parents = new Set(records.map(x => x.parent));
    return records.filter(x => !parents.has(x.id));
  }
  async function metadata(root) {
    try { return JSON.parse(await (await (await root.getFileHandle(META)).getFile()).text()); }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
  }
  async function write(root, path, bytes) {
    const parts = path.split('/'), name = parts.pop(); let current = root;
    for (const part of parts) current = await current.getDirectoryHandle(part, { create: true });
    const handle = await current.getFileHandle(name, { create: true }), writer = await handle.createWritable();
    try { await writer.write(bytes); await writer.close(); } catch (e) { await writer.abort().catch(() => {}); throw e; }
  }
  async function saveMeta(root, id, accountId) {
    await write(root, META, enc.encode(JSON.stringify({ id, accountId, userId: session.user.id })));
  }
  async function collect() {
    const dbName = rt.dbName || 'penta.db';
    const account = await rt.dbCall('query', { dbName, sql: 'SELECT account_id FROM miscellany' });
    if (account.length !== 1 || account[0].account_id !== rt.localAccountId()) throw Error('The library is not ready. No snapshot was uploaded.');
    const files = await rt.dbCall('query', { dbName, sql: "SELECT id,name,type,size FROM file" });
    const pdfIds = await rt.dbCall('query', { dbName, sql: 'SELECT file_id FROM pdf_card' });
    const pdfSet = new Set(pdfIds.map(x => x.file_id));
    const fileInfo = new Map(files.map(x => [x.id, x]));
    const entries = [], pdfs = []; let size = 0;
    async function add(path, bytes) {
      size += bytes.byteLength;
      if (size > LIMIT) throw Error('The non-PDF library exceeds the 32 MiB prototype limit.');
      entries.push({ path, size: bytes.length, hash: await digest(bytes), data: b64(bytes) });
    }
    const database = new Uint8Array(await rt.dbCall('exportDb', { dbName }));
    await add('penta.db', database);
    async function walk(folder, prefix) {
      for await (const [name, handle] of folder.entries()) {
        if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw Error('Invalid file path.');
        const path = `${prefix}/${name}`;
        if (handle.kind === 'directory') { await walk(handle, path); continue; }
        const file = await handle.getFile(), info = fileInfo.get(name);
        const magic = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
        if (pdfSet.has(name) || /pdf/i.test(info?.type || '') || /\.pdf$/i.test(info?.name || '') || magic === '%PDF-') {
          // Hash locally for an exact match later; the PDF bytes never leave this device.
          pdfs.push({ path, name: info?.name || file.name, size: file.size, hash: await digest(await file.arrayBuffer()) });
        } else {
          if (file.size + size > LIMIT) throw Error('The non-PDF library exceeds the 32 MiB prototype limit.');
          await add(path, new Uint8Array(await file.arrayBuffer()));
        }
      }
    }
    try { await walk(await rt.store.root.getDirectoryHandle('files'), 'files'); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; }
    const presentIds = new Set(pdfs.map(x => x.path.split('/').pop()));
    const missing = [...pdfSet].filter(id => !presentIds.has(id));
    if (missing.length) throw Error('At least one PDF is missing locally. Relink it before uploading, so its identity can be preserved.');
    return { entries, pdfs };
  }
  async function upload() {
    const tips = graph(await objects()), meta = await metadata(rt.store.root);
    if (tips.length > 1) throw Error('Multiple cloud versions exist. They were preserved; no overwrite was made.');
    if (tips.length && (!meta || meta.id !== tips[0].id || meta.accountId !== rt.localAccountId() || meta.userId !== session.user.id))
      throw Error('This device is not linked to the newest snapshot. Restore it to a separate empty folder first.');
    if (!tips.length && meta) throw Error('The previously linked snapshot is missing. No upload was made.');
    if (!tips.length && !meta && !confirm('This will upload the currently open local library to this cloud account. Check that you are using the right account and library. Continue?')) {
      message('Sync cancelled. Nothing was uploaded.');
      return;
    }
    message('Preparing the database, highlights and attachments. PDFs stay on this device…');
    const { entries, pdfs } = await collect();
    const id = crypto.randomUUID(), parent = tips[0]?.id || 'root', accountId = rt.localAccountId();
    const packed = await gzip(enc.encode(JSON.stringify({ format: 'pentabase-supa-v1', id, parent, accountId, entries, pdfs })));
    if (packed.byteLength > LIMIT) throw Error('Compressed snapshot is larger than 32 MiB.');
    const name = `${id}_${parent}.gz`;
    await request(objectPath(name), { method: 'POST', headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'false' }, body: packed });
    await saveMeta(rt.store.root, id, accountId);
    const after = graph(await objects());
    if (after.length !== 1 || after[0].id !== id) throw Error('Concurrent snapshots were preserved. Resolve them before syncing again.');
    message(`Saved ${entries.length} files and ${pdfs.length} PDF references. PDF bytes remain local.`);
  }
  async function restore() {
    if (!window.showDirectoryPicker) throw Error('Restore requires desktop Chrome or Edge and a new empty folder.');
    const target = await window.showDirectoryPicker({ id: 'pentabase-restore-supa', mode: 'readwrite' });
    for await (const _ of target.entries()) throw Error('Choose a completely empty folder. Existing files were not changed.');
    const tips = graph(await objects());
    if (!tips.length) throw Error('There is no cloud snapshot yet. Sync from the original device first.');
    if (tips.length !== 1) throw Error('Multiple cloud versions exist; none were overwritten.');
    message('Downloading and checking the snapshot…');
    const response = await request(objectPath(tips[0].name, true), { method: 'GET' });
    const blob = await response.arrayBuffer();
    if (blob.byteLength > LIMIT) throw Error('Snapshot is too large for this prototype.');
    const unpacked = await gzip(blob, true);
    let pack; try { pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unpacked)); } catch (_) { throw Error('Invalid snapshot.'); }
    if (pack.format !== 'pentabase-supa-v1' || pack.id !== tips[0].id || !Array.isArray(pack.entries) || !Array.isArray(pack.pdfs) || !/^[0-9a-f-]{36}$/i.test(pack.accountId)) throw Error('Unsupported snapshot.');
    const checked = [], paths = new Set(); let total = 0;
    const validPath = p => typeof p === 'string' && /^(penta\.db|files\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)$/.test(p) && !p.split('/').some(s => s === '.' || s === '..');
    for (const e of pack.entries) {
      if (!validPath(e.path) || paths.has(e.path)) throw Error('Unsafe or duplicate path.');
      paths.add(e.path); const bytes = un64(e.data);
      if ((total += bytes.length) > LIMIT || bytes.length !== e.size || await digest(bytes) !== e.hash) throw Error('Snapshot integrity check failed.');
      checked.push({ path: e.path, bytes });
    }
    for (const pdf of pack.pdfs) {
      if (!validPath(pdf.path) || pdf.path === 'penta.db' || paths.has(pdf.path) || !/^[a-f0-9]{64}$/.test(pdf.hash) || !Number.isSafeInteger(pdf.size) || pdf.size < 0) throw Error('Invalid PDF reference.');
      paths.add(pdf.path);
    }
    const db = checked.find(x => x.path === 'penta.db');
    if (!db || new TextDecoder().decode(db.bytes.slice(0, 15)) !== 'SQLite format 3') throw Error('Snapshot database is invalid.');
    const current = graph(await objects());
    if (current.length !== 1 || current[0].id !== tips[0].id) throw Error('Cloud changed during download. Try again.');
    if (!confirm(`Restore ${checked.length} verified files and ${pack.pdfs.length} PDF references into the empty folder “${target.name}”? Your current library will not be overwritten.`)) { message('Restore cancelled.'); return; }
    for (const entry of checked) await write(target, entry.path, entry.bytes);
    await write(target, '.pentabase-missing-pdfs.json', enc.encode(JSON.stringify(pack.pdfs)));
    await saveMeta(target, tips[0].id, pack.accountId);
    await rt.useFolder(target);
    location.replace(location.pathname);
  }
  async function loadMissing() {
    try { missingPdfs = JSON.parse(await (await (await rt.store.root.getFileHandle('.pentabase-missing-pdfs.json')).getFile()).text()); }
    catch (e) { if (e.name !== 'NotFoundError') throw e; missingPdfs = []; }
    const select = document.getElementById('supa-pdf-list'); select.replaceChildren();
    for (let i = 0; i < missingPdfs.length; i++) { const opt = document.createElement('option'); opt.value = String(i); opt.textContent = missingPdfs[i].name + ' (' + missingPdfs[i].size + ' bytes)'; select.append(opt); }
    document.getElementById('supa-relink').hidden = !missingPdfs.length;
  }
  async function relink() {
    const i = Number(document.getElementById('supa-pdf-list').value), pdf = missingPdfs[i];
    const selected = document.getElementById('supa-pdf-input').files[0];
    if (!pdf || !selected) throw Error('Choose a listed PDF and select its local file.');
    if (selected.size !== pdf.size || await digest(await selected.arrayBuffer()) !== pdf.hash) throw Error('That file does not exactly match the original PDF. Nothing was changed.');
    // Never overwrite a file that might have been added since restore.
    try {
      let d = rt.store.root; const parts = pdf.path.split('/'), name = parts.pop();
      for (const p of parts) d = await d.getDirectoryHandle(p);
      await d.getFileHandle(name);
      throw Error('A file already exists at this PDF location. Nothing was overwritten.');
    } catch (e) { if (e.name !== 'NotFoundError') throw e; }
    await write(rt.store.root, pdf.path, selected);
    missingPdfs.splice(i, 1);
    await write(rt.store.root, '.pentabase-missing-pdfs.json', enc.encode(JSON.stringify(missingPdfs)));
    document.getElementById('supa-pdf-input').value = '';
    await loadMissing(); message('PDF relinked locally. It was not uploaded.');
  }
  async function run(fn) {
    if (busy) return; busy = true;
    const buttons = document.querySelectorAll('#supa-panel button'); buttons.forEach(b => b.disabled = true);
    try { await fn(); } catch (e) { message(e.name === 'AbortError' ? 'Cancelled.' : e.message || String(e)); }
    finally { buttons.forEach(b => b.disabled = false); busy = false; }
  }
  async function mount() {
    const style = document.createElement('style');
    style.textContent = '#supa-launch{position:fixed;right:16px;bottom:15px;z-index:2147483644;border:1px solid #627371;border-radius:8px;background:#18312f;color:#fff;padding:9px 12px;font:600 13px system-ui;cursor:pointer}#supa-panel[hidden]{display:none}#supa-panel{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0009;font:15px/1.5 system-ui;color:#edf5f2}#supa-panel .card{width:min(540px,calc(100vw - 32px));max-height:90vh;overflow:auto;background:#122b29;border:1px solid #516b65;border-radius:14px;padding:24px;box-sizing:border-box}#supa-panel p{color:#c2d4cf}#supa-panel input,#supa-panel select{display:block;width:100%;box-sizing:border-box;padding:10px;background:#10201f;color:#fff;border:1px solid #708781;border-radius:8px;font:inherit}#supa-panel button{border:1px solid #78938d;background:#25554e;color:#fff;border-radius:8px;padding:10px 13px;margin:5px 5px 5px 0;font:600 14px system-ui;cursor:pointer}#supa-panel button:disabled{opacity:.5}#supa-status{white-space:pre-wrap}';
    document.head.append(style);
    const launch = document.createElement('button'); launch.id = 'supa-launch'; launch.textContent = 'Cloud sync';
    const panel = document.createElement('div'); panel.id = 'supa-panel'; panel.hidden = true;
    panel.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-labelledby="supa-title"><h2 id="supa-title">Pentabase cloud sync</h2><p>Manual snapshots of notes, highlights and non-PDF attachments go to private cloud storage. PDFs stay local. Cloud data is not end-to-end encrypted.</p><div id="supa-login"><label for="supa-email">Email (login ID, not verified)</label><input id="supa-email" type="email" autocomplete="email"><label for="supa-password">Pentabase password</label><input id="supa-password" type="password" autocomplete="current-password"><button id="supa-connect" type="button">Sign in</button><button id="supa-signup" type="button">Create account</button><button id="supa-show-reset" type="button">Forgot password?</button><p>No email will be sent. Do not use this prototype for a real library.</p><div id="supa-reset" hidden><label for="reset-method">Recover using</label><select id="reset-method"><option value="code">Recovery code</option><option value="answer">Private answer</option></select><label for="reset-proof">Recovery code or private answer</label><input id="reset-proof" type="password" autocomplete="off"><label for="reset-password">New password</label><input id="reset-password" type="password" autocomplete="new-password"><button id="supa-reset-submit" type="button">Reset password</button></div></div><div id="supa-enroll" hidden><p>Choose a question you can remember and a long private answer. Don’t use facts others can guess. Keep your question yourself; it isn’t shown when resetting.</p><label for="recovery-question">Your question</label><input id="recovery-question" maxlength="120"><label for="recovery-answer">Private answer (20+ characters)</label><input id="recovery-answer" type="password" autocomplete="off" maxlength="200"><button id="supa-enroll-submit" type="button">Set up recovery</button></div><div id="supa-save-code" hidden><p>Save this single-use recovery code somewhere safe. It won’t be shown again:</p><code id="supa-code-display"></code><p>Anyone with this code can reset your password.</p><button id="supa-code-saved" type="button">I saved it</button></div><div id="supa-actions" hidden><p>Restore writes to a new empty folder. Snapshots do not merge changes. Limit: 32 MiB of non-PDF data per snapshot.</p><button id="supa-upload" type="button">Sync now</button><button id="supa-restore" type="button">Restore to empty folder</button><button id="supa-disconnect" type="button">Sign out</button></div><div id="supa-relink" hidden><p>PDFs are local only. Relink each exact original PDF to this library:</p><select id="supa-pdf-list" aria-label="PDF to relink"></select><input id="supa-pdf-input" type="file" accept="application/pdf" aria-label="Choose original PDF"><button id="supa-pdf-button" type="button">Relink PDF</button></div><p id="supa-status" role="status" aria-live="polite"></p><button id="supa-close" type="button">Close</button></div>';
    document.body.append(launch, panel);
    const localWarning = document.createElement('p');
    localWarning.textContent = 'Signing out does not close or switch this device’s local library. Check which library is open before syncing a different cloud account.';
    document.getElementById('supa-login').append(localWarning);
    const manageRecovery = document.createElement('button');
    manageRecovery.id = 'supa-manage-recovery';
    manageRecovery.type = 'button';
    manageRecovery.textContent = 'Replace recovery code or answer';
    document.getElementById('supa-disconnect').before(manageRecovery);
    manageRecovery.onclick = () => {
      document.getElementById('supa-actions').hidden = true;
      document.getElementById('supa-enroll').hidden = false;
      message('Set a new question and answer to replace your existing recovery methods. You will need your current password.');
    };
    const passwordLabel = document.createElement('label');
    passwordLabel.htmlFor = 'recovery-current-password';
    passwordLabel.textContent = 'Current Pentabase password';
    const passwordInput = document.createElement('input');
    passwordInput.id = 'recovery-current-password';
    passwordInput.type = 'password';
    passwordInput.autocomplete = 'current-password';
    const enrollButton = document.getElementById('supa-enroll-submit');
    enrollButton.before(passwordLabel, passwordInput);
    document.getElementById('supa-enroll').querySelector('p').textContent =
      'Write a non-sensitive question or hint. Anyone who knows your login email may see it. Use a long private answer that nobody could guess.';
    const resetForm = document.getElementById('supa-reset');
    const hintButton = document.createElement('button');
    hintButton.id = 'supa-get-question';
    hintButton.type = 'button';
    hintButton.textContent = 'Show my question';
    const hint = document.createElement('p');
    hint.id = 'reset-question';
    resetForm.insertBefore(hintButton, document.getElementById('reset-proof').previousElementSibling);
    hintButton.after(hint);
    hintButton.onclick = () => run(showQuestion);
    launch.onclick = () => { panel.hidden = false; };
    document.getElementById('supa-close').onclick = () => { if (!busy) panel.hidden = true; };
    document.getElementById('supa-connect').onclick = () => run(login);
    document.getElementById('supa-signup').onclick = () => run(signup);
    document.getElementById('supa-show-reset').onclick = () => { document.getElementById('supa-reset').hidden = false; document.getElementById('reset-question').textContent = ''; };
    document.getElementById('supa-reset-submit').onclick = () => run(recoverPassword);
    document.getElementById('supa-enroll-submit').onclick = () => run(enrollRecovery);
    document.getElementById('supa-code-saved').onclick = () => {
      document.getElementById('supa-code-display').textContent = '';
      document.getElementById('supa-save-code').hidden = true;
      document.getElementById('supa-actions').hidden = false;
      message('Recovery is set up. The session stays in this tab only.');
    };
    document.getElementById('supa-upload').onclick = () => run(upload);
    document.getElementById('supa-restore').onclick = () => run(restore);
    document.getElementById('supa-pdf-button').onclick = () => run(relink);
    document.getElementById('supa-disconnect').onclick = () => run(signOut);
    await loadMissing();
  }
  rt.booted.then(() => { if (rt.store.root) mount(); });
})();
