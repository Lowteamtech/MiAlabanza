// MIDI: monitor y modo "Seguir a Playback".
// Solo funciona en navegadores con Web MIDI (Chrome o Edge en Mac/PC). Safari no lo tiene.
//
// Lo que manda Playback por la pista "Letras" (convención de ProPresenter):
//   Nota 17 → lista, Nota 18 → canción dentro de la lista, Nota 19 → diapositiva (velocidad = número).
//   Además: Start / Stop y reloj MIDI (24 pulsos por negra).

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 2}`; // 60 = C3 (convención de ProPresenter/Logic)

export const NOTE_PLAYLIST = 17;
export const NOTE_SONG = 18;
export const NOTE_SLIDE = 19;

export function midiSupported() {
  return typeof navigator.requestMIDIAccess === 'function';
}

export function describe(data) {
  const [st, d1 = 0, d2 = 0] = data;
  const type = st & 0xf0;
  const ch = (st & 0x0f) + 1;
  switch (type) {
    case 0x80: return `Nota OFF  ${noteName(d1)} (#${d1})  vel ${d2}  · canal ${ch}`;
    case 0x90: return d2 === 0
      ? `Nota OFF  ${noteName(d1)} (#${d1})  · canal ${ch}`
      : `Nota ON   ${noteName(d1)} (#${d1})  vel ${d2}  · canal ${ch}`;
    case 0xa0: return `Aftertouch nota #${d1} = ${d2} · canal ${ch}`;
    case 0xb0: return `Control Change (CC) #${d1} = ${d2}  · canal ${ch}`;
    case 0xc0: return `Program Change  ${d1}  · canal ${ch}`;
    case 0xd0: return `Channel pressure ${d1} · canal ${ch}`;
    case 0xe0: return `Pitch bend ${(d2 << 7) | d1} · canal ${ch}`;
    default: break;
  }
  switch (st) {
    case 0xf0: return `SysEx (${data.length} bytes)`;
    case 0xf2: return `Song Position: tiempo ${((d2 << 7) | d1) / 4}`;
    case 0xf3: return `Song Select ${d1}`;
    case 0xfa: return '▶ Start';
    case 0xfb: return '▶ Continue';
    case 0xfc: return '■ Stop';
    default: return [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }
}

// ---- Acceso compartido: varios oyentes a la vez (monitor + director) ----

let accessPromise = null;
const listeners = new Set();
const portListeners = new Set();
let portNames = [];

function dispatch(input, e) {
  for (const fn of listeners) {
    try { fn(input, e); } catch (err) { console.error(err); }
  }
}

async function ensureAccess() {
  if (!accessPromise) {
    accessPromise = navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      const attach = () => {
        portNames = [];
        access.inputs.forEach((input) => {
          portNames.push(input.name);
          if (!input.__mialabanza) {
            input.__mialabanza = true;
            input.addEventListener('midimessage', (e) => dispatch(input, e));
            input.open?.().catch(() => {});
          }
        });
        portListeners.forEach((fn) => fn(portNames));
      };
      attach();
      access.addEventListener('statechange', attach);
      return access;
    }).catch((err) => { accessPromise = null; throw err; });
  }
  return accessPromise;
}

function subscribe(fn, onPorts) {
  listeners.add(fn);
  if (onPorts) { portListeners.add(onPorts); onPorts(portNames); }
  return () => { listeners.delete(fn); if (onPorts) portListeners.delete(onPorts); };
}

function clockMeter(onClock) {
  const ticks = [];
  let last = 0;
  return (stamp, st) => {
    if (st === 0xfc || st === 0xfa) { ticks.length = 0; return; }
    ticks.push(stamp);
    if (ticks.length > 97) ticks.shift();
    if (ticks.length > 24 && stamp - last > 500) {
      last = stamp;
      const span = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
      onClock(Math.round((60000 / (span * 24)) * 10) / 10);
    }
  };
}

// Monitor: registra todo (menos el reloj, que se resume en BPM).
export async function startMonitor({ onMessage, onClock, onPorts }) {
  await ensureAccess();
  const clock = clockMeter((bpm) => onClock?.(bpm));
  return subscribe((input, e) => {
    const st = e.data[0];
    if (st === 0xfe) return;
    if (st === 0xf8) { clock(e.timeStamp || performance.now(), st); return; }
    if (st === 0xfa || st === 0xfc) clock(0, st);
    onMessage?.({ input: input.name, data: [...e.data], text: describe(e.data), time: new Date() });
  }, onPorts);
}

// Director: traduce lo que manda Playback a eventos simples.
export async function startDirector({ onSlide, onSong, onPlaylist, onStart, onStop, onClock, onPorts }) {
  await ensureAccess();
  const clock = clockMeter((bpm) => onClock?.(bpm));
  return subscribe((input, e) => {
    const [st, d1, d2] = e.data;
    if (st === 0xf8) { clock(e.timeStamp || performance.now(), st); return; }
    if (st === 0xfa || st === 0xfb) { clock(0, st); onStart?.(); return; }
    if (st === 0xfc) { clock(0, st); onStop?.(); return; }
    if ((st & 0xf0) === 0x90 && d2 > 0) {
      if (d1 === NOTE_SLIDE) onSlide?.(d2);
      else if (d1 === NOTE_SONG) onSong?.(d2);
      else if (d1 === NOTE_PLAYLIST) onPlaylist?.(d2);
    }
  }, onPorts);
}
