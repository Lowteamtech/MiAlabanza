// Motor de cifrados: lectura de ChordPro, transposición, notación latina
// y conversión de "acordes sobre la letra" a ChordPro.

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LATIN = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const LATIN_IN = { do: 'C', re: 'D', mi: 'E', fa: 'F', sol: 'G', la: 'A', si: 'B' };

// Tonalidades que se escriben con bemoles.
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
  'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);

export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const ROOT = '(?:[A-G]|Do|Re|Mi|Fa|Sol|La|Si)';
const ACC = '(?:#|b|♯|♭)?';
const SUFFIX = "(?:maj|min|m|M|dim|aug|sus|add|º|°|ø|\\+|-|\\d|\\(|\\)|b|#|♯|♭|no|omit|alt|\\^)*";
const CHORD_RE = new RegExp(`^(${ROOT})(${ACC})(${SUFFIX})(?:/(${ROOT})(${ACC}))?$`);

function normAcc(a) {
  if (a === '♯') return '#';
  if (a === '♭') return 'b';
  return a || '';
}

function rootToLetter(r) {
  if (r.length === 1) return r;
  return LATIN_IN[r.toLowerCase()] || r;
}

export function parseChord(str) {
  const m = CHORD_RE.exec(str.trim());
  if (!m) return null;
  return {
    root: rootToLetter(m[1]) + normAcc(m[2]),
    suffix: m[3] || '',
    bass: m[4] ? rootToLetter(m[4]) + normAcc(m[5]) : null,
  };
}

export function isChord(str) {
  return !!str && parseChord(str) !== null;
}

function noteIndex(note) {
  let i = SHARPS.indexOf(note);
  if (i < 0) i = FLATS.indexOf(note);
  if (i < 0) {
    // Casos raros: E#, B#, Fb, Cb
    const map = { 'E#': 5, 'B#': 0, Fb: 4, Cb: 11 };
    i = map[note] ?? -1;
  }
  return i;
}

export function semitonesBetween(fromKey, toKey) {
  const a = parseChord(fromKey || '');
  const b = parseChord(toKey || '');
  if (!a || !b) return 0;
  const d = noteIndex(b.root) - noteIndex(a.root);
  return ((d % 12) + 12) % 12;
}

export function transposeKey(key, semis) {
  if (!key) return key;
  const c = parseChord(key);
  if (!c) return key;
  const minor = /^m(?!aj)/.test(c.suffix);
  const idx = (noteIndex(c.root) + semis + 120) % 12;
  // Elegir la grafía de la nueva tonalidad: preferir la de KEYS.
  const name = minor ? (FLAT_KEYS.has(FLATS[idx] + 'm') ? FLATS[idx] : SHARPS[idx]) : KEYS[idx];
  return name + c.suffix;
}

export function useFlatsFor(key) {
  if (!key) return false;
  const c = parseChord(key);
  if (!c) return false;
  const minor = /^m(?!aj)/.test(c.suffix);
  if (c.root.includes('b')) return true;
  if (c.root.includes('#')) return false;
  return FLAT_KEYS.has(c.root + (minor ? 'm' : ''));
}

function shiftNote(note, semis, flats) {
  const i = noteIndex(note);
  if (i < 0) return note;
  const j = (i + semis + 120) % 12;
  return (flats ? FLATS : SHARPS)[j];
}

function toLatin(note) {
  const letter = note[0];
  return (LATIN[letter] || letter) + note.slice(1);
}

// Transpone y formatea un acorde. notation: 'en' (C D E) o 'es' (Do Re Mi)
export function formatChord(str, semis = 0, flats = false, notation = 'en') {
  const c = parseChord(str);
  if (!c) return str;
  let root = semis ? shiftNote(c.root, semis, flats) : c.root;
  let bass = c.bass ? (semis ? shiftNote(c.bass, semis, flats) : c.bass) : null;
  if (notation === 'es') {
    root = toLatin(root);
    if (bass) bass = toLatin(bass);
  }
  return root + c.suffix + (bass ? '/' + bass : '');
}

// ---------- Secciones ----------

const SECTION_WORDS = [
  'intro', 'introducción', 'introduccion', 'verso', 'verse', 'estrofa', 'coro', 'chorus',
  'pre-coro', 'precoro', 'pre coro', 'pre-chorus', 'prechorus', 'pre chorus', 'puente', 'bridge',
  'interludio', 'interlude', 'instrumental', 'solo', 'tag', 'final', 'outro', 'ending', 'vamp',
  'turnaround', 'turn', 'refrain', 'estribillo', 'post-coro', 'postcoro', 'post-chorus', 'break',
  'riff', 'channel', 'canal', 'exhortación', 'exhortacion', 'espontáneo', 'espontaneo',
];
const SECTION_RE = new RegExp(
  `^\\s*\\[?\\(?(${SECTION_WORDS.map((w) => w.replace(/[-]/g, '\\-')).join('|')})\\b[\\s\\d\\w.()x×-]{0,14}\\)?\\]?\\s*:?\\s*$`,
  'i',
);

export function isSectionHeader(line) {
  const t = line.trim();
  if (!t || t.length > 32) return false;
  return SECTION_RE.test(t);
}

const SECTION_ABBR = [
  [/^intro/i, 'I'], [/^(pre[\s-]?coro|pre[\s-]?chorus)/i, 'PC'], [/^(coro|chorus|estribillo|refrain)/i, 'C'],
  [/^(verso|verse|estrofa)/i, 'V'], [/^(puente|bridge)/i, 'P'], [/^(interludio|interlude|instrumental|solo|riff|turn)/i, 'Int'],
  [/^(tag)/i, 'Tag'], [/^(final|outro|ending)/i, 'F'], [/^vamp/i, 'Vamp'], [/^(post)/i, 'Post'],
];

export function sectionShort(label) {
  const t = label.trim().replace(/:$/, '');
  for (const [re, ab] of SECTION_ABBR) {
    if (re.test(t)) {
      const rep = (t.match(/[x×]\s*\d+/i) || [''])[0].replace(/\s/g, '');
      const num = (t.replace(/[x×]\s*\d+/i, '').match(/\d+/) || [''])[0];
      return ab + num + (rep ? ' ' + rep : '');
    }
  }
  return t.length > 8 ? t.slice(0, 8) + '…' : t;
}

// ---------- Lectura de ChordPro ----------

// Devuelve { meta, blocks } donde blocks es una lista de
// { type: 'section', label } | { type: 'line', segments:[{chord,text}] } |
// { type: 'comment', text } | { type: 'tab', text } | { type: 'space' }
export function parseChordPro(src) {
  const meta = {};
  const blocks = [];
  let inTab = false;
  const lines = (src || '').replace(/\r\n?/g, '\n').split('\n');

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const dir = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/.exec(line);
    if (dir) {
      const name = dir[1].toLowerCase();
      const val = (dir[2] || '').trim();
      switch (name) {
        case 't': case 'title': meta.title = val; break;
        case 'st': case 'subtitle': case 'artist': meta.artist = val; break;
        case 'key': meta.key = val; break;
        case 'tempo': case 'bpm': meta.bpm = val; break;
        case 'time': meta.time = val; break;
        case 'capo': meta.capo = val; break;
        case 'c': case 'comment': case 'ci': case 'comment_italic': case 'cb': case 'comment_box':
          if (isSectionHeader(val)) blocks.push({ type: 'section', label: val.replace(/:\s*$/, '') });
          else blocks.push({ type: 'comment', text: val });
          break;
        case 'soc': case 'start_of_chorus': blocks.push({ type: 'section', label: val || 'Coro' }); break;
        case 'sov': case 'start_of_verse': blocks.push({ type: 'section', label: val || 'Verso' }); break;
        case 'sob': case 'start_of_bridge': blocks.push({ type: 'section', label: val || 'Puente' }); break;
        case 'sot': case 'start_of_tab': inTab = true; if (val) blocks.push({ type: 'section', label: val }); break;
        case 'eot': case 'end_of_tab': inTab = false; break;
        default: break; // eoc, eov, eob y otras directivas: se ignoran
      }
      continue;
    }
    if (inTab) { blocks.push({ type: 'tab', text: line }); continue; }
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].type !== 'space') blocks.push({ type: 'space' });
      continue;
    }
    if (/^\s*#/.test(line)) continue; // comentario ChordPro
    if (isSectionHeader(line) && !line.includes('[')) {
      blocks.push({ type: 'section', label: line.trim().replace(/:\s*$/, '') });
      continue;
    }
    blocks.push({ type: 'line', segments: splitSegments(line) });
  }
  while (blocks.length && blocks[blocks.length - 1].type === 'space') blocks.pop();
  return { meta, blocks };
}

function splitSegments(line) {
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let pending = null;
  let m;
  while ((m = re.exec(line))) {
    const text = line.slice(last, m.index);
    if (pending !== null || text) segs.push({ chord: pending, text });
    pending = m[1];
    last = re.lastIndex;
  }
  const tail = line.slice(last);
  if (pending !== null || tail) segs.push({ chord: pending, text: tail });
  return segs;
}

export function sectionsOf(src) {
  return parseChordPro(src).blocks.filter((b) => b.type === 'section').map((b) => b.label);
}

// Lista de acordes distintos (para vista rápida)
export function chordsOf(src) {
  const set = [];
  for (const b of parseChordPro(src).blocks) {
    if (b.type !== 'line') continue;
    for (const s of b.segments) if (s.chord && isChord(s.chord) && !set.includes(s.chord)) set.push(s.chord);
  }
  return set;
}

// Intenta deducir la tonalidad a partir del primer/último acorde.
export function guessKey(src) {
  const all = [];
  for (const b of parseChordPro(src).blocks) {
    if (b.type !== 'line') continue;
    for (const s of b.segments) if (s.chord && isChord(s.chord)) all.push(s.chord);
  }
  if (!all.length) return '';
  const c = parseChord(all[0]);
  const minor = /^m(?!aj)/.test(c.suffix);
  return c.root + (minor ? 'm' : '');
}

// ---------- Acordes sobre la letra -> ChordPro ----------

const BAR_TOKENS = /^(\||\|\||\|:|:\||-|–|\/|%|x\d+|×\d+|\(x\d+\)|\(×\d+\)|\d+x|n\.?c\.?|\.\.\.|\(|\))$/i;

export function chordTokens(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) out.push({ text: m[0], col: m.index });
  return out;
}

export function isChordLine(line) {
  if (!line || !line.trim()) return false;
  const toks = chordTokens(line);
  let chords = 0;
  for (const t of toks) {
    const clean = t.text.replace(/^[(\[]+|[)\],]+$/g, '');
    if (isChord(clean)) chords++;
    else if (!BAR_TOKENS.test(t.text)) return false;
  }
  return chords > 0;
}

// Inserta acordes (con su columna) dentro de una línea de letra.
export function mergeChordsIntoLyric(chords, lyric) {
  let out = lyric;
  const sorted = [...chords].sort((a, b) => b.col - a.col);
  for (const c of sorted) {
    if (c.col > out.length) out = out.padEnd(c.col, ' ');
    out = out.slice(0, c.col) + '[' + c.text + ']' + out.slice(c.col);
  }
  return out.replace(/\s+$/, '');
}

function chordOnlyLine(line) {
  return chordTokens(line).map((t) => {
    const clean = t.text.replace(/^[(\[]+|[)\],]+$/g, '');
    return isChord(clean) ? `[${t.text}]` : t.text;
  }).join(' ');
}

// Convierte texto con acordes sobre la letra (monoespaciado) a ChordPro.
export function textToChordPro(text) {
  const lines = (text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\[[^\]]+\]/.test(line) || /^\s*\{.*\}\s*$/.test(line)) { out.push(line); continue; }
    if (isSectionHeader(line)) { out.push(`{c: ${line.trim().replace(/:\s*$/, '')}}`); continue; }
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && !isChordLine(next) && !isSectionHeader(next)) {
        const chords = chordTokens(line).filter((t) => isChord(t.text.replace(/^[(\[]+|[)\],]+$/g, '')));
        out.push(mergeChordsIntoLyric(chords, next));
        i++;
      } else {
        out.push(chordOnlyLine(line));
      }
      continue;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Detecta metadatos en texto suelto (Key: G, Tempo 72, Time 4/4, etc.)
export function extractMeta(text) {
  const meta = {};
  const key = /(?:\bkey|\btono|\btonalidad)\s*[-:=]?\s*([A-G](?:#|b)?m?)\b/i.exec(text);
  if (key) meta.key = key[1][0].toUpperCase() + key[1].slice(1);
  const bpm = /(?:\btempo|\bbpm)\s*[-:=]?\s*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/i.exec(text);
  if (bpm) meta.bpm = bpm[1] || bpm[2];
  const time = /(?:\btime|\bcompás|\bcompas|\bmétrica|\bmetrica)\s*(?:signature)?\s*[-:=]?\s*(\d{1,2}\/\d{1,2})/i.exec(text);
  if (time) meta.time = time[1];
  return meta;
}

export function isMetaLine(line) {
  const t = line.trim();
  if (!t) return false;
  const stripped = t
    .replace(/(?:key|tono|tonalidad)\s*[-:=]?\s*[A-G](?:#|b)?m?\b/ig, '')
    .replace(/(?:tempo|bpm)\s*[-:=]?\s*\d{2,3}/ig, '')
    .replace(/\d{2,3}\s*bpm/ig, '')
    .replace(/(?:time|compás|compas|métrica|metrica)\s*(?:signature)?\s*[-:=]?\s*\d{1,2}\/\d{1,2}/ig, '')
    .replace(/[|·•,;\-–\s]/g, '');
  return stripped.length === 0 && t.length > 0 && Object.keys(extractMeta(t)).length > 0;
}
