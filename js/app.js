import {
  parseChordPro, formatChord, isChord, semitonesBetween, transposeKey, useFlatsFor, KEYS,
  sectionsOf, sectionShort, textToChordPro, extractMeta, guessKey,
} from './chordpro.js';
import { openStore, cloudConfigured, teamLogin, teamLogout, LocalStore } from './store.js';
import { Metronome, makeTapper } from './metronome.js';

const APP_VERSION = '1.0.1';

// ---------------- Utilidades ----------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const TIMES = ['4/4', '3/4', '6/8', '2/4', '12/8', '2/2', '5/4', '7/8'];
const INSTRUMENTS = [
  ['general', 'General'], ['bateria', 'Batería'], ['bajo', 'Bajo'], ['teclado', 'Teclado'],
  ['guitarra', 'Guitarra'], ['voces', 'Voces'], ['sonido', 'Sonido'],
];

function parseDate(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return y ? new Date(y, m - 1, d) : null;
}
function todayISO() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function nextSundayISO() {
  const t = new Date();
  t.setDate(t.getDate() + ((7 - t.getDay()) % 7));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function longDate(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  return `${DAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

// ---------------- Preferencias (por dispositivo) ----------------

const PREF_DEFAULTS = {
  name: '', instrument: 'general', notation: 'en', fontSize: 20, pedal: 'scroll',
  theme: 'auto', showChords: true,
};
function loadPrefs() {
  try { return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('prefs') || '{}') }; } catch { return { ...PREF_DEFAULTS }; }
}
const prefs = loadPrefs();
function savePrefs() {
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* sin almacenamiento */ }
  applyPrefs();
}
function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);
  root.style.setProperty('--chart-size', prefs.fontSize + 'px');
}
applyPrefs();

// ---------------- Estado ----------------

let store;
const state = { songs: [], setlists: [] };
const metro = new Metronome();
const tapper = makeTapper();
let viewCleanup = null;
let wakeLock = null;

function songById(id) { return state.songs.find((s) => s.id === id); }
function setById(id) { return state.setlists.find((s) => s.id === id); }

function stamp(doc) {
  return { ...doc, updatedAt: Date.now(), updatedBy: prefs.name || '' };
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------- Render del cifrado ----------------

export function renderChart(src, { semis = 0, flats = false, notation = 'en', showChords = true } = {}) {
  const { blocks } = parseChordPro(src);
  const fmt = (c) => (isChord(c) ? formatChord(c, semis, flats, notation) : c);
  let html = '';
  for (const b of blocks) {
    if (b.type === 'section') html += `<div class="sec">${esc(b.label)}</div>`;
    else if (b.type === 'comment') html += `<div class="cm">${esc(b.text)}</div>`;
    else if (b.type === 'tab') html += `<div class="tab">${esc(b.text)}</div>`;
    else if (b.type === 'space') html += '<div class="sp"></div>';
    else if (b.type === 'line') {
      const hasChord = b.segments.some((s) => s.chord);
      const hasText = b.segments.some((s) => s.text.trim());
      if (!hasChord) {
        html += `<div class="ln lyr"><span class="ly">${esc(b.segments.map((s) => s.text).join(''))}</span></div>`;
      } else if (!hasText) {
        html += `<div class="ln chords-only">${b.segments.filter((s) => s.chord).map((s) => `<span class="seg"><span class="ch">${esc(fmt(s.chord))}</span></span>`).join('')}</div>`;
      } else if (!showChords) {
        html += `<div class="ln lyr"><span class="ly">${esc(b.segments.map((s) => s.text).join(''))}</span></div>`;
      } else {
        html += '<div class="ln">' + b.segments.map((s) => {
          const ch = s.chord ? esc(fmt(s.chord)) : '';
          const text = s.text || (s.chord ? ' ' : '');
          return `<span class="seg"><span class="ch">${ch || '&#8203;'}</span><span class="ly">${esc(text)}</span></span>`;
        }).join('') + '</div>';
      }
    }
  }
  return `<div class="chart${showChords ? '' : ' no-chords'}">${html}</div>`;
}

function songMetaPills(song, key) {
  const out = [];
  if (key) out.push(`<span class="pill key">Tono ${esc(displayKey(key))}</span>`);
  if (song.bpm) out.push(`<span class="pill">${esc(song.bpm)} BPM</span>`);
  if (song.time) out.push(`<span class="pill">${esc(song.time)}</span>`);
  return out.join('');
}

function displayKey(k) {
  return k ? formatChord(k, 0, false, prefs.notation) : '';
}

function sectionMap(src) {
  const secs = sectionsOf(src);
  if (!secs.length) return '';
  return `<div class="map" aria-label="Estructura">${secs.map((s) => `<span>${esc(sectionShort(s))}</span>`).join('')}</div>`;
}

function notesFor(song) {
  const n = song.notes || {};
  const out = [];
  if (n.general) out.push(`<div class="notes-box"><b>Notas</b>${esc(n.general)}</div>`);
  if (prefs.instrument !== 'general' && n[prefs.instrument]) {
    const label = INSTRUMENTS.find(([k]) => k === prefs.instrument)?.[1] || '';
    out.push(`<div class="notes-box"><b>${esc(label)}</b>${esc(n[prefs.instrument])}</div>`);
  }
  return out.join('');
}

function otherNotes(song) {
  const n = song.notes || {};
  const items = INSTRUMENTS.filter(([k]) => k !== 'general' && k !== prefs.instrument && n[k]);
  if (!items.length) return '';
  return `<details class="no-print" style="margin:8px 0"><summary class="small">Notas de otros instrumentos</summary>${items.map(([k, l]) => `<div class="notes-box"><b>${esc(l)}</b>${esc(n[k])}</div>`).join('')}</details>`;
}

// ---------------- Herramientas: transponer y metrónomo ----------------

function toolsHTML(baseKey, semis, song) {
  const shown = baseKey ? displayKey(transposeKey(baseKey, semis)) : (semis ? (semis > 0 ? '+' : '') + semis : '0');
  return `
  <div class="tools no-print">
    <div class="seg-ctl" role="group" aria-label="Transponer">
      <button data-act="tr-" aria-label="Bajar medio tono">−</button>
      <span class="val" data-role="keyval">${esc(shown)}</span>
      <button data-act="tr+" aria-label="Subir medio tono">+</button>
    </div>
    <div class="seg-ctl" role="group" aria-label="Tamaño de letra">
      <button data-act="fs-" aria-label="Letra más chica" style="font-size:14px">A</button>
      <button data-act="fs+" aria-label="Letra más grande" style="font-size:20px">A</button>
    </div>
    <button class="btn small" data-act="chords" aria-pressed="${prefs.showChords}">${prefs.showChords ? 'Ocultar acordes' : 'Mostrar acordes'}</button>
    <div class="metro${metro.running ? ' running' : ''}">
      <button class="btn small tog" data-act="metro" aria-label="Metrónomo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8l-2.5-17h-3z"/><path d="M12 15l5-8"/></svg>
        <span data-role="bpm">${esc(song?.bpm || metro.bpm)}</span>
      </button>
      <button class="btn small" data-act="tap">Tap</button>
      <span class="beats" data-role="beats"></span>
    </div>
  </div>`;
}

function wireTools(root, ctx) {
  // ctx: { song, baseKey, semis, onChange(semis) }
  const beatsEl = $('[data-role=beats]', root);
  const drawBeats = (on = -1) => {
    if (!beatsEl) return;
    beatsEl.innerHTML = Array.from({ length: metro.beats }, (_, i) => `<i class="${i === on ? 'on' : ''}${i === 0 ? ' first' : ''}"></i>`).join('');
  };
  if (ctx.song) metro.set(ctx.song.bpm || metro.bpm, ctx.song.time);
  drawBeats();
  metro.onBeat = (b) => drawBeats(b);

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'tr-' || act === 'tr+') {
      ctx.semis = (ctx.semis + (act === 'tr+' ? 1 : -1) + 12) % 12;
      ctx.onChange(ctx.semis);
    } else if (act === 'fs-' || act === 'fs+') {
      prefs.fontSize = Math.max(12, Math.min(44, prefs.fontSize + (act === 'fs+' ? 2 : -2)));
      savePrefs();
    } else if (act === 'chords') {
      prefs.showChords = !prefs.showChords;
      savePrefs();
      ctx.onChange(ctx.semis);
    } else if (act === 'metro') {
      const on = metro.toggle();
      b.closest('.metro').classList.toggle('running', on);
      if (!on) drawBeats();
    } else if (act === 'tap') {
      const bpm = tapper();
      if (bpm) {
        metro.set(bpm);
        const el = $('[data-role=bpm]', root);
        if (el) el.textContent = bpm;
      }
    }
  });
}

// ---------------- Pedal / teclado ----------------

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight', 'PageDown', ' ', 'Spacebar']);
const PREV_KEYS = new Set(['ArrowUp', 'ArrowLeft', 'PageUp']);

function onPedal(handler) {
  const fn = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (NEXT_KEYS.has(e.key)) { e.preventDefault(); handler(1); }
    else if (PREV_KEYS.has(e.key)) { e.preventDefault(); handler(-1); }
  };
  window.addEventListener('keydown', fn);
  return () => window.removeEventListener('keydown', fn);
}

function scrollPage(dir) {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const y = window.scrollY;
  if (dir > 0 && y >= max - 4) return false;
  if (dir < 0 && y <= 4) return false;
  window.scrollBy({ top: dir * window.innerHeight * 0.8, behavior: 'smooth' });
  return true;
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* no disponible */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.body.classList.contains('playing')) keepAwake(true);
});

// ---------------- Barra superior ----------------

function topbar(title, { back, actions = '', sub = '' } = {}) {
  $('#topbar').innerHTML = `
    ${back ? `<a class="btn icon ghost" href="${esc(back)}" aria-label="Volver"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></a>` : ''}
    <h1>${esc(title)}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}</h1>
    ${actions}`;
}

function setTab(name) {
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
}

function statusHTML() {
  const st = store.status();
  const cls = st.mode === 'local' ? 'local' : (st.warn ? 'warn' : '');
  return `<div class="status ${cls}" data-role="status"><span class="dot"></span>${esc(st.label)}${st.mode === 'local' ? ' · <a href="#/settings">Conectar al equipo</a>' : ''}</div>`;
}

// ---------------- Vistas ----------------

function viewSetlists() {
  setTab('sets');
  topbar('Repertorios', { actions: '<button class="btn primary small" data-act="new-set">+ Nuevo</button>' });
  const today = todayISO();
  const sets = [...state.setlists];
  const upcoming = sets.filter((s) => (s.date || '') >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = sets.filter((s) => (s.date || '') < today).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const card = (s) => {
    const d = parseDate(s.date);
    const titles = (s.items || []).map((it) => songById(it.songId)?.title).filter(Boolean);
    return `<li><a class="item" href="#/set/${esc(s.id)}">
      <div class="datebox">${d ? `<div class="d">${d.getDate()}</div><div class="m">${MONTHS[d.getMonth()]}</div>` : ''}</div>
      <div class="grow"><div class="t">${esc(s.name || 'Repertorio')}</div>
      <div class="s">${titles.length ? esc(titles.join(' · ')) : 'Sin canciones'}</div></div>
      <div class="meta">${titles.length} ${titles.length === 1 ? 'canción' : 'canciones'}</div></a></li>`;
  };

  $('#view').innerHTML = `${statusHTML()}
    ${!sets.length ? `<div class="empty"><p><b>Aún no hay repertorios.</b><br>Crea el del próximo domingo y agrega las canciones.</p>
      <button class="btn primary" data-act="new-set">Crear repertorio</button>
      ${!state.songs.length ? '<p class="small">Tip: primero carga canciones en la pestaña <a href="#/songs">Canciones</a>.</p>' : ''}</div>` : ''}
    ${upcoming.length ? `<h2 class="group">Próximos</h2><ul class="list">${upcoming.map(card).join('')}</ul>` : ''}
    ${past.length ? `<h2 class="group">Anteriores</h2><ul class="list" data-role="past">${past.slice(0, 12).map(card).join('')}</ul>
      ${past.length > 12 ? '<p class="row end"><button class="btn small" data-act="more">Ver todos</button></p>' : ''}` : ''}`;

  const onClick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'new-set') {
      const s = stamp({ id: uid(), name: 'Servicio dominical', date: nextSundayISO(), notes: '', items: [], createdAt: Date.now() });
      await store.put('setlists', s);
      location.hash = `#/set/${s.id}`;
    } else if (b.dataset.act === 'more') {
      $('[data-role=past]').innerHTML = past.map(card).join('');
      b.remove();
    }
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}

function viewSetlist(id) {
  setTab('sets');
  const s = setById(id);
  if (!s) { $('#view').innerHTML = '<div class="empty">Este repertorio ya no existe.</div>'; topbar('Repertorio', { back: '#/' }); return null; }
  topbar(s.name || 'Repertorio', { back: '#/', sub: longDate(s.date) });

  const items = s.items || [];
  const keyOptions = (sel) => {
    const minor = /m$/.test(sel || '') && !/maj/.test(sel || '');
    const ks = KEYS.map((k) => (minor ? (k + 'm') : k));
    if (sel && !ks.includes(sel)) ks.unshift(sel);
    return ['<option value="">—</option>', ...ks.map((k) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(displayKey(k))}</option>`)].join('');
  };

  $('#view').innerHTML = `
    <div class="stack">
      <div class="grid">
        <label class="f">Nombre<input type="text" data-f="name" value="${esc(s.name || '')}"></label>
        <label class="f">Fecha<input type="date" data-f="date" value="${esc(s.date || '')}"></label>
      </div>
      <label class="f">Notas para el equipo<textarea data-f="notes" rows="2" placeholder="Ej.: Ensayo sábado 18:00. Entrada directa al coro en la 2.">${esc(s.notes || '')}</textarea></label>
      <div class="row">
        <a class="btn primary grow" href="#/play/${esc(s.id)}/0" ${items.length ? '' : 'aria-disabled="true" style="pointer-events:none;opacity:.45"'}>▶ Tocar</a>
        <button class="btn" data-act="add">+ Agregar canción</button>
      </div>
      <ul class="list" data-role="items">
        ${items.map((it, i) => {
          const song = songById(it.songId);
          return `<li class="set-item" data-i="${i}">
            <span class="num">${i + 1}</span>
            <div class="info">
              ${song ? `<a href="#/play/${esc(s.id)}/${i}">${esc(song.title)}</a><span class="muted small">${esc([song.artist, song.bpm && song.bpm + ' BPM', song.key && 'original ' + displayKey(song.key)].filter(Boolean).join(' · '))}</span>`
                : '<span class="muted">Canción eliminada</span>'}
              <input type="text" class="note-in" data-note="${i}" value="${esc(it.note || '')}" placeholder="Nota para esta vez (opcional)">
            </div>
            <select data-key="${i}" aria-label="Tono para este repertorio">${keyOptions(it.key || song?.key || '')}</select>
            <div class="acts">
              <button class="btn icon small ghost" data-move="${i}" data-dir="-1" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn icon small ghost" data-move="${i}" data-dir="1" aria-label="Bajar" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn icon small ghost danger" data-del="${i}" aria-label="Quitar">✕</button>
            </div>
          </li>`;
        }).join('')}
      </ul>
      ${!items.length ? '<div class="empty small">Agrega las canciones del servicio en orden.</div>' : ''}
      <div class="row end" style="margin-top:20px">
        <button class="btn small" data-act="dup">Duplicar</button>
        <button class="btn small danger" data-act="del-set">Eliminar repertorio</button>
      </div>
      ${s.updatedBy ? `<p class="muted small">Última edición: ${esc(s.updatedBy)}</p>` : ''}
    </div>`;

  const save = (patch) => store.put('setlists', stamp({ ...setById(id), ...patch }));
  const view = $('#view');

  const onChange = (e) => {
    const t = e.target;
    const cur = setById(id);
    if (t.dataset.f) save({ [t.dataset.f]: t.value });
    else if (t.dataset.key !== undefined) {
      const its = [...cur.items];
      its[+t.dataset.key] = { ...its[+t.dataset.key], key: t.value };
      save({ items: its });
    } else if (t.dataset.note !== undefined) {
      const its = [...cur.items];
      its[+t.dataset.note] = { ...its[+t.dataset.note], note: t.value };
      save({ items: its });
    }
  };
  const onClick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const cur = setById(id);
    if (b.dataset.move !== undefined) {
      const i = +b.dataset.move; const j = i + +b.dataset.dir;
      const its = [...cur.items];
      [its[i], its[j]] = [its[j], its[i]];
      save({ items: its });
    } else if (b.dataset.del !== undefined) {
      const its = cur.items.filter((_, k) => k !== +b.dataset.del);
      save({ items: its });
    } else if (b.dataset.act === 'add') {
      pickSongs((ids) => {
        const c = setById(id);
        const its = [...(c.items || []), ...ids.map((sid) => ({ songId: sid, key: songById(sid)?.key || '', note: '' }))];
        save({ items: its });
      });
    } else if (b.dataset.act === 'del-set') {
      if (confirm('¿Eliminar este repertorio? Las canciones no se borran.')) {
        await store.remove('setlists', id);
        location.hash = '#/';
      }
    } else if (b.dataset.act === 'dup') {
      const copy = stamp({ ...cur, id: uid(), date: nextSundayISO(), createdAt: Date.now(), name: cur.name });
      await store.put('setlists', copy);
      toast('Repertorio duplicado para el próximo domingo');
      location.hash = `#/set/${copy.id}`;
    }
  };
  view.addEventListener('change', onChange);
  view.addEventListener('click', onClick);
  return () => { view.removeEventListener('change', onChange); view.removeEventListener('click', onClick); };
}

let dataPending = false;
function closeModal() {
  $('#modal-root').innerHTML = '';
  if (dataPending) { dataPending = false; onData(); }
}

function pickSongs(onDone) {
  const root = $('#modal-root');
  const chosen = [];
  root.innerHTML = `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-label="Agregar canciones">
    <div class="row"><h3>Agregar canciones</h3><button class="btn small primary" data-act="ok">Listo</button></div>
    <input type="search" placeholder="Buscar por título o artista" data-role="q" style="margin-top:10px">
    <div class="body"><ul class="list" data-role="res"></ul></div></div></div>`;
  const draw = () => {
    const q = norm($('[data-role=q]', root).value);
    const list = state.songs.filter((s) => !q || norm(s.title + ' ' + s.artist).includes(q)).sort((a, b) => a.title.localeCompare(b.title, 'es'));
    $('[data-role=res]', root).innerHTML = list.length ? list.map((s) => `<li><button class="item" style="width:100%;text-align:left" data-id="${esc(s.id)}">
      <div class="grow"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.artist || '')}</div></div>
      <div class="meta">${chosen.includes(s.id) ? `<span class="pill key">#${chosen.indexOf(s.id) + 1}</span>` : (s.key ? esc(displayKey(s.key)) : '')}</div></button></li>`).join('')
      : `<div class="empty small">No hay canciones${q ? ' con ese nombre' : ''}. <a href="#/songs/new">Crear una</a></div>`;
  };
  draw();
  const close = closeModal;
  root.onclick = (e) => {
    if (e.target.classList.contains('backdrop')) { close(); return; }
    const b = e.target.closest('button');
    if (!b) { if (e.target.closest('a')) close(); return; }
    if (b.dataset.act === 'ok') { close(); if (chosen.length) onDone(chosen); return; }
    if (b.dataset.id) {
      const i = chosen.indexOf(b.dataset.id);
      if (i >= 0) chosen.splice(i, 1); else chosen.push(b.dataset.id);
      draw();
    }
  };
  $('[data-role=q]', root).oninput = draw;
  setTimeout(() => $('[data-role=q]', root)?.focus(), 50);
}

function viewPlay(setId, index) {
  setTab('sets');
  document.body.classList.add('playing');
  keepAwake(true);
  const s = setById(setId);
  const i = Math.max(0, Math.min(+index || 0, (s?.items?.length || 1) - 1));
  const it = s?.items?.[i];
  const song = it && songById(it.songId);
  if (!s || !song) {
    topbar('Tocar', { back: `#/set/${setId}` });
    $('#view').innerHTML = '<div class="empty">No hay canción en esta posición.</div>';
    return () => { document.body.classList.remove('playing'); keepAwake(false); };
  }
  const total = s.items.length;
  const baseKey = song.key || guessKey(song.chordpro) || '';
  const ctx = { song, baseKey, semis: baseKey && it.key ? semitonesBetween(baseKey, it.key) : 0 };
  const nextSong = s.items[i + 1] && songById(s.items[i + 1].songId);

  const draw = () => {
    const key = baseKey ? transposeKey(baseKey, ctx.semis) : '';
    topbar(`${i + 1}/${total} · ${song.title}`, {
      back: `#/set/${setId}`,
      actions: `<a class="btn small no-print" href="#/song/${esc(song.id)}/edit" aria-label="Editar canción">Editar</a>`,
    });
    $('#view').innerHTML = `
      <div class="song-head">
        <div class="play-progress">${esc(s.name || '')} · ${esc(longDate(s.date))}</div>
        <h2>${esc(song.title)}</h2>
        <div class="by">${esc(song.artist || '')}</div>
        <div class="meta-row">${songMetaPills(song, key)}</div>
      </div>
      ${it.note ? `<div class="notes-box"><b>Para esta vez</b>${esc(it.note)}</div>` : ''}
      ${notesFor(song)}
      ${sectionMap(song.chordpro)}
      ${toolsHTML(baseKey, ctx.semis, song)}
      ${renderChart(song.chordpro, { semis: ctx.semis, flats: useFlatsFor(key), notation: prefs.notation, showChords: prefs.showChords })}
      ${otherNotes(song)}
      <div class="play-nav no-print">
        <a class="btn" href="#/play/${esc(setId)}/${i - 1}" ${i === 0 ? 'style="visibility:hidden"' : ''}>← Anterior</a>
        ${i < total - 1 ? `<a class="btn primary" href="#/play/${esc(setId)}/${i + 1}">Siguiente: ${esc(nextSong?.title || '')} →</a>` : `<a class="btn" href="#/set/${esc(setId)}">Fin del repertorio</a>`}
      </div>`;
    const tools = $('.tools');
    wireTools(tools, { ...ctx, onChange: (v) => { ctx.semis = v; const y = scrollY; draw(); scrollTo(0, y); } });
  };
  draw();
  scrollTo(0, 0);

  const go = (dir) => {
    const j = i + dir;
    if (j >= 0 && j < total) location.hash = `#/play/${setId}/${j}`;
  };
  const offPedal = onPedal((dir) => {
    if (prefs.pedal === 'song') go(dir);
    else if (!scrollPage(dir)) go(dir);
  });
  return () => { offPedal(); document.body.classList.remove('playing'); };
}

function viewSongs() {
  setTab('songs');
  topbar('Canciones', {
    actions: `<label class="btn small" style="cursor:pointer">Importar PDF<input type="file" accept="application/pdf,.pdf" multiple hidden data-role="pdf"></label>
      <a class="btn small primary" href="#/songs/new">+ Nueva</a>`,
  });
  const q0 = viewSongs.q || '';
  $('#view').innerHTML = `
    <div class="searchbar"><input type="search" placeholder="Buscar por título, artista o tono" value="${esc(q0)}" data-role="q" aria-label="Buscar canciones"></div>
    <ul class="list" data-role="list"></ul>`;
  const draw = () => {
    const q = norm($('[data-role=q]').value);
    viewSongs.q = $('[data-role=q]').value;
    const list = state.songs
      .filter((s) => !q || norm(`${s.title} ${s.artist} ${s.key}`).includes(q))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'es'));
    $('[data-role=list]').innerHTML = list.length ? list.map((s) => `<li><a class="item" href="#/song/${esc(s.id)}">
      <div class="grow"><div class="t">${esc(s.title || 'Sin título')}</div><div class="s">${esc(s.artist || '')}</div></div>
      <div class="meta">${s.key ? `<span class="pill">${esc(displayKey(s.key))}</span>` : ''} ${s.bpm ? esc(s.bpm) + ' bpm' : ''}${s.hasPdf ? ' · PDF' : ''}</div></a></li>`).join('')
      : (state.songs.length ? '<div class="empty">Sin resultados.</div>'
        : `<div class="empty"><p><b>Tu biblioteca está vacía.</b><br>Importa tus PDF de cifrados o escribe una canción.</p>
          <label class="btn primary" style="cursor:pointer">Importar PDF<input type="file" accept="application/pdf,.pdf" multiple hidden data-role="pdf"></label></div>`);
  };
  draw();
  const q = $('[data-role=q]');
  q.addEventListener('input', draw);
  const onChange = (e) => {
    if (e.target.dataset.role === 'pdf' && e.target.files.length) importPdfs([...e.target.files]);
  };
  document.addEventListener('change', onChange);
  return () => document.removeEventListener('change', onChange);
}

async function importPdfs(files) {
  const { importPdf } = await import('./pdfimport.js');
  let ok = 0;
  const created = [];
  for (const f of files) {
    toast(`Leyendo ${f.name}…`, 10000);
    try {
      if (f.size > 12 * 1024 * 1024) { toast(`${f.name}: muy pesado (máx. 12 MB)`); continue; }
      const r = await importPdf(f);
      const id = uid();
      const song = stamp({
        id,
        title: r.title || f.name.replace(/\.pdf$/i, ''),
        artist: r.artist || '',
        key: r.key || guessKey(r.chordpro) || '',
        bpm: r.bpm || '',
        time: r.time || '4/4',
        chordpro: r.chordpro || '',
        notes: {},
        hasPdf: true,
        pdfName: f.name,
        createdAt: Date.now(),
        needsReview: true,
      });
      await store.putPdf(id, f, f.name);
      await store.put('songs', song);
      created.push(song);
      ok++;
    } catch (e) {
      console.error(e);
      toast(`No se pudo leer ${f.name}`);
    }
  }
  toast(`${ok} de ${files.length} PDF importados. Revisa cada uno.`, 4000);
  if (created.length === 1) location.hash = `#/song/${created[0].id}/edit`;
  else render();
}

function viewSong(id) {
  setTab('songs');
  const song = songById(id);
  if (!song) { topbar('Canción', { back: '#/songs' }); $('#view').innerHTML = '<div class="empty">Esta canción ya no existe.</div>'; return null; }
  const baseKey = song.key || guessKey(song.chordpro) || '';
  const ctx = { song, baseKey, semis: 0 };
  let tab = viewSong.tab && song.hasPdf ? viewSong.tab : 'chart';

  const draw = () => {
    const key = baseKey ? transposeKey(baseKey, ctx.semis) : '';
    topbar(song.title || 'Canción', {
      back: '#/songs',
      actions: `<button class="btn small" data-act="add-to-set">+ Repertorio</button><a class="btn small primary" href="#/song/${esc(id)}/edit">Editar</a>`,
    });
    $('#view').innerHTML = `
      <div class="song-head">
        <h2>${esc(song.title)}</h2>
        <div class="by">${esc(song.artist || '')}</div>
        <div class="meta-row">${songMetaPills(song, key)}</div>
      </div>
      ${song.needsReview ? '<div class="notes-box"><b>Importado de PDF</b>Revisa que los acordes hayan quedado sobre la sílaba correcta. Toca <a href="#/song/' + esc(id) + '/edit">Editar</a> para corregir.</div>' : ''}
      ${song.hasPdf ? `<div class="tabs no-print"><button class="btn small ${tab === 'chart' ? 'on' : ''}" data-tab="chart">Cifrado</button><button class="btn small ${tab === 'pdf' ? 'on' : ''}" data-tab="pdf">PDF original</button></div>` : ''}
      <div data-role="chart-tab" class="${tab === 'chart' ? '' : 'hidden'}">
        ${notesFor(song)}
        ${sectionMap(song.chordpro)}
        ${toolsHTML(baseKey, ctx.semis, song)}
        ${song.chordpro ? renderChart(song.chordpro, { semis: ctx.semis, flats: useFlatsFor(key), notation: prefs.notation, showChords: prefs.showChords }) : '<div class="empty">Sin cifrado todavía. <a href="#/song/' + esc(id) + '/edit">Escribirlo</a></div>'}
        ${otherNotes(song)}
      </div>
      <div data-role="pdf-tab" class="${tab === 'pdf' ? '' : 'hidden'}"><div data-role="pdf" class="muted">Cargando PDF…</div></div>
      ${song.updatedBy ? `<p class="muted small" style="margin-top:24px">Última edición: ${esc(song.updatedBy)}</p>` : ''}`;
    const tools = $('.tools');
    if (tools) wireTools(tools, { ...ctx, onChange: (v) => { ctx.semis = v; const y = scrollY; draw(); scrollTo(0, y); } });
    if (tab === 'pdf') showPdf();
  };

  const showPdf = async () => {
    const box = $('[data-role=pdf]');
    if (!box || box.dataset.done) return;
    box.dataset.done = '1';
    const blob = await store.getPdf(id);
    if (!blob) { box.textContent = 'El PDF no está disponible en este dispositivo (sin señal o no se ha descargado).'; return; }
    const { renderPdf } = await import('./pdfimport.js');
    try { await renderPdf(blob, box); } catch (e) { box.textContent = 'No se pudo mostrar el PDF.'; }
  };

  draw();
  const view = $('#view');
  const onClick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && b.closest('.tabs')) {
      tab = viewSong.tab = b.dataset.tab;
      $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      $('[data-role=chart-tab]').classList.toggle('hidden', tab !== 'chart');
      $('[data-role=pdf-tab]').classList.toggle('hidden', tab !== 'pdf');
      if (tab === 'pdf') showPdf();
    }
  };
  const onTop = (e) => {
    if (e.target.closest('[data-act=add-to-set]')) addToSetlist(song);
  };
  view.addEventListener('click', onClick);
  $('#topbar').addEventListener('click', onTop);
  const offPedal = onPedal((dir) => scrollPage(dir));
  return () => { view.removeEventListener('click', onClick); $('#topbar').removeEventListener('click', onTop); offPedal(); };
}

function addToSetlist(song) {
  const today = todayISO();
  const sets = state.setlists.filter((s) => (s.date || '') >= today).sort((a, b) => a.date.localeCompare(b.date));
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-label="Agregar a repertorio">
    <div class="row"><h3>Agregar «${esc(song.title)}» a…</h3><button class="btn small" data-act="close">Cerrar</button></div>
    <div class="body"><ul class="list">
      ${sets.map((s) => `<li><button class="item" style="width:100%;text-align:left" data-id="${esc(s.id)}"><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc(longDate(s.date))}</div></div></button></li>`).join('')}
      <li><button class="item" style="width:100%;text-align:left" data-id="__new"><div class="grow"><div class="t">+ Nuevo repertorio (próximo domingo)</div></div></button></li>
    </ul></div></div></div>`;
  root.onclick = async (e) => {
    if (e.target.classList.contains('backdrop') || e.target.closest('[data-act=close]')) { closeModal(); return; }
    const b = e.target.closest('[data-id]');
    if (!b) return;
    let s;
    if (b.dataset.id === '__new') s = { id: uid(), name: 'Servicio dominical', date: nextSundayISO(), notes: '', items: [], createdAt: Date.now() };
    else s = setById(b.dataset.id);
    const items = [...(s.items || []), { songId: song.id, key: song.key || '', note: '' }];
    closeModal();
    await store.put('setlists', stamp({ ...s, items }));
    toast(`Agregada a ${s.name} (${longDate(s.date)})`);
  };
}

function viewEdit(id) {
  setTab('songs');
  const isNew = !id;
  const orig = isNew ? { id: uid(), title: '', artist: '', key: '', bpm: '', time: '4/4', chordpro: '', notes: {}, createdAt: Date.now() } : songById(id);
  if (!orig) { topbar('Editar', { back: '#/songs' }); $('#view').innerHTML = '<div class="empty">Esta canción ya no existe.</div>'; return null; }
  const song = JSON.parse(JSON.stringify(orig));
  song.notes ||= {};
  const backHref = isNew ? '#/songs' : `#/song/${song.id}`;
  let dirty = false;

  topbar(isNew ? 'Nueva canción' : 'Editar canción', {
    back: backHref,
    actions: '<button class="btn small primary" data-act="save">Guardar</button>',
  });

  const keyList = [...KEYS, ...KEYS.map((k) => k + 'm')];
  $('#view').innerHTML = `
    <form class="stack" data-role="form" onsubmit="return false">
      <div class="grid">
        <label class="f">Título<input type="text" data-f="title" value="${esc(song.title)}" required></label>
        <label class="f">Artista<input type="text" data-f="artist" value="${esc(song.artist)}"></label>
      </div>
      <div class="grid">
        <label class="f">Tono original<input type="text" data-f="key" value="${esc(song.key)}" list="keylist" placeholder="Ej.: G"></label>
        <label class="f">BPM<input type="number" inputmode="numeric" min="20" max="300" data-f="bpm" value="${esc(song.bpm)}"></label>
        <label class="f">Compás<select data-f="time">${TIMES.map((t) => `<option${t === song.time ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <datalist id="keylist">${keyList.map((k) => `<option value="${k}">`).join('')}</datalist>

      <div class="editor-cols">
        <div class="stack">
          <label class="f">Cifrado
            <textarea class="code" data-f="chordpro" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="{c: Verso 1}&#10;[G]Cuán grande es [C]Él&#10;&#10;{c: Coro}&#10;[D]Mi corazón entona…">${esc(song.chordpro)}</textarea>
          </label>
          <div class="row">
            <button class="btn small" data-act="convert" type="button">Convertir acordes sobre la letra</button>
            <button class="btn small" data-act="help" type="button">¿Cómo se escribe?</button>
            ${song.hasPdf ? '<button class="btn small" data-act="reread" type="button">Volver a leer del PDF</button>' : ''}
          </div>
          <div class="help card small hidden" data-role="help">
            <p>Pon cada acorde entre corchetes, justo antes de la sílaba donde cambia:</p>
            <pre>[G]Santo, [D]santo, [Em]santo</pre>
            <p>Secciones: una línea con <code>{c: Coro}</code>, o simplemente <code>Coro</code>, <code>Verso 2</code>, <code>Puente</code>, <code>Intro</code>.</p>
            <p>Líneas solo de acordes: <code>[G] [D] [Em] [C]</code>. Notas en cursiva: <code>{c: Repetir 2 veces}</code>.</p>
            <p>¿Tienes el cifrado con acordes en una línea y la letra abajo? Pégalo tal cual y toca <b>Convertir acordes sobre la letra</b>.</p>
          </div>
        </div>
        <div class="preview" aria-label="Vista previa"><div data-role="preview"></div></div>
      </div>

      <fieldset><legend>Notas del arreglo</legend>
        <div class="grid">
          ${INSTRUMENTS.map(([k, l]) => `<label class="f">${l}<textarea data-note="${k}" rows="2" placeholder="${k === 'bateria' ? 'Ej.: Intro solo hi-hat, coro con toms' : k === 'general' ? 'Ej.: Termina en el coro, a capella' : ''}">${esc(song.notes[k] || '')}</textarea></label>`).join('')}
        </div>
      </fieldset>

      <fieldset><legend>PDF</legend>
        <div class="row">
          <span class="grow small muted" data-role="pdfname">${song.hasPdf ? esc(song.pdfName || 'PDF adjunto') : 'Sin PDF adjunto'}</span>
          <label class="btn small" style="cursor:pointer">${song.hasPdf ? 'Reemplazar' : 'Adjuntar'} PDF<input type="file" accept="application/pdf,.pdf" hidden data-role="attach"></label>
          ${song.hasPdf ? '<button class="btn small danger" data-act="rmpdf" type="button">Quitar</button>' : ''}
        </div>
      </fieldset>

      <div class="row end">
        ${isNew ? '' : '<button class="btn danger" data-act="delete" type="button">Eliminar canción</button>'}
        <button class="btn primary" data-act="save" type="button">Guardar</button>
      </div>
    </form>`;

  const form = $('[data-role=form]');
  const ta = $('[data-f=chordpro]');
  const preview = () => {
    $('[data-role=preview]').innerHTML = renderChart(ta.value, { notation: prefs.notation, showChords: true }) || '';
  };
  preview();
  let pendingPdf = null;
  let removePdf = false;

  const collect = () => {
    for (const el of $$('[data-f]', form)) song[el.dataset.f] = el.value.trim ? (el.dataset.f === 'chordpro' ? el.value.replace(/\s+$/, '') : el.value.trim()) : el.value;
    for (const el of $$('[data-note]', form)) {
      const v = el.value.trim();
      if (v) song.notes[el.dataset.note] = v; else delete song.notes[el.dataset.note];
    }
  };

  const save = async () => {
    collect();
    if (!song.title) { toast('Falta el título'); $('[data-f=title]').focus(); return; }
    // Si el cifrado trae {title}/{key}/etc. y los campos están vacíos, se usan.
    const m = parseChordPro(song.chordpro).meta;
    if (!song.artist && m.artist) song.artist = m.artist;
    if (!song.key && m.key) song.key = m.key;
    if (!song.bpm && m.bpm) song.bpm = m.bpm;
    if (pendingPdf) {
      await store.putPdf(song.id, pendingPdf, pendingPdf.name);
      song.hasPdf = true;
      song.pdfName = pendingPdf.name;
    } else if (removePdf) {
      await store.removePdf(song.id);
      song.hasPdf = false;
      delete song.pdfName;
    }
    delete song.needsReview;
    dirty = false;
    await store.put('songs', stamp(song));
    toast('Guardado');
    location.hash = `#/song/${song.id}`;
  };

  const onInput = (e) => {
    dirty = true;
    if (e.target === ta) preview();
  };
  const onClick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'save') save();
    else if (act === 'convert') {
      ta.value = textToChordPro(ta.value);
      const meta = extractMeta(ta.value);
      if (meta.key && !$('[data-f=key]').value) $('[data-f=key]').value = meta.key;
      if (meta.bpm && !$('[data-f=bpm]').value) $('[data-f=bpm]').value = meta.bpm;
      preview(); dirty = true;
      toast('Convertido. Revisa la vista previa.');
    } else if (act === 'help') $('[data-role=help]').classList.toggle('hidden');
    else if (act === 'reread') {
      const blob = pendingPdf || await store.getPdf(song.id);
      if (!blob) { toast('PDF no disponible'); return; }
      if (ta.value.trim() && !confirm('Esto reemplaza el cifrado actual por el leído del PDF. ¿Seguir?')) return;
      const { importPdf } = await import('./pdfimport.js');
      const r = await importPdf(blob);
      ta.value = r.chordpro || '';
      preview(); dirty = true;
      if (r.scanned) toast('El PDF es una imagen escaneada: hay que escribir los acordes a mano.', 4000);
    } else if (act === 'rmpdf') {
      removePdf = true; pendingPdf = null; dirty = true;
      $('[data-role=pdfname]').textContent = 'Se quitará al guardar';
    } else if (act === 'delete') {
      const used = state.setlists.filter((s) => (s.items || []).some((it) => it.songId === song.id));
      const msg = used.length ? `Esta canción está en ${used.length} repertorio(s). ¿Eliminarla igual?` : '¿Eliminar esta canción?';
      if (!confirm(msg)) return;
      dirty = false;
      if (orig.hasPdf) await store.removePdf(song.id);
      await store.remove('songs', song.id);
      toast('Canción eliminada');
      location.hash = '#/songs';
    }
  };
  const onChange = async (e) => {
    if (e.target.dataset.role === 'attach' && e.target.files[0]) {
      pendingPdf = e.target.files[0];
      removePdf = false; dirty = true;
      $('[data-role=pdfname]').textContent = pendingPdf.name + ' (se guarda al tocar Guardar)';
      if (!ta.value.trim()) {
        const { importPdf } = await import('./pdfimport.js');
        const r = await importPdf(pendingPdf);
        ta.value = r.chordpro || '';
        for (const k of ['title', 'artist', 'key', 'bpm']) {
          const el = $(`[data-f=${k}]`);
          if (el && !el.value && r[k]) el.value = r[k];
        }
        preview();
      }
    }
  };
  const view = $('#view');
  view.addEventListener('input', onInput);
  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  const onTop = (e) => { if (e.target.closest('[data-act=save]')) save(); };
  $('#topbar').addEventListener('click', onTop);
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  const cleanup = () => {
    view.removeEventListener('input', onInput);
    view.removeEventListener('click', onClick);
    view.removeEventListener('change', onChange);
    $('#topbar').removeEventListener('click', onTop);
    window.removeEventListener('beforeunload', beforeUnload);
  };
  cleanup.isDirty = () => dirty;
  cleanup.editing = true;
  return cleanup;
}

function viewSettings() {
  setTab('settings');
  topbar('Ajustes');
  const st = store.status();
  const configured = cloudConfigured();
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  $('#view').innerHTML = `
    <div class="stack">
      <fieldset><legend>Tú</legend>
        <div class="grid">
          <label class="f">Tu nombre<input type="text" data-p="name" value="${esc(prefs.name)}" placeholder="Para saber quién editó"></label>
          <label class="f">Tu instrumento<select data-p="instrument">${INSTRUMENTS.map(([k, l]) => `<option value="${k}"${prefs.instrument === k ? ' selected' : ''}>${k === 'general' ? 'Ninguno en particular' : l}</option>`).join('')}</select></label>
        </div>
        <p class="small muted">Al tocar, las notas de tu instrumento aparecen arriba del cifrado.</p>
      </fieldset>

      <fieldset><legend>Pantalla</legend>
        <div class="grid">
          <label class="f">Notación<select data-p="notation"><option value="en"${prefs.notation === 'en' ? ' selected' : ''}>Americana (C D E)</option><option value="es"${prefs.notation === 'es' ? ' selected' : ''}>Latina (Do Re Mi)</option></select></label>
          <label class="f">Tema<select data-p="theme"><option value="auto"${prefs.theme === 'auto' ? ' selected' : ''}>Según el equipo</option><option value="dark"${prefs.theme === 'dark' ? ' selected' : ''}>Oscuro (escenario)</option><option value="light"${prefs.theme === 'light' ? ' selected' : ''}>Claro</option></select></label>
          <label class="f">Tamaño de letra<input type="number" min="12" max="44" data-p="fontSize" value="${prefs.fontSize}"></label>
        </div>
      </fieldset>

      <fieldset><legend>Pedal / teclado</legend>
        <label class="f">El pedal derecho (o flecha abajo)…<select data-p="pedal">
          <option value="scroll"${prefs.pedal === 'scroll' ? ' selected' : ''}>Baja la página; al final pasa a la siguiente canción</option>
          <option value="song"${prefs.pedal === 'song' ? ' selected' : ''}>Pasa directo a la siguiente canción</option>
        </select></label>
        <p class="small muted">Sirve con pedales Bluetooth para pasar páginas (AirTurn, PageFlip, Donner, etc.) en modo flechas o Re Pág/Av Pág. Mientras tocas, la pantalla no se apaga.</p>
      </fieldset>

      <fieldset><legend>Equipo</legend>
        <div class="status ${st.mode === 'local' ? 'local' : (st.warn ? 'warn' : '')}"><span class="dot"></span>${esc(st.label)}</div>
        ${!configured ? '<p class="small">La sincronización con el equipo todavía no está configurada. Por ahora todo se guarda solo en este dispositivo.</p>' : ''}
        ${configured && st.mode === 'local' ? `
          <form class="stack" data-role="login" onsubmit="return false">
            <label class="f">Correo del equipo<input type="email" autocomplete="username" data-l="email" required></label>
            <label class="f">Clave del equipo<input type="password" autocomplete="current-password" data-l="pass" required></label>
            <button class="btn primary" data-act="login" type="button">Conectar</button>
          </form>` : ''}
        ${st.mode === 'cloud' ? `
          <div class="row">
            <button class="btn small" data-act="upload-local">Subir lo que tenía en este dispositivo</button>
            <button class="btn small danger" data-act="logout">Desconectar</button>
          </div>` : ''}
      </fieldset>

      <fieldset><legend>Respaldo</legend>
        <div class="row">
          <button class="btn small" data-act="export">Descargar respaldo</button>
          <label class="btn small" style="cursor:pointer">Restaurar respaldo<input type="file" accept="application/json,.json" hidden data-role="import"></label>
        </div>
        <p class="small muted">${state.songs.length} canciones · ${state.setlists.length} repertorios. El respaldo incluye canciones y repertorios (no los PDF).</p>
      </fieldset>

      ${!standalone ? `<fieldset><legend>Instalar en la pantalla de inicio</legend>
        <p class="small">${isIOS ? 'En iPhone o iPad: abre esta página en Safari, toca <b>Compartir</b> (□↑) y luego <b>Agregar a inicio</b>.' : 'En Android: menú <b>⋮</b> de Chrome → <b>Instalar app</b> o <b>Agregar a pantalla principal</b>.'}</p>
      </fieldset>` : ''}

      <p class="small muted">MiAlabanza Team v${APP_VERSION}</p>
    </div>`;

  const view = $('#view');
  const onChange = async (e) => {
    const t = e.target;
    if (t.dataset.p) {
      prefs[t.dataset.p] = t.dataset.p === 'fontSize' ? Math.max(12, Math.min(44, +t.value || 20)) : t.value;
      savePrefs();
      toast('Ajuste guardado');
    } else if (t.dataset.role === 'import' && t.files[0]) {
      try {
        const data = JSON.parse(await t.files[0].text());
        if (!Array.isArray(data.songs) || !Array.isArray(data.setlists)) throw new Error('formato');
        if (!confirm(`Restaurar ${data.songs.length} canciones y ${data.setlists.length} repertorios? Se agregan o reemplazan por id; no se borra nada.`)) return;
        for (const s of data.songs) await store.put('songs', s);
        for (const s of data.setlists) await store.put('setlists', s);
        toast('Respaldo restaurado');
      } catch { toast('Ese archivo no es un respaldo válido'); }
    }
  };
  const onClick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'export') {
      const data = { app: 'repertorio', version: 1, exportedAt: new Date().toISOString(), songs: state.songs, setlists: state.setlists };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mialabanza-respaldo-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } else if (act === 'login') {
      const email = $('[data-l=email]').value.trim();
      const pass = $('[data-l=pass]').value;
      if (!email || !pass) { toast('Falta el correo o la clave'); return; }
      b.disabled = true; b.textContent = 'Conectando…';
      try {
        await teamLogin(email, pass);
        toast('Conectado. Cargando datos del equipo…');
        await restart();
        const local = store.local;
        const n = local ? local.all('songs').length + local.all('setlists').length : 0;
        if (n && confirm(`Hay ${n} elementos guardados solo en este dispositivo. ¿Subirlos al equipo?`)) await uploadLocal();
      } catch (err) {
        console.error(err);
        const code = err.code || '';
        const msg = /network/.test(code) ? 'Sin conexión. Intenta con señal.'
          : /too-many-requests/.test(code) ? 'Demasiados intentos. Espera unos minutos.'
          : /operation-not-allowed/.test(code) ? 'El inicio con correo no está habilitado en Firebase.'
          : /invalid-email/.test(code) ? 'Ese correo no es válido.'
          : /(invalid-credential|wrong-password|user-not-found|invalid-login)/.test(code) ? 'Correo o clave incorrectos'
          : 'No se pudo conectar (' + code + ')';
        toast(msg, 4000);
        b.disabled = false; b.textContent = 'Conectar';
      }
    } else if (act === 'logout') {
      if (!confirm('¿Desconectar este dispositivo del equipo? Volverá al modo local.')) return;
      await teamLogout();
      await restart();
    } else if (act === 'upload-local') {
      await uploadLocal();
    }
  };
  view.addEventListener('change', onChange);
  view.addEventListener('click', onClick);
  return () => { view.removeEventListener('change', onChange); view.removeEventListener('click', onClick); };
}

async function uploadLocal() {
  const local = store.local || new LocalStore();
  if (!local.db) await local.init();
  const songs = local.all('songs');
  const sets = local.all('setlists');
  const pdfs = await local.allPdfs();
  for (const s of songs) await store.put('songs', s);
  for (const s of sets) await store.put('setlists', s);
  for (const p of pdfs) await store.putPdf(p.id, p.blob, p.name);
  toast(`Subidos: ${songs.length} canciones, ${sets.length} repertorios, ${pdfs.length} PDF`, 3500);
}

// ---------------- Router ----------------

function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  return parts;
}

function render() {
  const parts = route();
  if (viewCleanup) { viewCleanup(); viewCleanup = null; }
  $('#modal-root').innerHTML = '';
  if (parts[0] !== 'play') document.body.classList.remove('playing');
  if (parts[0] !== 'play') keepAwake(false);
  let c = null;
  if (!parts.length) c = viewSetlists();
  else if (parts[0] === 'set' && parts[1]) c = viewSetlist(parts[1]);
  else if (parts[0] === 'play' && parts[1]) c = viewPlay(parts[1], parts[2]);
  else if (parts[0] === 'songs' && parts[1] === 'new') c = viewEdit(null);
  else if (parts[0] === 'songs') c = viewSongs();
  else if (parts[0] === 'song' && parts[1] && parts[2] === 'edit') c = viewEdit(parts[1]);
  else if (parts[0] === 'song' && parts[1]) c = viewSong(parts[1]);
  else if (parts[0] === 'settings') c = viewSettings();
  else c = viewSetlists();
  viewCleanup = c || null;
}

let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (viewCleanup?.isDirty?.() && !confirm('Hay cambios sin guardar. ¿Salir igual?')) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  const changedView = location.hash !== lastHash;
  lastHash = location.hash;
  metro.stop(); // al cambiar de canción o de pantalla, el metrónomo se detiene
  render();
  if (changedView && !location.hash.startsWith('#/play')) window.scrollTo(0, 0);
});

// Re-render cuando cambian los datos (otro músico editó, o llegó la sincronización).
let rerenderTimer = null;
function onData() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    if (viewCleanup?.editing) return; // no pisar lo que se está escribiendo
    if ($('#modal-root').children.length) { dataPending = true; return; } // hay un selector abierto
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && $('#view').contains(active)) {
      // Solo refrescar el indicador de estado para no interrumpir la escritura.
      const s = $('[data-role=status]');
      if (s) s.outerHTML = statusHTML();
      return;
    }
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }, 150);
}

let unsubs = [];
async function restart() {
  unsubs.forEach((u) => u());
  store?.dispose?.();
  store = await openStore();
  unsubs = [
    store.subscribe('songs', (d) => { state.songs = d; onData(); }),
    store.subscribe('setlists', (d) => { state.setlists = d; onData(); }),
  ];
  render();
}

window.addEventListener('online', onData);
window.addEventListener('offline', onData);

restart().catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<div class="empty">No se pudo abrir la base de datos de este navegador.<br><span class="small">${esc(e.message || e)}</span></div>`;
});

// Service worker: funciona sin conexión y se actualiza solo.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Nueva versión lista. Se aplicará al reabrir la app.', 4000);
      });
    });
  }).catch(() => {});
}
