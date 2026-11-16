// Monitor MIDI: muestra lo que llega por MIDI (p. ej., desde Playback por el IAC Driver).
// Solo funciona en navegadores con Web MIDI (Chrome o Edge en Mac/PC). Safari no lo tiene.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 2}`; // 60 = C3 (convención de ProPresenter/Logic)

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

// Abre el acceso MIDI y llama a onMessage({input, data, text, time}) por cada mensaje útil.
// El reloj MIDI (24 pulsos por negra) no se registra uno a uno: se resume en onClock(bpm).
export async function startMonitor({ onMessage, onClock, onPorts }) {
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const ticks = [];
  let lastClockReport = 0;

  const attach = () => {
    const names = [];
    access.inputs.forEach((input) => {
      names.push(input.name);
      input.onmidimessage = (e) => {
        const data = e.data;
        const st = data[0];
        if (st === 0xfe) return; // active sensing
        if (st === 0xf8) {
          const now = e.timeStamp || performance.now();
          ticks.push(now);
          if (ticks.length > 97) ticks.shift();
          if (ticks.length > 24 && now - lastClockReport > 500) {
            lastClockReport = now;
            const span = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
            onClock?.(Math.round((60000 / (span * 24)) * 10) / 10);
          }
          return;
        }
        if (st === 0xfc) ticks.length = 0;
        onMessage?.({ input: input.name, data: [...data], text: describe(data), time: new Date() });
      };
    });
    onPorts?.(names);
  };
  attach();
  access.onstatechange = attach;
  return () => {
    access.inputs.forEach((i) => { i.onmidimessage = null; });
    access.onstatechange = null;
  };
}
