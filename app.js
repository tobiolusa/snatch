/* Snatch — TikTok downloader PWA */
'use strict';

const API = 'https://www.tikwm.com/api/';
const TIMEOUT_MS = 15000;
const BATCH_DELAY_MS = 1200;
const HISTORY_CAP = 60;

const TT_URL_RE = /https?:\/\/(?:www\.|vm\.|vt\.|m\.)?(?:tiktok\.com|douyin\.com)\/[^\s"'<>]+/i;

/* ---------------- storage ---------------- */
const KEYS = {
  count: 'snatch.count',
  history: 'snatch.history',
  daily: 'snatch.daily',
  settings: 'snatch.settings',
  dismissed: 'snatch.clipDismissed',
};

const DEFAULT_SETTINGS = {
  theme: 'dark',
  autoSave: false,
  defaultFormat: 'video',
  warnDup: true,
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

let settings = { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) };
let history = load(KEYS.history, []);
let daily = load(KEYS.daily, {});
let count = load(KEYS.count, 0);

function persistSettings() { save(KEYS.settings, settings); }

/* ---------------- helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function todayKey(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

function weekStart(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u.trim());
    return (url.host + url.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return u.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function extractLinks(text) {
  const out = [];
  const seen = new Set();
  for (const line of text.split(/[\n\r]+/)) {
    const m = line.match(TT_URL_RE);
    if (!m) continue;
    const url = m[0];
    const norm = normalizeUrl(url);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(url);
  }
  return out;
}

function sanitizeName(s) {
  return (s || 'tiktok')
    .replace(/[^\w .-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'tiktok';
}

function fmtTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------------- API ---------------- */
async function fetchInfo(link) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const u = `${API}?url=${encodeURIComponent(link)}&hd=1`;
    const res = await fetch(u, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      throw new Error(json.msg || 'Could not read that link');
    }
    return json.data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out. Check your connection and retry.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function pickSource(data, { format, quality, watermark }) {
  if (format === 'audio') {
    return { url: data.music || data.play, ext: 'mp3', kind: 'audio' };
  }
  if (watermark && data.wmplay) return { url: data.wmplay, ext: 'mp4', kind: 'video' };
  if (quality === 'hd' && data.hdplay) return { url: data.hdplay, ext: 'mp4', kind: 'video' };
  return { url: data.play || data.wmplay, ext: 'mp4', kind: 'video' };
}

/* ---------------- saving ---------------- */
async function downloadBlob(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 3);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

function mimeFor(filename) {
  return filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
}

async function saveFile(url, filename, { allowPicker = false, allowShare = false, title = '' } = {}) {
  let blob;
  try {
    blob = await downloadBlob(url);
  } catch {
    // CORS or network — hand off to the browser directly
    window.open(url, '_blank', 'noopener');
    toast('Opened in a new tab — long-press to save');
    return 'opened';
  }

  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : mimeFor(filename);

  // Phones: the native share sheet is the only route into Photos / Gallery
  if (allowShare && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: title || 'Snatch' });
        return 'shared';
      }
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // gesture expired or unsupported — fall through to a normal download
    }
  }

  if (allowPicker && settings.autoSave && 'showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: filename.endsWith('.mp3') ? 'Audio' : 'Video',
          accept: { [mimeFor(filename)]: ['.' + filename.split('.').pop()] },
        }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // fall through to anchor download
    }
  }

  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
  return 'downloaded';
}

/* ---------------- stats / history ---------------- */
function recordDownload(entry) {
  const norm = normalizeUrl(entry.url);
  const existing = history.find((h) => normalizeUrl(h.url) === norm);
  const isDup = !!existing;

  if (isDup) {
    existing.ts = Date.now();
    history = [existing, ...history.filter((h) => h !== existing)];
  } else {
    history.unshift({ ...entry, ts: Date.now() });
    history = history.slice(0, HISTORY_CAP);
    count += 1;
    const dk = todayKey();
    daily[dk] = (daily[dk] || 0) + 1;
    save(KEYS.count, count);
    save(KEYS.daily, daily);
  }
  save(KEYS.history, history);
  renderHistory();
  renderCounter();
  renderStats();
  return isDup;
}

function findDuplicate(url) {
  const norm = normalizeUrl(url);
  return history.find((h) => normalizeUrl(h.url) === norm);
}

/* ---------------- rendering ---------------- */
function renderCounter() {
  $('#lifetimeCounter').textContent = count;
}

function renderHistory() {
  const list = $('#historyList');
  const empty = $('#historyEmpty');
  list.innerHTML = '';
  if (!history.length) { empty.hidden = false; return; }
  empty.hidden = true;
  for (const h of history) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'h-url';
    span.textContent = h.title ? h.title : h.url;
    span.title = h.url;
    const meta = document.createElement('span');
    meta.className = 'h-meta';
    meta.textContent = `${h.format === 'audio' ? '♪' : (h.quality === 'hd' ? 'HD' : 'SD')} · ${fmtTime(h.ts)}`;
    const redo = document.createElement('button');
    redo.className = 'h-redo';
    redo.textContent = 'Again';
    redo.addEventListener('click', () => {
      $('#linkInput').value = h.url;
      autoGrow();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      handleFetch();
    });
    li.append(span, meta, redo);
    list.appendChild(li);
  }
}

function renderStats() {
  const dk = todayKey();
  const ws = weekStart();
  const prevWs = new Date(ws); prevWs.setDate(prevWs.getDate() - 7);

  let today = 0, thisWeek = 0, prevWeek = 0, total = 0;
  for (const [k, v] of Object.entries(daily)) {
    total += v;
    if (k === dk) today += v;
    const d = new Date(k + 'T00:00:00');
    if (d >= ws) thisWeek += v;
    else if (d >= prevWs) prevWeek += v;
  }
  $('#statToday').textContent = today;
  $('#statWeek').textContent = thisWeek;
  $('#statPrevWeek').textContent = prevWeek;
  $('#statTotal').textContent = Math.max(total, count);

  // 14-day chart
  const chart = $('#dayChart');
  chart.innerHTML = '';
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(todayKey(d));
  }
  const max = Math.max(1, ...days.map((k) => daily[k] || 0));
  for (const k of days) {
    const val = daily[k] || 0;
    const wrap = document.createElement('div');
    wrap.className = 'day-bar';
    const bar = document.createElement('div');
    bar.className = 'bar' + (val ? '' : ' empty');
    bar.style.height = `${(val / max) * 100}%`;
    bar.title = `${k}: ${val}`;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = new Date(k + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'narrow' });
    wrap.append(bar, tick);
    chart.appendChild(wrap);
  }

  // breakdown
  const bd = $('#dayBreakdown');
  bd.innerHTML = '';
  const sorted = Object.entries(daily).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30);
  if (!sorted.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No downloads recorded yet.';
    bd.appendChild(li);
  }
  for (const [k, v] of sorted) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'h-url';
    a.textContent = new Date(k + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const b = document.createElement('span');
    b.className = 'h-meta';
    b.textContent = `${v} video${v === 1 ? '' : 's'}`;
    li.append(a, b);
    bd.appendChild(li);
  }
}

/* ---------------- options state ---------------- */
const opts = { format: settings.defaultFormat, quality: 'sd', watermark: false, batch: false };

function wireSegment(container, onChange) {
  const el = $(container);
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn || btn.disabled) return;
    el.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === btn));
    onChange(btn.dataset.val);
  });
}

function setSegment(container, val) {
  $$(`${container} .seg`).forEach((s) => s.classList.toggle('active', s.dataset.val === val));
}

/* ---------------- single fetch flow ---------------- */
let lastData = null;
let lastLink = null;

function showStatus(kind, html) {
  const el = $('#status');
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}
function hideStatus() { $('#status').hidden = true; }

async function handleFetch(force = false) {
  const raw = $('#linkInput').value;
  const links = extractLinks(raw);

  if (!links.length) {
    showStatus('error', 'No TikTok link found. Paste a full video URL.');
    return;
  }

  if (opts.batch || links.length > 1) {
    hideResult();
    return runQueue(links);
  }

  const link = links[0];
  lastLink = link;

  if (!force && settings.warnDup) {
    const dup = findDuplicate(link);
    if (dup) {
      showStatus('error',
        `You snatched this ${fmtTime(dup.ts)}. ` +
        `<div class="row gap"><button class="btn btn-sm btn-accent" id="dupProceed">Snatch anyway</button>` +
        `<button class="btn btn-sm btn-ghost" id="dupCancel">Cancel</button></div>`);
      $('#dupProceed').onclick = () => handleFetch(true);
      $('#dupCancel').onclick = hideStatus;
      return;
    }
  }

  $('#fetchBtn').disabled = true;
  showStatus('loading', '<span class="spinner"></span>Snatching…');
  try {
    const data = await fetchInfo(link);
    lastData = data;
    hideStatus();
    showResult(data, link);
  } catch (err) {
    showStatus('error',
      `${err.message} ` +
      `<div class="row"><button class="btn btn-sm btn-accent" id="retryFetch">Retry</button></div>`);
    $('#retryFetch').onclick = () => handleFetch(true);
  } finally {
    $('#fetchBtn').disabled = false;
  }
}

function updateQualityAvailability(data) {
  const hdBtn = $('#qualitySeg .seg[data-val="hd"]');
  const hasHd = !!(data && data.hdplay);
  hdBtn.disabled = !hasHd;
  if (!hasHd && opts.quality === 'hd') {
    opts.quality = 'sd';
    setSegment('#qualitySeg', 'sd');
  }
}

function showResult(data, link) {
  updateQualityAvailability(data);
  const card = $('#resultCard');
  card.hidden = false;
  const video = $('#resultVideo');
  const audio = $('#resultAudio');
  const src = pickSource(data, opts);

  if (src.kind === 'audio') {
    video.hidden = true; video.removeAttribute('src'); video.load();
    audio.hidden = false;
    audio.src = src.url;
  } else {
    audio.hidden = true; audio.removeAttribute('src');
    video.hidden = false;
    video.poster = data.cover || data.origin_cover || '';
    video.src = src.url;
  }

  $('#resultTitle').textContent = data.title || '(no caption)';
  const author = data.author ? (data.author.nickname || data.author.unique_id || '') : '';
  $('#resultAuthor').textContent = author ? `@${data.author.unique_id || ''} · ${author}` : '';

  $('#retryBtn').hidden = true;
  $('#saveBtn').disabled = false;
  $('#saveBtn').textContent = 'Save';

  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.mp4', { type: 'video/mp4' })] }));
  const shareBtn = $('#shareBtn');
  shareBtn.hidden = !canShareFiles;

  const runSave = async (btn, shareMode) => {
    const s = pickSource(data, opts);
    if (!s.url) { toast('That format is not available for this video'); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = shareMode ? 'Preparing…' : 'Saving…';
    try {
      const name = `${sanitizeName(author || 'tiktok')}-${data.id || Date.now()}.${s.ext}`;
      const outcome = await saveFile(s.url, name, {
        allowPicker: !shareMode,
        allowShare: shareMode,
        title: data.title || 'TikTok video',
      });
      if (outcome === 'cancelled') { btn.textContent = label; btn.disabled = false; return; }
      const wasDup = recordDownload({
        url: link, id: data.id, title: data.title, author,
        format: opts.format, quality: opts.quality,
      });
      btn.textContent = outcome === 'shared' ? 'Sent ✓' : 'Saved ✓';
      setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
      toast(wasDup ? 'Re-downloaded (not counted again)'
        : outcome === 'shared' ? 'Choose "Save Video" to add it to your gallery'
        : 'Snatched!');
    } catch (err) {
      btn.textContent = label;
      btn.disabled = false;
      $('#retryBtn').hidden = false;
      $('#retryBtn').onclick = () => btn.click();
      toast(err.message || 'Save failed');
    }
  };

  $('#saveBtn').onclick = () => runSave($('#saveBtn'), false);
  shareBtn.onclick = () => runSave(shareBtn, true);
  $('#openBtn').onclick = () => window.open(pickSource(data, opts).url, '_blank', 'noopener');
}

function hideResult() {
  $('#resultCard').hidden = true;
  const v = $('#resultVideo');
  v.pause?.(); v.removeAttribute('src'); v.load?.();
}

/* re-render current result when options change */
function refreshResult() {
  if (lastData && !$('#resultCard').hidden) showResult(lastData, lastLink);
}

/* ---------------- batch queue ---------------- */
let queue = [];
let queueRunning = false;

function renderQueue() {
  const panel = $('#queuePanel');
  const list = $('#queueList');
  if (!queue.length) { panel.hidden = true; return; }
  panel.hidden = false;
  list.innerHTML = '';
  for (const item of queue) {
    const li = document.createElement('li');
    const url = document.createElement('span');
    url.className = 'q-url';
    url.textContent = item.title || item.url;
    url.title = item.url;
    const state = document.createElement('span');
    state.className = `q-state ${item.state}`;
    state.textContent = item.state;
    li.append(url, state);
    if (item.state === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'h-redo';
      retry.textContent = 'Retry';
      retry.onclick = () => { item.state = 'pending'; renderQueue(); runQueue(); };
      li.appendChild(retry);
    }
    list.appendChild(li);
  }
}

async function runQueue(links) {
  if (Array.isArray(links)) {
    for (const url of links) {
      if (!queue.some((q) => normalizeUrl(q.url) === normalizeUrl(url))) {
        queue.push({ url, state: 'pending', title: '' });
      }
    }
  }
  renderQueue();
  if (queueRunning) return;
  queueRunning = true;
  $('#fetchBtn').disabled = true;

  for (const item of queue) {
    if (item.state !== 'pending') continue;
    item.state = 'working';
    renderQueue();
    try {
      const data = await fetchInfo(item.url);
      item.title = data.title || '';
      const s = pickSource(data, opts);
      if (!s.url) throw new Error('format unavailable');
      const name = `${sanitizeName(data.author?.nickname || 'tiktok')}-${data.id || Date.now()}.${s.ext}`;
      const outcome = await saveFile(s.url, name, { allowPicker: false });
      if (outcome === 'cancelled') { item.state = 'failed'; }
      else {
        recordDownload({
          url: item.url, id: data.id, title: data.title,
          author: data.author?.nickname || '',
          format: opts.format, quality: opts.quality,
        });
        item.state = 'done';
      }
    } catch (err) {
      item.state = 'failed';
      item.error = err.message;
    }
    renderQueue();
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  queueRunning = false;
  $('#fetchBtn').disabled = false;
  const done = queue.filter((q) => q.state === 'done').length;
  const failed = queue.filter((q) => q.state === 'failed').length;
  toast(`Batch done — ${done} saved${failed ? `, ${failed} failed` : ''}`);
}

/* ---------------- clipboard ---------------- */
let clipboardChecking = false;
async function checkClipboard() {
  if (clipboardChecking) return;
  if (!navigator.clipboard || !navigator.clipboard.readText) return;
  if (document.visibilityState !== 'visible') return;
  clipboardChecking = true;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    clipboardChecking = false;
    return; // permission denied or not allowed without a gesture (e.g. iOS Safari)
  }
  clipboardChecking = false;

  const banner = $('#clipboardBanner');
  const m = text.match(TT_URL_RE);
  if (!m) { banner.hidden = true; return; }
  const link = m[0];
  if (normalizeUrl(link) === normalizeUrl($('#linkInput').value || '')) { banner.hidden = true; return; }
  if (load(KEYS.dismissed, '') === normalizeUrl(link)) { banner.hidden = true; return; }

  banner.hidden = false;
  $('#clipPaste').onclick = () => {
    $('#linkInput').value = link;
    autoGrow();
    banner.hidden = true;
    handleFetch();
  };
  $('#clipDismiss').onclick = () => {
    banner.hidden = true;
    save(KEYS.dismissed, normalizeUrl(link));
  };
}

/* ---------------- views ---------------- */
function showView(name) {
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  const navMap = { home: '#navHome', stats: '#navStats', settings: '#navSettings' };
  $$('.topbar-actions .iconbtn').forEach((b) => b.classList.remove('active'));
  if (navMap[name]) $(navMap[name]).classList.add('active');
  if (name === 'stats') renderStats();
  window.scrollTo({ top: 0 });
}

/* ---------------- input autogrow ---------------- */
function autoGrow() {
  const el = $('#linkInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 260) + 'px';
}

/* ---------------- theme ---------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f6f7' : '#000000');
}

/* ---------------- export ---------------- */
function exportHistory() {
  const lines = [
    `Snatch — download history`,
    `Exported ${new Date().toLocaleString()}`,
    `Lifetime downloads: ${count}`,
    ``,
  ];
  for (const h of history) {
    lines.push(`[${new Date(h.ts).toLocaleString()}] ${h.format}/${h.quality}  ${h.url}${h.title ? `  — ${h.title}` : ''}`);
  }
  lines.push('', '--- daily totals ---');
  for (const [k, v] of Object.entries(daily).sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    lines.push(`${k}: ${v}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `snatch-history-${todayKey()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------------- init ---------------- */
function init() {
  applyTheme(settings.theme);
  setSegment('#formatSeg', opts.format);
  setSegment('#themeSeg', settings.theme);
  setSegment('#defFormatSeg', settings.defaultFormat);
  $('#autoSaveToggle').checked = settings.autoSave;
  $('#dupToggle').checked = settings.warnDup;
  renderCounter();
  renderHistory();
  renderStats();

  // nav
  $('#navHome').onclick = () => showView('home');
  $('#navStats').onclick = () => showView('stats');
  $('#navSettings').onclick = () => showView('settings');

  // input
  const input = $('#linkInput');
  input.addEventListener('input', autoGrow);
  $('#fetchBtn').onclick = () => handleFetch();
  $('#clearInput').onclick = () => { input.value = ''; autoGrow(); hideResult(); hideStatus(); };
  $('#pasteBtn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { input.value = opts.batch && input.value ? input.value + '\n' + t : t; autoGrow(); }
      else toast('Clipboard is empty');
    } catch {
      toast('Clipboard blocked — paste manually');
      input.focus();
    }
  };
  $('#batchToggle').onclick = () => {
    opts.batch = !opts.batch;
    $('#batchToggle').setAttribute('aria-pressed', String(opts.batch));
    $('#batchToggle').classList.toggle('btn-accent', opts.batch);
    input.classList.toggle('batch', opts.batch);
    input.rows = opts.batch ? 5 : 1;
    input.placeholder = opts.batch
      ? 'Paste several TikTok links, one per line…'
      : 'https://www.tiktok.com/@user/video/...';
    $('#batchHint').hidden = !opts.batch;
    autoGrow();
  };
  $('#clearQueue').onclick = () => { queue = []; renderQueue(); };

  // segments
  wireSegment('#formatSeg', (v) => { opts.format = v; refreshResult(); });
  wireSegment('#qualitySeg', (v) => { opts.quality = v; refreshResult(); });
  $('#watermarkToggle').onchange = (e) => { opts.watermark = e.target.checked; refreshResult(); };

  // settings
  wireSegment('#themeSeg', (v) => { settings.theme = v; persistSettings(); applyTheme(v); });
  wireSegment('#defFormatSeg', (v) => { settings.defaultFormat = v; persistSettings(); });
  $('#autoSaveToggle').onchange = (e) => { settings.autoSave = e.target.checked; persistSettings(); };
  $('#dupToggle').onchange = (e) => { settings.warnDup = e.target.checked; persistSettings(); };
  $('#exportBtn').onclick = exportHistory;
  $('#resetCounterBtn').onclick = () => {
    if (!confirm('Reset the lifetime counter and daily stats to zero?')) return;
    count = 0; daily = {};
    save(KEYS.count, count); save(KEYS.daily, daily);
    renderCounter(); renderStats();
    toast('Counter reset');
  };
  $('#clearHistoryBtn').onclick = () => {
    if (!confirm('Delete all recent-download history? Stats and the counter are kept.')) return;
    history = [];
    save(KEYS.history, history);
    renderHistory();
    toast('History cleared');
  };

  // share target + deep links
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (shared) {
    const m = shared.match(TT_URL_RE);
    if (m) {
      input.value = m[0];
      autoGrow();
      toast('Link received — tap Snatch it');
      setTimeout(() => handleFetch(), 400);
    }
  }
  const view = params.get('view');
  if (view === 'batch') { showView('home'); $('#batchToggle').click(); }
  else if (view === 'stats') showView('stats');
  else showView('home');
  if (location.search) history_replace();

  // clipboard detection
  checkClipboard();
  window.addEventListener('focus', checkClipboard);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkClipboard();
  });

  // service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      $('#swState').textContent = 'Offline-ready.';
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update available — reopen to refresh');
          }
        });
      });
    }).catch(() => {});
  }
}

function history_replace() {
  try {
    window.history.replaceState({}, '', location.pathname);
  } catch {}
}

document.addEventListener('DOMContentLoaded', init);
