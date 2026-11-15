// Importación de PDF: extrae el texto con su posición y reconstruye
// "acordes sobre la letra" como ChordPro editable.

import {
  isChordLine, chordTokens, isChord, isSectionHeader, extractMeta, isMetaLine,
} from './chordpro.js';

let pdfjsPromise = null;

export function loadPdfJs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement('script');
    s.src = new URL('../vendor/pdf.min.js', import.meta.url).href;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsPromise = null; reject(new Error('No se pudo cargar el lector de PDF')); };
    document.head.appendChild(s);
  });
  return pdfjsPromise;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function itemsOf(content) {
  return content.items
    .filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: Math.abs(it.height || it.transform[3] || 10),
    }));
}

function groupLines(items) {
  const hs = items.filter((i) => i.str.trim()).map((i) => i.h);
  const tol = Math.max(1.5, median(hs) * 0.45);
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

// Ancho relativo de cada carácter (fuente sans-serif típica), para ubicar
// los acordes sobre la sílaba correcta aunque el PDF use letra proporcional.
let measureCtx = null;
const widthCache = new Map();
function charWidth(ch) {
  if (widthCache.has(ch)) return widthCache.get(ch);
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = '100px Helvetica, Arial, "Liberation Sans", sans-serif';
  }
  const w = measureCtx.measureText(ch).width || 50;
  widthCache.set(ch, w);
  return w;
}

// Construye el texto de la línea y la posición X de cada carácter.
function buildLine(line, charW) {
  let text = '';
  const xs = [];
  let lastEnd = null;
  for (const it of line.items) {
    if (lastEnd !== null) {
      const gap = it.x - lastEnd;
      if (gap > charW * 0.3 && !text.endsWith(' ') && !it.str.startsWith(' ')) {
        const n = Math.max(1, Math.round(gap / charW));
        for (let k = 0; k < n; k++) { text += ' '; xs.push(lastEnd + (gap * k) / n); }
      }
    }
    const ws = [...it.str].map(charWidth);
    const total = ws.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    [...it.str].forEach((ch, k) => {
      text += ch;
      xs.push(it.x + (it.w * acc) / total);
      acc += ws[k];
    });
    lastEnd = it.x + it.w;
  }
  const h = Math.max(...line.items.map((i) => i.h));
  return { text: text.replace(/\s+$/, ''), xs, y: line.y, h, x0: line.items[0].x, end: lastEnd };
}

function splitColumns(items, pageWidth) {
  const mid = pageWidth / 2;
  const lines = groupLines(items);
  let both = 0; let right = 0; let left = 0;
  for (const l of lines) {
    const real = l.items.filter((i) => i.str.trim());
    if (!real.length) continue;
    const hasL = real.some((i) => i.x < mid - 6 && i.x + i.w < mid + 6);
    const hasR = real.some((i) => i.x >= mid - 6);
    const crosses = real.some((i) => i.x < mid - 6 && i.x + i.w > mid + 20);
    if (crosses) continue;
    if (hasL && hasR) both++;
    else if (hasR) right++;
    else if (hasL) left++;
  }
  const total = both + right + left;
  const twoCols = total > 6 && (both + right) >= Math.max(3, total * 0.25) && left + both > 0 && right + both > 2;
  if (!twoCols) return [items];
  const L = items.filter((i) => i.x < mid - 6);
  const R = items.filter((i) => i.x >= mid - 6);
  return [L, R];
}

function mergeByX(chordLine, lyric, charW) {
  let text = lyric.text;
  const xs = [...lyric.xs];
  const toks = chordTokens(chordLine.text)
    .map((t) => ({ ...t, x: chordLine.xs[t.col] }))
    .filter((t) => isChord(t.text.replace(/^[(\[]+|[)\],]+$/g, '')));
  toks.sort((a, b) => b.x - a.x);
  for (const t of toks) {
    // El acorde va justo antes del primer carácter que empieza en su posición (o después).
    let pos = xs.findIndex((x) => x >= t.x - charW * 0.35);
    if (pos < 0 || t.x > (lyric.end ?? 0) + charW * 0.5) {
      const pad = Math.max(1, Math.round((t.x - lyric.end) / charW));
      text = text + ' '.repeat(pad);
      for (let k = 0; k < pad; k++) xs.push(lyric.end + k * charW);
      pos = text.length;
    }
    text = text.slice(0, pos) + '[' + t.text + ']' + text.slice(pos);
    xs.splice(pos, 0, ...new Array(t.text.length + 2).fill(t.x));
  }
  return text.replace(/\s+$/, '');
}

const JUNK = [/^(page|página|pag\.?)\s*\d+(\s*(of|de)\s*\d+)?$/i, /chartbuilder/i, /multitracks\.com/i, /^\d+\s*\/\s*\d+$/];

export async function importPdf(file) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  const allLines = [];
  let allText = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const items = itemsOf(await page.getTextContent());
    if (!items.length) continue;
    for (const colItems of splitColumns(items, vp.width)) {
      const real = colItems.filter((i) => i.str.trim() && i.w > 0);
      const charW = median(real.map((i) => i.w / i.str.length)) || 5;
      const lines = groupLines(colItems).map((l) => buildLine(l, charW)).filter((l) => l.text.trim());
      for (const l of lines) { l.charW = charW; l.page = p; }
      allLines.push(...lines);
      if (allLines.length) allLines.push({ text: '', blank: true });
    }
  }
  allText = allLines.map((l) => l.text).join('\n');

  if (!allLines.some((l) => l.text.trim())) {
    return { scanned: true, chordpro: '', title: file.name.replace(/\.pdf$/i, ''), artist: '' };
  }

  const meta = extractMeta(allText);

  // Título: la línea más grande cerca del inicio de la primera página.
  const firstPage = allLines.filter((l) => l.page === 1 && l.text.trim()).slice(0, 8);
  let title = '';
  let artist = '';
  const skip = new Set();
  if (firstPage.length) {
    const maxH = Math.max(...firstPage.map((l) => l.h));
    const tLine = firstPage.find((l) => l.h === maxH && !isChordLine(l.text) && !isSectionHeader(l.text));
    if (tLine) {
      title = tLine.text.trim().replace(/\s{2,}/g, ' ');
      skip.add(tLine);
      const after = firstPage[firstPage.indexOf(tLine) + 1];
      if (after && !isChordLine(after.text) && !isSectionHeader(after.text) && !isMetaLine(after.text)
        && after.text.trim().length < 60 && after.h <= tLine.h) {
        artist = after.text.trim().replace(/\s{2,}/g, ' ');
        skip.add(after);
      }
    }
  }

  const out = [];
  for (let i = 0; i < allLines.length; i++) {
    const l = allLines[i];
    if (skip.has(l)) continue;
    if (l.blank) { out.push(''); continue; }
    const t = l.text.replace(/\s*\b(page|página|pag\.?)\s*\d+\s*((of|de)\s*\d+)?\s*$/i, '');
    if (!t.trim()) continue;
    if (JUNK.some((re) => re.test(t.trim()))) continue;
    if (isMetaLine(t)) continue;
    if (isSectionHeader(t)) { out.push('', `{c: ${t.trim().replace(/:\s*$/, '')}}`); continue; }
    if (/^\s*(©|\(c\)|ccli|copyright)/i.test(t)) { out.push(`{c: ${t.trim()}}`); continue; }
    if (isChordLine(t)) {
      const next = allLines[i + 1];
      const close = next && !next.blank && next.page === l.page && (l.y - next.y) < Math.max(l.h, next.h) * 2.6;
      if (close && !isChordLine(next.text) && !isSectionHeader(next.text) && !skip.has(next)) {
        out.push(mergeByX(l, next, l.charW));
        i++;
      } else {
        out.push(chordTokens(t).map((tk) => (isChord(tk.text.replace(/^[(\[]+|[)\],]+$/g, '')) ? `[${tk.text}]` : tk.text)).join(' '));
      }
      continue;
    }
    // Línea con sección + acordes en la misma línea, p. ej. "Intro: G D Em C"
    const sec = /^\s*([^:]{2,24}):\s+(.+)$/.exec(t);
    if (sec && isSectionHeader(sec[1]) && isChordLine(sec[2])) {
      out.push('', `{c: ${sec[1].trim()}}`);
      out.push(chordTokens(sec[2]).map((tk) => (isChord(tk.text.replace(/^[(\[]+|[)\],]+$/g, '')) ? `[${tk.text}]` : tk.text)).join(' '));
      continue;
    }
    out.push(t);
  }

  const chordpro = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { scanned: false, chordpro, title, artist, ...meta, rawText: allText };
}

// Dibuja las páginas de un PDF dentro de un contenedor.
export async function renderPdf(blob, container) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  container.innerHTML = '';
  const width = Math.min(container.clientWidth || 800, 1100);
  const ratio = window.devicePixelRatio || 1;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = '100%';
    canvas.className = 'pdf-page';
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}
