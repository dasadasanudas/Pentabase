/* Disposable QA harness, deployed only under /qa. Never use real credentials. */
(() => {
  'use strict';
  if (!location.pathname.endsWith('/qa/')) return;
  const prefix = 'pentabase-disposable-qa-v1';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, name, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await wait(150);
    }
    throw new Error('Timed out: ' + name + '. ' + (document.querySelector('#supa-status')?.textContent || ''));
  };
  const set = (id, value) => {
    const field = document.getElementById(id);
    if (!field) throw new Error('Missing control ' + id);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const click = id => {
    const el = document.getElementById(id);
    if (!el || el.hidden || el.disabled) throw new Error('Control unavailable: ' + id);
    el.click();
  };
  function statusText(s) {
    const el = document.getElementById('qa-status');
    if (el) el.textContent = s;
  }
  async function waitStatus(text) {
    return until(() => document.querySelector('#supa-status')?.textContent.includes(text), text);
  }
  async function prepareName() {
    const field = document.querySelector('input[placeholder="Enter your name..."]');
    if (field && field.offsetParent) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, 'Disposable test');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Done' && x.offsetParent);
      if (button) button.click();
      await wait(1500);
    }
    const ok = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Understood' && x.offsetParent);
    if (ok) { ok.click(); await wait(500); }
  }
  async function initialize() {
    const rt = await until(() => window.__OFFLINE_RUNTIME__, 'runtime');
    await rt.booted;
    await until(() => document.getElementById('supa-launch'), 'cloud controls', 60000);
    await prepareName();
    return rt;
  }
  async function runFirst() {
    if (sessionStorage.getItem(prefix)) throw new Error('A test is already in progress.');
    const rt = await initialize();
    const email = 'pentabase-ui-test-' + crypto.randomUUID() + '@example.com';
    const password = crypto.randomUUID() + crypto.randomUUID();
    const answer = 'this is a disposable test answer ' + crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const accountId = rt.localAccountId();
    const stamp = new Date().toISOString();
    const pdf = new TextEncoder().encode('%PDF-1.4 disposable test PDF bytes');
    statusText('Creating a disposable cloud account…');
    click('supa-launch');
    set('supa-email', email);
    set('supa-password', password);
    click('supa-signup');
    await until(() => !document.getElementById('supa-enroll').hidden, 'recovery setup');
    set('recovery-question', 'What is the private disposable test phrase?');
    set('recovery-answer', answer);
    set('recovery-current-password', password);
    click('supa-enroll-submit');
    await until(() => !document.getElementById('supa-save-code').hidden, 'recovery code');
    click('supa-code-saved');
    const dbName = rt.dbName || 'penta.db';
    await rt.dbCall('run', { dbName,
      sql: 'INSERT INTO file(id,name,type,size,category,created_by,created_time,last_edited_time) VALUES (?,?,?,?,?,?,?,?)',
      parameters: [fileId, 'disposable.pdf', 'application/pdf', pdf.length, 'pdf', accountId, stamp, stamp] });
    await rt.dbCall('run', { dbName,
      sql: 'INSERT INTO highlight_element(id,type,source_id,source_location,highlight,note,created_by,created_time,last_edited_time) VALUES (?,?,?,?,?,?,?,?,?)',
      parameters: ['qa-highlight-' + crypto.randomUUID(), 'pdf', fileId, '{"page":1}', '{"text":"PENTABASE LIVE RESTORE QA"}', '{"text":"disposable test"}', accountId, stamp, stamp] });
    await window.pentaElectronApi.addFile({ id: fileId, accountId, data: pdf });
    statusText('Uploading the disposable library to the real cloud…');
    const previousConfirm = window.confirm;
    window.confirm = () => true;
    try {
      click('supa-upload');
      await waitStatus('PDF bytes remain local');
      const target = await (await navigator.storage.getDirectory()).getDirectoryHandle('qa-empty-' + crypto.randomUUID(), { create: true });
      window.showDirectoryPicker = async () => target;
      sessionStorage.setItem(prefix, JSON.stringify({ stage: 'restore', fileId, accountId }));
      statusText('Restoring the real cloud snapshot into a separate test folder…');
      click('supa-restore');
      await until(() => sessionStorage.getItem(prefix) === null || location.pathname.endsWith('/qa/'), 'restore');
      await wait(30000);
      throw new Error('Restore did not reload.');
    } finally { window.confirm = previousConfirm; }
  }
  async function runResume(state) {
    const rt = await initialize();
    const rows = await rt.dbCall('query', { dbName: rt.dbName || 'penta.db', sql: 'select highlight from highlight_element' });
    if (!JSON.stringify(rows).includes('PENTABASE LIVE RESTORE QA')) throw new Error('Restored highlight missing.');
    click('supa-launch');
    await until(() => !document.getElementById('supa-relink').hidden, 'PDF relink control');
    const file = new File([new TextEncoder().encode('%PDF-1.4 disposable test PDF bytes')], 'disposable.pdf', { type: 'application/pdf' });
    const data = new DataTransfer();
    data.items.add(file);
    document.getElementById('supa-pdf-input').files = data.files;
    click('supa-pdf-button');
    await waitStatus('PDF relinked locally');
    const restored = await rt.readFileObj(state.accountId, state.fileId);
    if ((await restored.text()) !== '%PDF-1.4 disposable test PDF bytes') throw new Error('Relinked PDF differs.');
    sessionStorage.removeItem(prefix);
    statusText('PASS: actual account creation, real cloud upload, restore to a separate folder, highlight and local PDF relink.');
  }
  async function boot() {
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', zIndex: '2147483647', right: '8px', top: '8px', width: '330px', padding: '12px', background: '#fff', color: '#111', border: '2px solid #16835a', font: '14px system-ui' });
    box.innerHTML = '<strong>Disposable cloud test</strong><p id="qa-status">Uses a synthetic library and an automatically generated test account. Never use a personal library here.</p><button id="qa-run" type="button">Run cloud restore test</button>';
    document.body.append(box);
    document.getElementById('qa-run').onclick = async () => {
      document.getElementById('qa-run').disabled = true;
      try { await runFirst(); } catch (err) { statusText('FAILED: ' + err.message); }
    };
    const state = sessionStorage.getItem(prefix);
    if (state) {
      document.getElementById('qa-run').disabled = true;
      statusText('Checking the restored library…');
      try { await runResume(JSON.parse(state)); } catch (err) { statusText('FAILED: ' + err.message); }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
