// Almacenamiento: local (IndexedDB) o en la nube (Firebase Firestore con caché sin conexión).
// Ambos exponen la misma interfaz:
//   subscribe(col, cb) -> unsubscribe   (cb recibe un arreglo con todos los documentos)
//   put(col, doc) / remove(col, id) / all(col)
//   putPdf(id, blob, name) / getPdf(id) -> Blob|null / removePdf(id)

import { FIREBASE_CONFIG } from './config.js';

const COLLECTIONS = ['songs', 'setlists'];
const PDF_CHUNK = 900000; // caracteres base64 por documento (límite Firestore: 1 MiB)

// ---------------- Local ----------------

class LocalStore {
  constructor() {
    this.mode = 'local';
    this.listeners = {};
    this.cache = {};
    this.channel = 'BroadcastChannel' in self ? new BroadcastChannel('repertorio-sync') : null;
    if (this.channel) this.channel.onmessage = (e) => this._reload(e.data);
  }

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('repertorio', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const c of [...COLLECTIONS, 'pdfs']) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (const c of COLLECTIONS) this.cache[c] = await this._getAll(c);
  }

  _tx(col, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(col, mode);
      const st = tx.objectStore(col);
      let result;
      const r = fn(st);
      if (r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  _getAll(col) { return this._tx(col, 'readonly', (st) => st.getAll()); }

  async _reload(col) {
    if (!COLLECTIONS.includes(col)) return;
    this.cache[col] = await this._getAll(col);
    this._emit(col);
  }

  _emit(col) {
    for (const cb of this.listeners[col] || []) cb(this.cache[col]);
  }

  subscribe(col, cb) {
    (this.listeners[col] ||= []).push(cb);
    cb(this.cache[col] || []);
    return () => { this.listeners[col] = this.listeners[col].filter((x) => x !== cb); };
  }

  all(col) { return this.cache[col] || []; }

  async put(col, doc) {
    await this._tx(col, 'readwrite', (st) => st.put(doc));
    await this._reload(col);
    this.channel?.postMessage(col);
  }

  async remove(col, id) {
    await this._tx(col, 'readwrite', (st) => st.delete(id));
    await this._reload(col);
    this.channel?.postMessage(col);
  }

  async putPdf(id, blob, name) {
    await this._tx('pdfs', 'readwrite', (st) => st.put({ id, blob, name }));
  }

  async getPdf(id) {
    const r = await this._tx('pdfs', 'readonly', (st) => st.get(id));
    return r ? r.blob : null;
  }

  async removePdf(id) { await this._tx('pdfs', 'readwrite', (st) => st.delete(id)); }

  async allPdfs() { return this._tx('pdfs', 'readonly', (st) => st.getAll()); }

  status() { return { mode: 'local', label: 'Solo este dispositivo' }; }
}

// ---------------- Nube (Firebase) ----------------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type = 'application/pdf') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

class CloudStore {
  constructor(fb) {
    this.mode = 'cloud';
    this.fb = fb;
    this.cache = {};
    this.listeners = {};
    this.unsubs = [];
    this.online = navigator.onLine;
    this.pending = false;
  }

  async init(user) {
    const { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } = this.fb;
    this.user = user;
    if (!CloudStore.db) {
      CloudStore.db = initializeFirestore(this.fb.app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    }
    this.db = CloudStore.db;
    await Promise.all(COLLECTIONS.map((c) => new Promise((resolve) => {
      let first = true;
      const un = this.fb.onSnapshot(this.fb.collection(this.db, c), { includeMetadataChanges: true }, (snap) => {
        this.cache[c] = snap.docs.map((d) => d.data());
        this.pending = snap.metadata.hasPendingWrites;
        this.fromCache = snap.metadata.fromCache;
        this._emit(c);
        if (first) { first = false; resolve(); }
      }, (err) => {
        console.error('Firestore', err);
        this.error = err.code || String(err);
        if (first) { first = false; this.cache[c] = []; resolve(); }
      });
      this.unsubs.push(un);
    })));
  }

  _emit(col) { for (const cb of this.listeners[col] || []) cb(this.cache[col] || []); }

  subscribe(col, cb) {
    (this.listeners[col] ||= []).push(cb);
    cb(this.cache[col] || []);
    return () => { this.listeners[col] = this.listeners[col].filter((x) => x !== cb); };
  }

  all(col) { return this.cache[col] || []; }

  // Las escrituras se confirman localmente al instante; Firestore las sube cuando hay señal.
  put(col, doc) {
    const clean = JSON.parse(JSON.stringify(doc));
    this.fb.setDoc(this.fb.doc(this.db, col, doc.id), clean).catch((e) => console.error('put', e));
    return Promise.resolve();
  }

  remove(col, id) {
    this.fb.deleteDoc(this.fb.doc(this.db, col, id)).catch((e) => console.error('remove', e));
    return Promise.resolve();
  }

  async putPdf(id, blob, name) {
    const b64 = await blobToBase64(blob);
    const n = Math.ceil(b64.length / PDF_CHUNK) || 1;
    const batch = this.fb.writeBatch(this.db);
    batch.set(this.fb.doc(this.db, 'pdfs', id), { id, name: name || '', chunks: n, type: blob.type || 'application/pdf' });
    for (let i = 0; i < n; i++) {
      batch.set(this.fb.doc(this.db, 'pdfchunks', `${id}_${i}`), { data: b64.slice(i * PDF_CHUNK, (i + 1) * PDF_CHUNK) });
    }
    batch.commit().catch((e) => console.error('pdf', e));
  }

  async getPdf(id) {
    try {
      const meta = await this.fb.getDoc(this.fb.doc(this.db, 'pdfs', id));
      if (!meta.exists()) return null;
      const { chunks, type } = meta.data();
      const parts = [];
      for (let i = 0; i < chunks; i++) {
        const c = await this.fb.getDoc(this.fb.doc(this.db, 'pdfchunks', `${id}_${i}`));
        if (!c.exists()) return null;
        parts.push(c.data().data);
      }
      return base64ToBlob(parts.join(''), type);
    } catch (e) {
      console.error('getPdf', e);
      return null;
    }
  }

  async removePdf(id) {
    try {
      const meta = await this.fb.getDoc(this.fb.doc(this.db, 'pdfs', id));
      const n = meta.exists() ? meta.data().chunks : 0;
      const batch = this.fb.writeBatch(this.db);
      batch.delete(this.fb.doc(this.db, 'pdfs', id));
      for (let i = 0; i < n; i++) batch.delete(this.fb.doc(this.db, 'pdfchunks', `${id}_${i}`));
      await batch.commit();
    } catch (e) { console.error('removePdf', e); }
  }

  status() {
    if (this.error) return { mode: 'cloud', label: 'Error de sincronización: ' + this.error, warn: true };
    if (!navigator.onLine) return { mode: 'cloud', label: 'Sin señal: los cambios se suben al volver', warn: true };
    if (this.pending) return { mode: 'cloud', label: 'Subiendo cambios…' };
    return { mode: 'cloud', label: 'Sincronizado con el equipo' };
  }

  dispose() { this.unsubs.forEach((u) => u()); }
}

// ---------------- Arranque ----------------

let fbModule = null;

export function cloudConfigured() {
  return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

async function loadFirebase() {
  if (fbModule) return fbModule;
  const m = await import('../vendor/firebase.js');
  const app = m.initializeApp(FIREBASE_CONFIG);
  const auth = m.getAuth(app);
  fbModule = { ...m, app, auth };
  return fbModule;
}

// Espera el usuario guardado (funciona sin conexión).
export async function currentTeamUser() {
  if (!cloudConfigured()) return null;
  const fb = await loadFirebase();
  return new Promise((resolve) => {
    const un = fb.onAuthStateChanged(fb.auth, (u) => { un(); resolve(u); });
  });
}

export async function teamLogin(email, password) {
  const fb = await loadFirebase();
  const cred = await fb.signInWithEmailAndPassword(fb.auth, email, password);
  return cred.user;
}

export async function teamLogout() {
  const fb = await loadFirebase();
  await fb.signOut(fb.auth);
}

export async function openStore() {
  const local = new LocalStore();
  await local.init();
  if (cloudConfigured()) {
    try {
      const user = await currentTeamUser();
      if (user) {
        const cloud = new CloudStore(fbModule);
        await cloud.init(user);
        cloud.local = local;
        return cloud;
      }
    } catch (e) {
      console.error('No se pudo abrir la nube', e);
    }
  }
  return local;
}

export { LocalStore };
