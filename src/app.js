/* ===== FuntimoID — interface ===== */
(() => {
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const hexToRgb = (c) => {
  const cv = document.createElement('canvas').getContext('2d'); cv.fillStyle = c; const s = cv.fillStyle;
  if (s.startsWith('#')) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const m = s.match(/\d+/g); return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
};
const fmt = (n, d = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const DPR = Math.min(2, window.devicePixelRatio || 1);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- movimento: molas interrompíveis e caminhos simétricos ---------- */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** valor com mola: muda de alvo a qualquer momento sem salto, levando a velocidade junto.
 *  response em segundos (quão rápido chega), damping 1 = sem ultrapassar. */
function springValue(initial, onUpdate, { response = 0.35, damping = 1 } = {}) {
  let x = initial, v = 0, target = initial, raf = 0, last = 0;
  const k = (2 * Math.PI / response) ** 2, c = 4 * Math.PI * damping / response;
  const step = (t) => {
    const dt = Math.min(0.032, (t - last) / 1000 || 0.016); last = t;
    for (let i = 0; i < 4; i++) { const h = dt / 4; v += (-k * (x - target) - c * v) * h; x += v * h; }
    if (Math.abs(x - target) < 0.05 && Math.abs(v) < 0.05) { x = target; v = 0; onUpdate(x); raf = 0; return; }
    onUpdate(x); raf = requestAnimationFrame(step);
  };
  return {
    to(t, jump) {
      target = t;
      if (jump || reduceMotion()) { cancelAnimationFrame(raf); raf = 0; x = t; v = 0; onUpdate(x); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
    },
    get value() { return x; },
  };
}
let toastT, toastAnim;
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; clearTimeout(toastT);
  if (toastAnim) toastAnim.cancel();
  const wasHidden = t.hidden; t.hidden = false;
  if (wasHidden && !reduceMotion()) t.animate([{ opacity: 0, transform: 'translateY(14px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
  toastT = setTimeout(() => {
    if (reduceMotion()) { t.hidden = true; return; }
    // sai pelo mesmo caminho por onde entrou
    toastAnim = t.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(14px) scale(0.98)' }], { duration: 240, easing: 'cubic-bezier(0.64, 0, 0.78, 0)' });
    toastAnim.onfinish = () => { t.hidden = true; toastAnim = null; };
  }, ms);
}

/* ---------- estado ---------- */
const S = {
  img: null, disp: null, dispScale: 1,
  roi: null,
  p: { up: 1, mode: 'lum', ink: [200, 40, 90], pol: 'auto', method: 'multi', win: 60, k: 0.25, thr: 128, close: 0, min: 4, vl: 0, hl: 0, levels: 4 },
  tool: 'caixas', brush: 16, edits: [], hover: null,
  proc: null,
  boxes: [], sel: -1,
  picking: false,
  dest: 'sample',
  glyphs: [], temp: [], builtin: [], fams: [], famGroups: [],
  kindFilter: 'all', search: '',
  cmp: { results: null, row: -1, match: -1, ov: { dx: 0, dy: 0, sc: 100, g: 0, mode: 'cores' } },
};
const maskCache = new Map();
function maskOf(g) {
  if (g.mask) return g.mask;
  let m = maskCache.get(g.id);
  if (!m) { m = Core.unpackMask(g.w, g.h, g.bits); maskCache.set(g.id, m); }
  return m;
}
const groupKey = (g) => g.kind === 'sample' ? `${g.artefact || 'Sem artefato'} · Tipo ${g.typeNo || '?'}` : `${g.catalog || 'Sem catálogo'} · ${g.family || 'Sem família'}${g.style ? ' · ' + g.style : ''}`;
const allGlyphs = () => S.glyphs.concat(S.temp);
const TEMP_KEY = 'Recorte atual (não salvo)';

/* ---------- armazenamento ---------- */
const Store = {
  mode: 'local', col: null,
  async init() {
    let db = null;
    try { if (window.claude && window.claude.use) db = await window.claude.use('db'); } catch (e) { db = null; }
    if (db) {
      this.mode = 'db'; this.col = db.collection('glyphs');
      setPill('db');
      this.col.onSnapshot((snap) => {
        S.glyphs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        onGlyphs();
      }, (err) => { toast('O acervo compartilhado parou de responder. Recarregue a página.'); console.warn(err); });
    } else {
      this.mode = 'local'; setPill('local');
      try { S.glyphs = JSON.parse(localStorage.getItem('bt-glyphs') || '[]'); } catch (e) { S.glyphs = []; }
      onGlyphs();
    }
  },
  persistLocal() { try { localStorage.setItem('bt-glyphs', JSON.stringify(S.glyphs)); } catch (e) { toast('Este navegador não deixou salvar localmente.'); } },
  async addMany(docs) {
    if (this.mode === 'db') {
      let i = 0, failed = 0;
      const worker = async () => {
        while (i < docs.length) {
          const d = docs[i++];
          try { await this.col.doc().set(d); }
          catch (e) {
            if (e && e.code === 'unavailable') { await sleep(300 + Math.random() * 400); try { await this.col.doc().set(d); continue; } catch (e2) { e = e2; } }
            failed++;
            if (e && e.code === 'quota_exceeded') { toast('O acervo atingiu o limite de armazenamento. Exclua grupos antigos para continuar.'); i = docs.length; }
            else if (e && e.code === 'invalid_argument') { toast('Você não tem permissão para gravar neste acervo.'); i = docs.length; }
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return docs.length - failed;
    }
    for (const d of docs) S.glyphs.push({ id: 'l' + Math.random().toString(36).slice(2, 10), ...d });
    this.persistLocal(); onGlyphs(); return docs.length;
  },
  async remove(ids) {
    if (this.mode === 'db') { for (const id of ids) { try { await this.col.doc(id).delete(); } catch (e) { toast('Não foi possível excluir: ' + (e.message || e.code)); break; } } return; }
    const set = new Set(ids); S.glyphs = S.glyphs.filter(g => !set.has(g.id)); this.persistLocal(); onGlyphs();
  },
  async relabel(id, label) {
    if (this.mode === 'db') { try { await this.col.doc(id).update({ label }); } catch (e) { toast('Não foi possível renomear.'); } return; }
    const g = S.glyphs.find(x => x.id === id); if (g) g.label = label; this.persistLocal(); onGlyphs();
  },
};
function setPill(mode) {
  const p = $('storePill'); p.dataset.mode = mode;
  p.textContent = mode === 'db' ? 'Acervo compartilhado' : 'Acervo neste navegador';
  p.title = mode === 'db' ? 'Os glifos ficam salvos com esta página e aparecem para quem tem acesso a ela.' : 'Sem acervo compartilhado nesta visualização: os glifos ficam só neste navegador.';
}

/* ---------- downloads ---------- */
let dlCap;
async function saveFile(filename, data) {
  if (dlCap === undefined) { try { dlCap = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dlCap = null; } }
  if (dlCap) {
    try { await dlCap.save({ filename, data }); toast('Arquivo pronto: ' + filename); }
    catch (e) { if (e && e.code !== 'declined') toast('Não foi possível salvar o arquivo (' + (e.code || 'erro') + ').'); }
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const canvasBlob = (cv) => new Promise(r => cv.toBlob(r, 'image/png'));

/* ---------- abas ---------- */
document.querySelectorAll('.steps button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('homeLink').addEventListener('click', (e) => { e.preventDefault(); showTab('recorte'); window.scrollTo({ top: 0, behavior: 'smooth' }); });
const TAB_ORDER = ['recorte', 'comparar', 'catalogo', 'acervo'];
let curTab = null;
const pillEl = document.querySelector('.steps .pill');
const pill = { x: springValue(0, v => pillEl.style.setProperty('--x', v)), y: springValue(0, v => pillEl.style.setProperty('--y', v)),
  w: springValue(0, v => pillEl.style.width = v + 'px'), h: springValue(0, v => pillEl.style.height = v + 'px') };
pillEl.style.transform = 'translate(calc(var(--x, 0) * 1px), calc(var(--y, 0) * 1px))';
function placePill(jump) {
  const b = document.querySelector('.steps button[aria-selected="true"]'); if (!b) return;
  // X, Y, largura e altura em molas independentes: as abas podem quebrar linha no celular
  pill.x.to(b.offsetLeft, jump); pill.y.to(b.offsetTop, jump); pill.w.to(b.offsetWidth, jump); pill.h.to(b.offsetHeight, jump);
}
window.addEventListener('resize', () => placePill(true));
document.fonts && document.fonts.ready.then(() => placePill(true));
function showTab(name) {
  const prev = curTab; curTab = name;
  document.querySelectorAll('.steps button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  placePill(prev === null);
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 'tab-' + name);
  if (prev && prev !== name) {
    const el = $('tab-' + name), dir = TAB_ORDER.indexOf(name) > TAB_ORDER.indexOf(prev) ? 1 : -1;
    // a aba nova entra do lado em que está na barra de etapas
    if (reduceMotion()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
    else el.animate([{ opacity: 0, transform: `translateX(${dir * 18}px)` }, { opacity: 1, transform: 'none' }], { duration: 340, easing: EASE });
  }
  try { localStorage.setItem('bt-tab', name); } catch (e) {}
  if (name === 'acervo') renderGroups();
  if (name === 'comparar') { fillSampleSelect(); if (S.cmp.results) drawOverlay(); }
  if (name === 'catalogo') renderCatalog();
  if (name === 'recorte') { drawSrc(); drawBin(); }
}

/* ---------- segmented controls ---------- */
function seg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    onChange(b.dataset.v);
  });
}
function setSeg(id, v) { $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === String(v)))); }

/* =================================================================
   1. RECORTE
   ================================================================= */
function setImage(canvas, label) {
  const em = document.getElementById('srcEmpty'); if (em) em.remove();
  S.img = canvas;
  const maxW = 1400, sc = Math.min(1, maxW / canvas.width);
  const d = document.createElement('canvas'); d.width = Math.round(canvas.width * sc); d.height = Math.round(canvas.height * sc);
  const c = d.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(canvas, 0, 0, d.width, d.height);
  S.disp = d; S.dispScale = sc;
  S.roi = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  S.boxes = []; S.sel = -1; S.edits = [];
  $('srcMeta').textContent = `${label} · ${canvas.width}×${canvas.height}px`;
  drawSrc(); process(true);
}
async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Escolha um arquivo de imagem (JPG, PNG, TIFF convertido…).'); return; }
  try {
    const bmp = await createImageBitmap(file);
    const max = 4000, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
    const c = cv.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, cv.width, cv.height);
    setImage(cv, file.name || 'imagem colada');
    if (Math.max(cv.width, cv.height) > 1200) toast('Dica: arraste sobre a imagem para recortar só a área do texto. O tratamento fica bem melhor.', 5200);
  } catch (e) { toast('Não consegui abrir essa imagem.'); }
}
$('fileImg').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
const srcViewer = $('srcViewer');
['dragover', 'dragenter'].forEach(ev => srcViewer.addEventListener(ev, (e) => { e.preventDefault(); srcViewer.classList.add('drop'); }));
['dragleave', 'drop'].forEach(ev => srcViewer.addEventListener(ev, () => srcViewer.classList.remove('drop')));
srcViewer.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
window.addEventListener('paste', (e) => {
  if (e.target.matches && e.target.matches('input, textarea')) return;
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (it) { loadFile(it.getAsFile()); showTab('recorte'); }
});
$('btnFull').addEventListener('click', () => { if (!S.img) return; S.roi = { x: 0, y: 0, w: S.img.width, h: S.img.height }; S.boxes = []; S.sel = -1; drawSrc(); process(true); });

function drawSrc() {
  const cv = $('cvSrc'); if (!S.disp) return;
  cv.width = S.disp.width; cv.height = S.disp.height;
  const c = cv.getContext('2d'); c.drawImage(S.disp, 0, 0);
  if (S.roi) {
    const k = S.dispScale, r = S.roi;
    c.fillStyle = 'rgba(10,12,18,0.45)';
    c.beginPath(); c.rect(0, 0, cv.width, cv.height); c.rect(r.x * k, r.y * k, r.w * k, r.h * k); c.fill('evenodd');
    c.lineWidth = Math.max(1.5, cv.width / (cv.clientWidth || cv.width) * 1.5);
    c.strokeStyle = 'rgba(255,250,242,0.95)'; c.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
  }
}
function evtPos(cv, e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
}
(function srcPointer() {
  const cv = $('cvSrc'); let start = null;
  cv.addEventListener('pointerdown', (e) => { if (!S.img) return; cv.setPointerCapture(e.pointerId); const p = evtPos(cv, e); start = { x: p.x / S.dispScale, y: p.y / S.dispScale }; });
  cv.addEventListener('pointermove', (e) => {
    const p = evtPos(cv, e);
    if (S.tool !== 'caixas') {
      S.hover = p;
      if (stroke) { const sc = S.proc.sc; stroke.pts.push([p.x / sc + S.roi.x, p.y / sc + S.roi.y]); paintStroke(S.proc.bin, S.proc.w, S.proc.h, stroke, S.roi, sc, stroke.pts.length - 2); }
      scheduleBin(); return;
    }
    if (!start) return; const x = p.x / S.dispScale, y = p.y / S.dispScale;
    if (Math.abs(x - start.x) < 4 && Math.abs(y - start.y) < 4) return;
    const x0 = Math.max(0, Math.min(start.x, x)), y0 = Math.max(0, Math.min(start.y, y));
    const x1 = Math.min(S.img.width, Math.max(start.x, x)), y1 = Math.min(S.img.height, Math.max(start.y, y));
    S.roi = { x: Math.round(x0), y: Math.round(y0), w: Math.max(4, Math.round(x1 - x0)), h: Math.max(4, Math.round(y1 - y0)) };
    S.roiDragged = true; drawSrc();
  });
  cv.addEventListener('pointerup', (e) => {
    if (!start) return;
    const p = evtPos(cv, e);
    if (!S.roiDragged && S.picking) pickInk(p.x / S.dispScale, p.y / S.dispScale);
    else if (S.roiDragged) { S.boxes = []; S.sel = -1; process(true); }
    start = null; S.roiDragged = false;
  });
})();
function pickInk(x, y) {
  const c = S.img.getContext('2d'); const r = 2;
  const d = c.getImageData(Math.max(0, Math.round(x) - r), Math.max(0, Math.round(y) - r), 2 * r + 1, 2 * r + 1).data;
  let R = 0, G = 0, B = 0, n = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  S.p.ink = [R / n, G / n, B / n].map(Math.round);
  S.picking = false; $('btnPick').setAttribute('aria-pressed', 'false'); $('btnPick').classList.remove('armed'); $('btnPick').textContent = 'Escolher cor na imagem';
  $('inkSwatch').style.background = `rgb(${S.p.ink.join(',')})`;
  process();
}

/* controles */
seg('segUp', v => { S.p.up = +v; process(); });
seg('segMode', v => { S.p.mode = v; $('inkRow').hidden = v !== 'cor'; $('polRow').hidden = v === 'cor'; process(); });
seg('segPol', v => { S.p.pol = v; process(); });
seg('segBin', v => { S.p.method = v; $('rowWin').hidden = $('rowK').hidden = v !== 'sauvola'; $('rowThr').hidden = v !== 'manual'; $('rowLev').hidden = v !== 'multi'; process(); });
$('btnPick').addEventListener('click', () => {
  S.picking = !S.picking; const b = $('btnPick');
  b.setAttribute('aria-pressed', String(S.picking)); b.classList.toggle('armed', S.picking);
  b.textContent = S.picking ? 'Clique numa letra da imagem' : 'Escolher cor na imagem';
});
function bindRange(id, out, key, f = (v) => v, show = (v) => v) {
  const el = $(id);
  el.addEventListener('input', () => { S.p[key] = f(el.value); $(out).textContent = show(S.p[key]); process(); });
}
bindRange('rgWin', 'oWin', 'win', Number, v => v + '%');
bindRange('rgLev', 'oLev', 'levels', Number);
bindRange('rgVL', 'oVL', 'vl', Number, v => v ? v + '%' : 'desl.');
bindRange('rgHL', 'oHL', 'hl', Number, v => v ? v + '%' : 'desl.');
bindRange('rgK', 'oK', 'k', Number, v => fmt(v, 2));
bindRange('rgThr', 'oThr', 'thr', Number);
bindRange('rgClose', 'oClose', 'close', Number);
bindRange('rgMin', 'oMin', 'min', Number, v => v + '%');

let procT;
let procRAF = 0;
/* retorno contínuo: enquanto o slider se move, recalcula no máximo uma vez por quadro */
function process(now) {
  void procT;
  if (now) { cancelAnimationFrame(procRAF); procRAF = 0; runProcess(); return; }
  if (procRAF) return;
  procRAF = requestAnimationFrame(() => { procRAF = 0; runProcess(); });
}
function runProcess() {
  if (!S.img || !S.roi) return;
  const r = S.roi, LIMIT = 3.2e6;
  let sc = S.p.up;
  if (r.w * r.h * sc * sc > LIMIT) sc = Math.sqrt(LIMIT / (r.w * r.h));
  const w = Math.max(1, Math.round(r.w * sc)), h = Math.max(1, Math.round(r.h * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(S.img, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const rgba = c.getImageData(0, 0, w, h).data;
  const gray = S.p.mode === 'cor' ? Core.colorDistGray(rgba, w, h, S.p.ink) : Core.toGray(rgba, w, h);
  const winPx = Math.max(15, Math.round(S.p.win / 100 * Math.min(w, h)) | 1);
  $('oWin').title = `${winPx} px`;
  let bin = Core.binarize(gray, w, h, { method: S.p.method, thr: S.p.thr, win: winPx, k: S.p.k, levels: S.p.levels, polarity: S.p.mode === 'cor' ? 'dark' : S.p.pol });
  // limpeza na escala do texto: a força depende da espessura do traço e do tamanho das letras deste recorte
  const est = Core.textScale(bin, w, h);
  const rc = Math.round(S.p.close / 10 * est.stroke);
  bin = Core.close(bin, w, h, rc);
  const Lmin = Math.min(w, h);
  if (S.p.vl) bin = Core.removeLines(bin, w, h, Math.max(8, Math.round(S.p.vl / 100 * Lmin)), true);
  if (S.p.hl) bin = Core.removeLines(bin, w, h, Math.max(8, Math.round(S.p.hl / 100 * Lmin)), false);
  const minA = S.p.min > 0 ? Math.max(3, Math.round(S.p.min / 100 * est.letterArea)) : 1;
  bin = Core.removeSmall(bin, w, h, minA);
  applyEdits(bin, w, h, r, sc);
  $('oClose').textContent = String(S.p.close);
  $('oMin').textContent = S.p.min + '%';
  $('cleanInfo').textContent = `Traço típico ≈ ${Math.round(est.stroke)} px · fechar com raio ${rc} px · apagar manchas < ${S.p.min ? minA : 0} px²` + (S.p.vl || S.p.hl ? ` · fios ≥ ${Math.round(Math.max(S.p.vl, S.p.hl) / 100 * Math.min(w, h))} px` : '');
  let ink = 0; for (let i = 0; i < bin.length; i++) ink += bin[i];
  S.proc = { w, h, bin, sc, minA };
  void ink; updateInk();
  drawBin();
}
/* caixas guardadas em coordenadas da imagem original */
const toProc = (b) => { const r = S.roi, sc = S.proc.sc; return { x0: Math.round((b.x0 - r.x) * sc), y0: Math.round((b.y0 - r.y) * sc), x1: Math.round((b.x1 - r.x) * sc), y1: Math.round((b.y1 - r.y) * sc) }; };
const fromProc = (b) => { const r = S.roi, sc = S.proc.sc; return { x0: b.x0 / sc + r.x, y0: b.y0 / sc + r.y, x1: b.x1 / sc + r.x, y1: b.y1 / sc + r.y }; };
const clampBox = (b) => ({ x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(S.proc.w - 1, b.x1), y1: Math.min(S.proc.h - 1, b.y1) });

let tempBox = null;
function drawBin() {
  const cv = $('cvBin'); const P = S.proc;
  if (!P) return;
  cv.width = P.w; cv.height = P.h;
  const c = cv.getContext('2d');
  const id = c.createImageData(P.w, P.h);
  const ink = hexToRgb(css('--ink')), paper = hexToRgb(css('--sheet'));
  for (let i = 0, j = 0; i < P.bin.length; i++, j += 4) {
    const col = P.bin[i] ? ink : paper; id.data[j] = col[0]; id.data[j + 1] = col[1]; id.data[j + 2] = col[2]; id.data[j + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  const k = P.w / Math.max(1, cv.clientWidth || P.w);
  c.lineWidth = Math.max(1, 1.5 * k);
  c.font = `${Math.round(12 * k)}px "Host Grotesk", Arial, sans-serif`;
  c.textBaseline = 'bottom';
  S.boxes.forEach((bb, i) => {
    const b = toProc(bb);
    const selC = i === S.sel;
    c.strokeStyle = selC ? css('--amostra') : css('--guide');
    c.lineWidth = Math.max(1, (selC ? 2.5 : 1.5) * k);
    c.strokeRect(b.x0 - 0.5, b.y0 - 0.5, b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
    if (bb.label) { c.fillStyle = selC ? css('--amostra') : css('--muted'); c.fillText(bb.label, b.x0, b.y0 - 2 * k); }
  });
  if (S.hover && S.tool !== 'caixas') {
    c.beginPath(); c.arc(S.hover.x, S.hover.y, brushProcR(), 0, Math.PI * 2);
    c.lineWidth = Math.max(1, 1.5 * k); c.strokeStyle = S.tool === 'borracha' ? css('--amostra') : css('--guide'); c.stroke();
  }
  if (tempBox) { c.setLineDash([4 * k, 3 * k]); c.strokeStyle = css('--amostra'); c.strokeRect(tempBox.x0, tempBox.y0, tempBox.x1 - tempBox.x0, tempBox.y1 - tempBox.y0); c.setLineDash([]); }
  updateLabeler();
}
(function binPointer() {
  const cv = $('cvBin'); let start = null;
  let stroke = null;
  cv.addEventListener('pointerdown', (e) => {
    if (!S.proc) return; cv.focus(); cv.setPointerCapture(e.pointerId);
    const p = evtPos(cv, e);
    if (S.tool !== 'caixas') {
      const sc = S.proc.sc;
      stroke = { erase: S.tool === 'borracha', r: brushProcR() / sc, pts: [[p.x / sc + S.roi.x, p.y / sc + S.roi.y]] };
      S.edits.push(stroke); paintStroke(S.proc.bin, S.proc.w, S.proc.h, stroke, S.roi, sc, stroke.pts.length - 1); scheduleBin();
      return;
    }
    let hit = -1, area = Infinity;
    S.boxes.forEach((bb, i) => { const b = toProc(bb); if (p.x >= b.x0 - 1 && p.x <= b.x1 + 1 && p.y >= b.y0 - 1 && p.y <= b.y1 + 1) { const a = (b.x1 - b.x0) * (b.y1 - b.y0); if (a < area) { area = a; hit = i; } } });
    if (hit >= 0) { S.sel = hit; drawBin(); start = null; return; }
    start = p;
  });
  cv.addEventListener('pointermove', (e) => {
    const p = evtPos(cv, e);
    if (S.tool !== 'caixas') {
      S.hover = p;
      if (stroke) { const sc = S.proc.sc; stroke.pts.push([p.x / sc + S.roi.x, p.y / sc + S.roi.y]); paintStroke(S.proc.bin, S.proc.w, S.proc.h, stroke, S.roi, sc, stroke.pts.length - 2); }
      scheduleBin(); return;
    }
    if (!start) return;
    tempBox = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) };
    drawBin();
  });
  cv.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; scheduleBin(); } });
  cv.addEventListener('pointerup', () => {
    if (stroke) { stroke = null; updateInk(); return; }
    if (start && tempBox && tempBox.x1 - tempBox.x0 >= 3 && tempBox.y1 - tempBox.y0 >= 3) {
      const nb = { ...fromProc(clampBox({ x0: Math.round(tempBox.x0), y0: Math.round(tempBox.y0), x1: Math.round(tempBox.x1), y1: Math.round(tempBox.y1) })), label: '' };
      S.boxes.push(nb); reorder(nb);
    }
    start = null; tempBox = null; drawBin();
  });
  cv.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel >= 0) { e.preventDefault(); delBox(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); moveSel(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveSel(-1); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoEdit(); }
  });
})();

/* ---------- retoques manuais (borracha, pincel, apagar fora das caixas) ----------
   Ficam guardados em coordenadas da imagem original e são reaplicados sempre que o tratamento muda. */
function brushProcR() { const cv = $('cvBin'); const k = S.proc ? S.proc.w / Math.max(1, cv.clientWidth || S.proc.w) : 1; return Math.max(1, S.brush * k / 2); }
function paintStroke(bin, w, h, st, roi, sc, from) {
  const r = Math.max(0.6, st.r * sc), v = st.erase ? 0 : 1;
  const P = st.pts.map(([x, y]) => [(x - roi.x) * sc, (y - roi.y) * sc]);
  const dot = (cx, cy) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) bin[y * w + x] = v;
  };
  for (let i = Math.max(0, from); i < P.length; i++) {
    const [ax, ay] = P[i], [bx, by] = i + 1 < P.length ? P[i + 1] : P[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r / 2)));
    for (let t = 0; t <= n; t++) dot(ax + (bx - ax) * t / n, ay + (by - ay) * t / n);
  }
}
function applyEdits(bin, w, h, roi, sc) {
  for (const st of S.edits) {
    if (st.keep) {
      const keep = new Uint8Array(w * h);
      for (const b of st.keep) {
        const x0 = Math.max(0, Math.floor((b.x0 - roi.x) * sc)), x1 = Math.min(w - 1, Math.ceil((b.x1 - roi.x) * sc));
        const y0 = Math.max(0, Math.floor((b.y0 - roi.y) * sc)), y1 = Math.min(h - 1, Math.ceil((b.y1 - roi.y) * sc));
        for (let y = y0; y <= y1; y++) keep.fill(1, y * w + x0, y * w + x1 + 1);
      }
      for (let i = 0; i < bin.length; i++) if (!keep[i]) bin[i] = 0;
    } else paintStroke(bin, w, h, st, roi, sc, 0);
  }
}
let binRAF = 0;
function scheduleBin() { if (binRAF) return; binRAF = requestAnimationFrame(() => { binRAF = 0; drawBin(); }); }
function updateInk() { const P = S.proc; let ink = 0; for (let i = 0; i < P.bin.length; i++) ink += P.bin[i]; $('binMeta').textContent = `${P.w}×${P.h}px · tinta ${fmt(ink / P.bin.length * 100)}%` + (S.edits.length ? ` · ${S.edits.length} retoque(s)` : ''); }
function undoEdit() { if (!S.edits.length) return; S.edits.pop(); process(true); }
seg('segTool', v => {
  S.tool = v; $('cvBin').dataset.tool = v; S.hover = null;
  $('toolHint').textContent = v === 'caixas' ? 'Clique numa caixa para selecionar; arraste numa área vazia para desenhar uma caixa.'
    : v === 'borracha' ? 'Pinte sobre o fundo para apagar o que não é letra. Ctrl/⌘ Z desfaz.' : 'Pinte para completar traços que o tratamento perdeu. Ctrl/⌘ Z desfaz.';
  drawBin();
});
$('rgBrush').addEventListener('input', (e) => { S.brush = +e.target.value; $('oBrush').textContent = S.brush; scheduleBin(); });
$('btnUndo').addEventListener('click', undoEdit);
$('btnClearEdits').addEventListener('click', () => { if (!S.edits.length) return; S.edits = []; process(true); });
$('btnKeepBoxes').addEventListener('click', () => {
  if (!S.boxes.length) { toast('Desenhe ou detecte caixas em volta das letras antes.'); return; }
  S.edits.push({ keep: S.boxes.map(b => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })) }); process(true);
  toast('Tudo fora das caixas foi apagado. Use Desfazer retoque para voltar.');
});
function reorder(keepSel) {
  const ordered = Core.readingOrder(S.boxes);
  S.boxes = ordered;
  S.sel = keepSel ? S.boxes.indexOf(keepSel) : Math.min(S.sel, S.boxes.length - 1);
}
function delBox() { if (S.sel < 0) return; S.boxes.splice(S.sel, 1); S.sel = Math.min(S.sel, S.boxes.length - 1); drawBin(); }
function moveSel(d) { if (!S.boxes.length) return; S.sel = (Math.max(0, S.sel) + d + S.boxes.length) % S.boxes.length; drawBin(); }
$('btnDelBox').addEventListener('click', delBox);
$('btnPrev').addEventListener('click', () => moveSel(-1));
$('btnNext').addEventListener('click', () => moveSel(1));
$('btnClearBoxes').addEventListener('click', () => { S.boxes = []; S.sel = -1; drawBin(); });
$('btnDetect').addEventListener('click', () => {
  if (!S.proc) { toast('Abra uma imagem primeiro.'); return; }
  const P = S.proc;
  const bx = Core.segment(P.bin, P.w, P.h, Math.max(2, P.minA));
  S.boxes = bx.map(b => ({ ...fromProc(b), label: '' })); S.sel = S.boxes.length ? 0 : -1;
  drawBin();
  toast(S.boxes.length ? `${S.boxes.length} caracteres detectados.` : 'Nenhum caractere encontrado. Ajuste a binarização ou o controle Tirar manchas.');
  if (S.boxes.length) $('lblInput').focus();
});
$('lblInput').addEventListener('input', (e) => { if (S.sel < 0) return; S.boxes[S.sel].label = e.target.value.trim(); drawBin(); });
$('lblInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); moveSel(1); $('lblInput').select(); }
  if (e.key === 'Tab' && !e.shiftKey && S.sel < S.boxes.length - 1) { e.preventDefault(); moveSel(1); $('lblInput').select(); }
});
$('btnSeq').addEventListener('click', applySeq);
$('seqInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applySeq(); } });
function applySeq() {
  const chars = [...$('seqInput').value.replace(/\s+/g, '')];
  if (!chars.length || !S.boxes.length) { toast('Detecte os caracteres e digite o texto antes.'); return; }
  S.boxes.forEach((b, i) => { b.label = chars[i] || b.label; });
  drawBin();
  if (chars.length !== S.boxes.length) toast(`Atenção: ${chars.length} caracteres no texto e ${S.boxes.length} caixas. Confira os rótulos (letras coladas ou pingos separados).`, 5200);
  else toast('Rótulos aplicados em ordem de leitura.');
}
function currentMask(bb) {
  const P = S.proc; const b = clampBox(toProc(bb));
  if (b.x1 < b.x0 || b.y1 < b.y0) return null;
  return Core.extractMask(P.bin, P.w, P.h, b);
}
function updateLabeler() {
  const n = S.boxes.length, lab = S.boxes.filter(b => b.label).length;
  $('boxMeta').textContent = `${n} caixas · ${lab} rotuladas`;
  $('barCount').textContent = lab ? `${lab} de ${n} caracteres rotulados` : n ? `${n} caixas, nenhuma rotulada` : 'Nenhum caractere detectado';
  $('btnIdentify').disabled = !lab; $('btnDetect').classList.toggle('primary', !n);
  const cv = $('cvSel'); const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height);
  const inp = $('lblInput');
  if (S.sel < 0 || !S.boxes[S.sel] || !S.proc) { $('selInfo').textContent = 'Nenhuma caixa'; inp.value = ''; inp.disabled = true; return; }
  inp.disabled = false;
  if (document.activeElement !== inp) inp.value = S.boxes[S.sel].label || '';
  $('selInfo').textContent = `Caixa ${S.sel + 1} de ${n}`;
  const m = currentMask(S.boxes[S.sel]);
  if (m) drawMask(cv, m, css('--ink'), 8);
  $('saveHint').textContent = lab ? `${lab} glifo(s) prontos para salvar.` : 'Rotule pelo menos um caractere para salvar.';
}

/* destino */
seg('segDest', v => { S.dest = v; $('destBox').dataset.kind = v; $('destSample').hidden = v !== 'sample'; $('destRef').hidden = v !== 'ref'; });
$('btnSave').addEventListener('click', async () => {
  if (!S.proc) { toast('Abra uma imagem primeiro.'); return; }
  const labeled = S.boxes.filter(b => b.label);
  if (!labeled.length) { toast('Rotule pelo menos um caractere.'); return; }
  const meta = S.dest === 'sample'
    ? { kind: 'sample', artefact: $('fArt').value.trim(), typeNo: $('fTipo').value.trim() }
    : { kind: 'ref', catalog: $('fCat').value.trim(), family: $('fFam').value.trim(), style: $('fEst').value.trim(), source: 'scan' };
  if (S.dest === 'sample' && (!meta.artefact || !meta.typeNo)) { toast('Preencha o artefato e o número do tipo.'); return; }
  if (S.dest === 'ref' && (!meta.catalog || !meta.family)) { toast('Preencha o catálogo e a família.'); return; }
  const docs = [];
  for (const b of labeled) {
    let m = currentMask(b); if (!m) continue;
    m = Core.shrinkMask(m, 128);
    docs.push({ ...meta, label: b.label, w: m.w, h: m.h, bits: Core.packMask(m), created: Date.now() });
  }
  $('btnSave').disabled = true;
  const n = await Store.addMany(docs);
  $('btnSave').disabled = false;
  if (n) toast(`${n} glifo(s) salvos em “${groupKey(meta)}”.`);
});

/* =================================================================
   desenho de máscaras e vetorização
   ================================================================= */
function drawMask(cv, m, color, pad = 4) {
  const W = cv.width, H = cv.height, c = cv.getContext('2d');
  const s = Math.min((W - 2 * pad) / m.w, (H - 2 * pad) / m.h);
  const tmp = document.createElement('canvas'); tmp.width = m.w; tmp.height = m.h;
  const tc = tmp.getContext('2d'); const id = tc.createImageData(m.w, m.h); const col = hexToRgb(color);
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) { id.data[i * 4] = col[0]; id.data[i * 4 + 1] = col[1]; id.data[i * 4 + 2] = col[2]; id.data[i * 4 + 3] = 255; }
  tc.putImageData(id, 0, 0);
  c.imageSmoothingEnabled = s < 1;
  c.drawImage(tmp, (W - m.w * s) / 2, (H - m.h * s) / 2, m.w * s, m.h * s);
}
function glyphCanvas(m, color, size) {
  const cv = document.createElement('canvas'); cv.width = Math.round(size * DPR); cv.height = Math.round(size * DPR);
  drawMask(cv, m, color, Math.round(3 * DPR)); return cv;
}
/* amplia com interpolação + suavização leve, só para o traçado do contorno */
function smoothUp(bin, w, h, s) {
  const W = w * s, H = h * s, f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = (y + 0.5) / s - 0.5, y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = (x + 0.5) / s - 0.5, x0 = Math.floor(sx), fx = sx - x0;
      const v = (a, b) => (a >= 0 && b >= 0 && a < w && b < h) ? bin[b * w + a] : 0;
      f[y * W + x] = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  const r = Math.max(1, Math.round(s / 2)), t = new Float32Array(W * H), o = new Float32Array(W * H), n = 2 * r + 1;
  for (let y = 0; y < H; y++) { let a = 0; for (let x = -r; x < W; x++) { if (x + r < W) a += f[y * W + x + r]; if (x - r - 1 >= 0) a -= f[y * W + x - r - 1]; if (x >= 0) t[y * W + x] = a / n; } }
  for (let x = 0; x < W; x++) { let a = 0; for (let y = -r; y < H; y++) { if (y + r < H) a += t[(y + r) * W + x]; if (y - r - 1 >= 0) a -= t[(y - r - 1) * W + x]; if (y >= 0) o[y * W + x] = a / n; } }
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = o[i] >= 0.5 ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  return { width: W, height: H, data: d };
}
function traceSVG(bin, w, h) {
  const s = Math.max(1, Math.min(4, Math.floor(Math.sqrt(2.5e6 / (w * h)))));
  const img = smoothUp(bin, w, h, s);
  let svg = ImageTracer.imagedataToSVG(img, {
    numberofcolors: 2, colorsampling: 0, pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
    ltres: 0.5, qtres: 0.5, pathomit: 8 * s, roundcoords: 2, viewbox: true, linefilter: true, strokewidth: 0, scale: 1 / s,
  });
  svg = svg.replace(/<path fill="rgb\(255,255,255\)"[^>]*\/>/g, '')
    .replace(/ stroke="[^"]*" stroke-width="[^"]*" opacity="1"/g, '')
    .replace(/fill="rgb\(0,0,0\)"/g, 'fill="#000" fill-rule="evenodd"')
    .replace(/ desc="[^"]*"/, '');
  return svg.replace('<svg ', `<svg width="${w}" height="${h}" `);
}
function showSVG(svg, title, filename) {
  const body = document.createElement('div'); body.className = 'side';
  const box = document.createElement('div'); box.className = 'svgbox'; box.innerHTML = svg;
  const ta = document.createElement('textarea'); ta.value = svg; ta.rows = 3; ta.readOnly = true; ta.setAttribute('aria-label', 'Código SVG');
  const row = document.createElement('div'); row.className = 'row';
  const b1 = button('Baixar SVG', 'btn primary', () => saveFile(filename, svg));
  const b2 = button('Copiar SVG', 'btn', () => {
    navigator.clipboard.writeText(svg).then(() => toast('SVG copiado.')).catch(() => { ta.focus(); ta.select(); toast('Selecionei o código: use Ctrl/⌘ C.'); });
  });
  row.append(b1, b2);
  const p = document.createElement('p'); p.className = 'hint';
  p.textContent = `Contorno traçado com imagetracer.js a partir da máscara binária, sem preenchimento generativo. ${(svg.match(/<path/g) || []).length} caminho(s), ${Math.round(svg.length / 1024 * 10) / 10} KB.`;
  body.append(box, row, p, ta);
  openModal(title, body);
}
$('btnVecRoi').addEventListener('click', () => {
  if (!S.proc) { toast('Abra uma imagem primeiro.'); return; }
  const P = S.proc;
  setTimeout(() => showSVG(traceSVG(P.bin, P.w, P.h), 'Vetorização do recorte', 'recorte-vetorizado.svg'), 10);
});

/* modal */
function button(text, cls, fn) { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.addEventListener('click', fn); return b; }
let lastFocus = null, lastPointer = null, modalAnims = [];
document.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
function modalOrigin(card) {
  const r = card.getBoundingClientRect(); const p = lastPointer || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  card.style.transformOrigin = `${Math.max(0, Math.min(r.width, p.x - r.left))}px ${Math.max(0, Math.min(r.height, p.y - r.top))}px`;
}
function openModal(title, node) {
  lastFocus = document.activeElement;
  modalAnims.forEach(a => a.cancel()); modalAnims = [];
  $('modalTitle').textContent = title; const mb = $('modalBody'); mb.innerHTML = ''; mb.append(node);
  const m = $('modal'), card = m.querySelector('.card'); m.hidden = false; $('modalClose').focus();
  modalOrigin(card);
  if (reduceMotion()) { modalAnims = [m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })]; return; }
  // o cartão se materializa a partir do botão que o abriu: escala e desfoque juntos, sobre um véu que escurece o resto
  modalAnims = [
    m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' }),
    card.animate([{ opacity: 0, transform: 'scale(0.9)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 380, easing: EASE }),
  ];
}
function closeModal() {
  const m = $('modal'), card = m.querySelector('.card');
  if (m.hidden) return;
  modalAnims.forEach(a => a.cancel());
  const done = () => { m.hidden = true; modalAnims = []; if (lastFocus && lastFocus.focus) lastFocus.focus(); };
  if (reduceMotion()) { done(); return; }
  // volta pelo mesmo caminho, em direção à origem
  const a = card.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'scale(0.92)', filter: 'blur(6px)' }], { duration: 220, easing: 'cubic-bezier(0.64, 0, 0.78, 0)', fill: 'forwards' });
  const b = m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
  modalAnims = [a, b];
  b.onfinish = () => { a.cancel(); b.cancel(); done(); };
}
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

/* =================================================================
   2. ACERVO
   ================================================================= */
seg('segKind', v => { S.kindFilter = v; renderGroups(); });
$('acSearch').addEventListener('input', (e) => { S.search = e.target.value.toLowerCase(); renderGroups(); });

function groups(list) {
  const map = new Map();
  for (const g of list) {
    const k = g.temp ? TEMP_KEY : groupKey(g);
    if (!map.has(k)) map.set(k, { key: k, kind: g.kind, temp: !!g.temp, items: [], source: g.source });
    map.get(k).items.push(g);
  }
  return [...map.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sample' ? -1 : 1) || (b.temp - a.temp) || a.key.localeCompare(b.key, 'pt-BR'));
}
const UPPER = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'], LOWER = [...'abcdefghijklmnopqrstuvwxyz'];
function renderGroups() {
  const host = $('groups'); host.innerHTML = '';
  const gs = groups(S.glyphs).filter(g => (S.kindFilter === 'all' || g.kind === S.kindFilter) && (!S.search || g.key.toLowerCase().includes(S.search)));
  if (!gs.length) {
    const p = document.createElement('div'); p.className = 'panel';
    p.innerHTML = '<div class="body"><p class="hint">Nenhum glifo salvo ainda. Na etapa <b>1 · Recorte e rótulos</b>, rotule os caracteres e use <b>Salvar no meu acervo</b>. O catálogo da Funtimod não precisa ser salvo: ele já está na aba 3.</p></div>';
    host.append(p); return;
  }
  for (const g of gs) host.append(groupCard(g));
}
function groupCard(g) {
  const card = document.createElement('div'); card.className = 'panel gcard'; card.dataset.kind = g.kind;
  const hd = document.createElement('header');
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = g.kind === 'sample' ? 'Amostra' : (g.source === 'digital' ? 'Ref. digital' : 'Referência');
  const h = document.createElement('h3'); h.textContent = g.key;
  const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${g.items.length} glifo(s) · ${new Set(g.items.map(i => i.label)).size} caracteres`;
  hd.append(kind, h, meta);
  const acts = document.createElement('div'); acts.className = 'acts';
  acts.append(button('Exportar tabela PNG', 'btn small', () => exportTable(g)));
  if (g.kind === 'sample') acts.append(button('Identificar', 'btn small', () => { showTab('comparar'); $('selSample').value = g.key; runRank(); }));
  if (!g.temp && !g.builtin) acts.append(armedDelete('Excluir grupo', () => Store.remove(g.items.map(i => i.id))));
  const body = document.createElement('div'); body.className = 'body';
  body.append(acts, alphaTable(g));
  card.append(hd, body);
  return card;
}
function armedDelete(label, fn) {
  const b = button(label, 'btn small danger', () => {
    if (b.dataset.armed) { fn(); delete b.dataset.armed; b.textContent = label; b.classList.remove('armed'); return; }
    b.dataset.armed = '1'; b.textContent = 'Confirmar exclusão'; b.classList.add('armed');
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; b.classList.remove('armed'); }, 4000);
  });
  return b;
}
function byLabel(items) { const m = new Map(); for (const i of items) { if (!m.has(i.label)) m.set(i.label, []); m.get(i.label).push(i); } return m; }
function alphaTable(g) {
  const wrap = document.createElement('div'); wrap.className = 'atable';
  const bl = byLabel(g.items);
  const color = g.kind === 'sample' ? css('--amostra') : css('--catalogo');
  const others = [...bl.keys()].filter(k => !UPPER.includes(k) && !LOWER.includes(k)).sort();
  const rows = [['Maiúsculas', UPPER.slice(0, 13)], ['', UPPER.slice(13)], ['Minúsculas', LOWER.slice(0, 13)], ['', LOWER.slice(13)]];
  for (let i = 0; i < others.length; i += 13) rows.push([i ? '' : 'Números, sinais e acentos', others.slice(i, i + 13)]);
  for (const [title, chars] of rows) {
    if (title) { const t = document.createElement('div'); t.className = 'sect'; t.textContent = title; wrap.append(t); }
    const tb = document.createElement('table'); const tr1 = document.createElement('tr'), tr2 = document.createElement('tr');
    for (const ch of chars) {
      const th = document.createElement('th'); th.textContent = ch; tr1.append(th);
      const td = document.createElement('td'); const list = bl.get(ch);
      if (list) {
        const b = document.createElement('button'); b.setAttribute('aria-label', `Caractere ${ch}, ${list.length} ocorrência(s)`);
        b.append(glyphCanvas(maskOf(list[0]), color, 40));
        b.addEventListener('click', () => glyphModal(g, ch, list, color));
        td.append(b);
        if (list.length > 1) { const s = document.createElement('span'); s.className = 'cnt'; s.textContent = '×' + list.length; td.append(s); }
      }
      tr2.append(td);
    }
    tb.append(tr1, tr2); wrap.append(tb);
  }
  return wrap;
}
function glyphModal(g, ch, list, color) {
  const body = document.createElement('div'); body.className = 'side';
  const inst = document.createElement('div'); inst.className = 'inst';
  for (const it of list) {
    const box = document.createElement('div'); box.className = 'it';
    const m = maskOf(it);
    box.append(glyphCanvas(m, color, 96));
    const info = document.createElement('span'); info.className = 'hint mono'; info.textContent = it.cat ? `cat. ${it.cat} · p. ${it.page}` : `${m.w}×${m.h}px`; box.append(info);
    const r = document.createElement('div'); r.className = 'row';
    r.append(button('SVG', 'btn small', () => {
      const svg = traceSVG(m.data, m.w, m.h);
      showSVG(svg, `Vetorização de “${ch}” · ${g.key}`, `${slug(g.key)}-${slug(ch)}.svg`);
    }));
    if (!it.builtin) {
      r.append(button('Renomear', 'btn small', () => {
        const row2 = document.createElement('div'); row2.className = 'row';
        const inp = document.createElement('input'); inp.type = 'text'; inp.value = it.label; inp.maxLength = 2; inp.style.maxWidth = '60px'; inp.setAttribute('aria-label', 'Novo rótulo');
        row2.append(inp, button('OK', 'btn small primary', async () => { if (inp.value.trim()) { await Store.relabel(it.id, inp.value.trim()); closeModal(); } }));
        box.append(row2); inp.focus();
      }));
      r.append(armedDelete('Excluir', async () => { await Store.remove([it.id]); closeModal(); }));
    }
    box.append(r); inst.append(box);
  }
  body.append(inst);
  openModal(`“${ch}” · ${g.key}`, body);
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'glifo';
async function exportTable(g) {
  const bl = byLabel(g.items);
  const others = [...bl.keys()].filter(k => !UPPER.includes(k) && !LOWER.includes(k)).sort();
  const rows = [UPPER.slice(0, 13), UPPER.slice(13), LOWER.slice(0, 13), LOWER.slice(13)];
  for (let i = 0; i < others.length; i += 13) rows.push(others.slice(i, i + 13));
  const cw = 64, hh = 22, ch = 70, pad = 24, top = 56;
  const W = pad * 2 + cw * 13, H = top + rows.length * (hh + ch) + pad;
  const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
  const c = cv.getContext('2d'); c.scale(2, 2);
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#111'; c.font = '600 15px "Host Grotesk", Arial'; c.fillText(g.key, pad, 30);
  c.fillStyle = '#666'; c.font = '11px "Host Grotesk", Arial, sans-serif'; c.fillText(`${g.items.length} glifos · FuntimoID`, pad, 46);
  c.strokeStyle = '#999'; c.lineWidth = 0.75;
  rows.forEach((chars, r) => {
    const y = top + r * (hh + ch);
    for (let i = 0; i < 13; i++) {
      const x = pad + i * cw, label = chars[i];
      c.strokeRect(x, y, cw, hh); c.strokeRect(x, y + hh, cw, ch);
      if (!label) continue;
      c.fillStyle = '#333'; c.font = '600 12px "Host Grotesk", Arial'; c.textAlign = 'center'; c.fillText(label, x + cw / 2, y + 15); c.textAlign = 'left';
      const list = bl.get(label);
      if (list) { const t = document.createElement('canvas'); t.width = (cw - 8) * 2; t.height = (ch - 8) * 2; drawMask(t, maskOf(list[0]), '#000', 4); c.drawImage(t, x + 4, y + hh + 4, cw - 8, ch - 8); }
    }
  });
  saveFile(`tabela-${slug(g.key)}.png`, await canvasBlob(cv));
}

/* fonte digital */
let userFont = null, userFontN = 0;
$('fileFont').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const name = 'UserFont' + (++userFontN);
    const face = new FontFace(name, buf); await face.load(); document.fonts.add(face);
    userFont = name; $('fontName').textContent = f.name; $('btnFontGen').disabled = false;
    if (!$('ffFam').value) $('ffFam').value = f.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ');
  } catch (err) { toast('Não consegui ler essa fonte. Use .ttf, .otf, .woff ou .woff2.'); }
});
function renderCharMask(family, ch, px) {
  const W = Math.ceil(px * 2.2), H = Math.ceil(px * 2);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.font = `${px}px "${family}"`; c.fillStyle = '#000'; c.textBaseline = 'alphabetic'; c.fillText(ch, px * 0.4, px * 1.45);
  const d = c.getImageData(0, 0, W, H).data, bin = new Uint8Array(W * H);
  for (let i = 0; i < bin.length; i++) bin[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return { bin, W, H, mask: Core.extractMask(bin, W, H, { x0: 0, y0: 0, x1: W - 1, y1: H - 1 }) };
}
$('btnFontGen').addEventListener('click', async () => {
  if (!userFont) return;
  const meta = { kind: 'ref', catalog: $('ffCat').value.trim() || 'Digital', family: $('ffFam').value.trim() || 'Fonte digital', style: $('ffEst').value.trim(), source: 'digital' };
  const chars = [...new Set([...$('ffChars').value.replace(/\s+/g, '')])];
  const docs = [];
  for (const ch of chars) {
    const r = renderCharMask(userFont, ch, 110); if (!r.mask) continue;
    const m = Core.shrinkMask(r.mask, 128);
    docs.push({ ...meta, label: ch, w: m.w, h: m.h, bits: Core.packMask(m), created: Date.now() });
  }
  $('btnFontGen').disabled = true;
  const n = await Store.addMany(docs);
  $('btnFontGen').disabled = false;
  toast(`${n} referências criadas em “${groupKey(meta)}”.`);
});

/* =================================================================
   3. COMPARAÇÃO
   ================================================================= */
function fillSampleSelect() {
  const sel = $('selSample'); const cur = sel.value;
  const gs = groups(allGlyphs()).filter(g => g.kind === 'sample');
  sel.innerHTML = '';
  if (!gs.length) { const o = document.createElement('option'); o.textContent = 'Rotule um recorte na etapa 1'; o.value = ''; sel.append(o); $('btnRank').disabled = true; return; }
  $('btnRank').disabled = false;
  for (const g of gs) { const o = document.createElement('option'); o.value = g.key; o.textContent = `${g.key} (${g.items.length} glifos)`; sel.append(o); }
  if (S.wantSample && gs.some(g => g.key === S.wantSample)) { sel.value = S.wantSample; S.wantSample = null; }
  else if (gs.some(g => g.key === cur)) sel.value = cur;
}
$('btnRank').addEventListener('click', runRank);
let rankToken = 0;
async function runRank() {
  const key = $('selSample').value; if (!key) return;
  const sg = groups(allGlyphs()).find(g => g.key === key && g.kind === 'sample'); if (!sg) return;
  const scope = $('selScope').value;
  const refGroups = [];
  if (scope !== 'mine') refGroups.push(...S.famGroups);
  if (scope !== 'funtimod') refGroups.push(...groups(S.glyphs).filter(g => g.kind === 'ref'));
  if (!refGroups.length) { toast(scope === 'mine' ? 'Você ainda não tem referências próprias no acervo.' : 'O catálogo da Funtimod ainda está carregando.'); return; }
  const token = ++rankToken;
  // até 2 ocorrências por letra, para o tempo de cálculo não explodir
  const per = new Map(), samples = [];
  for (const i of sg.items) { const n = per.get(i.label) || 0; if (n >= 2) continue; per.set(i.label, n + 1); samples.push({ label: i.label, mask: maskOf(i), g: i }); }
  const labels = new Set(samples.flatMap(s => Core.altLabels(s.label)));
  $('prog').hidden = false; const bar = $('prog').firstElementChild; bar.style.width = '0%';
  $('btnRank').disabled = true; $('btnIdentify').disabled = true;
  const t0 = performance.now();
  // 1) pré-filtro rápido em todas as famílias
  const pre = [];
  for (let gi = 0; gi < refGroups.length; gi++) {
    const rg = refGroups[gi];
    const refs = rg.items.filter(i => labels.has(i.label));
    if (!refs.length) continue;
    const byL = new Map(); for (const r of refs) { if (!byL.has(r.label)) byL.set(r.label, []); byL.get(r.label).push(r); }
    let sum = 0, n = 0; const cov = new Set();
    for (const s of samples) { const c = Core.altLabels(s.label).flatMap(l => byL.get(l) || []); if (!c.length) continue; let b = 0; for (const r of c) b = Math.max(b, Core.coarse(s.mask, maskOf(r))); sum += b; n++; cov.add(s.label); }
    const nl = new Set(samples.map(x => x.label)).size;
    pre.push({ rg, refs, val: (sum / n) * (0.7 + 0.3 * cov.size / nl) });
    if (gi % 8 === 7) { bar.style.width = (gi / refGroups.length * 25) + '%'; await sleep(0); if (token !== rankToken) return; }
  }
  pre.sort((a, b) => b.val - a.val);
  const TOP = 12;
  const chosen = pre.filter((p, i) => i < TOP || !p.rg.builtin);
  // 2) comparação completa nas candidatas
  const results = [];
  for (let k = 0; k < chosen.length; k++) {
    const { rg, refs } = chosen[k];
    const r = Core.rank(samples, refs.map(i => ({ label: i.label, mask: maskOf(i), group: rg.key, g: i })))[0];
    r.builtin = !!rg.builtin; r.info = rg.info; r.kind = rg.source;
    results.push(r);
    bar.style.width = (25 + (k + 1) / chosen.length * 75) + '%';
    await sleep(0);
    if (token !== rankToken) return;
  }
  const adj = (r) => r.n ? r.score * (0.8 + 0.2 * r.coverage) : -1;
  results.sort((a, b) => adj(b) - adj(a));
  S.cmp.results = results; S.cmp.sample = key; S.cmp.row = results[0] && results[0].n ? 0 : -1; S.cmp.match = 0;
  $('btnRank').disabled = false; $('btnIdentify').disabled = false; $('prog').hidden = true;
  const skipped = pre.length - chosen.length;
  $('rankMeta').textContent = `${pre.length} famílias com letras em comum · ${chosen.length} comparadas em detalhe · ${samples.length} glifos · ${fmt((performance.now() - t0) / 1000)} s`;
  renderRank(); selectRow(S.cmp.row);
  if (!reduceMotion()) document.querySelectorAll('#rankTable .fill').forEach((f, i) =>
    f.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 620, delay: i * 28, easing: EASE, fill: 'backwards' }));
  if (skipped > 0) $('rankMeta').title = `${skipped} famílias ficaram fora da comparação detalhada por terem semelhança bruta muito menor.`;
}
function renderRank() {
  const tb = $('rankTable').tBodies[0]; tb.innerHTML = '';
  const R = S.cmp.results || [];
  R.forEach((r, i) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0; tr.setAttribute('aria-selected', String(i === S.cmp.row));
    const widthPct = (r.aspect - 1) * 100;
    tr.innerHTML = `<td class="pos">${r.n ? i + 1 : '–'}</td>
      <td class="fam"></td>
      <td>${r.n ? `<div class="bar"><div class="track"><div class="fill" style="width:${Math.max(2, r.score).toFixed(1)}%"></div></div><span class="mono">${fmt(r.score)}</span></div>` : '<span class="hint">sem letras em comum</span>'}</td>
      <td class="num">${r.n ? fmt(r.iou, 3) : '–'}</td>
      <td class="num">${r.n ? fmt(r.chamferPct) + '%' : '–'}</td>
      <td class="num">${r.n ? fmt(r.hd95Pct) + '%' : '–'}</td>
      <td class="num">${r.n ? (widthPct >= 0 ? '+' : '−') + fmt(Math.abs(widthPct), 0) + '%' : '–'}</td>
      <td class="num">${r.n ? ((r.weight - 1) >= 0 ? '+' : '−') + fmt(Math.abs((r.weight - 1) * 100), 0) + '%' : '–'}</td>
      <td class="num">${r.coveredLabels}/${r.totalLabels}${r.n && r.coverage < 0.5 ? ' <span class="flag" title="Poucas letras em comum: a pontuação é menos confiável">●</span>' : ''}</td>`;
    const fam = tr.querySelector('.fam'); fam.textContent = r.group;
    const small = document.createElement('small'); small.textContent = r.builtin ? 'Funtimod · ' + pagesText(r.info) : (r.kind === 'digital' ? 'fonte digital do acervo' : 'referência do acervo'); fam.append(small);
    if (r.n) {
      tr.addEventListener('click', () => selectRow(i));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(i); } });
    }
    tb.append(tr);
  });
}
function selectRow(i) {
  S.cmp.row = i;
  [...$('rankTable').tBodies[0].rows].forEach((tr, k) => tr.setAttribute('aria-selected', String(k === i)));
  const r = S.cmp.results && S.cmp.results[i];
  $('detailPanel').hidden = !r || !r.n;
  if (!r || !r.n) return;
  $('detailMeta').textContent = `${S.cmp.sample} × ${r.group}`;
  const pr = $('pagesRow'); pr.innerHTML = '';
  if (r.builtin) { const t = document.createElement('span'); t.className = 'hint'; t.textContent = 'Páginas do catálogo:'; pr.append(t, pageLinks(r.info)); }
  const strip = $('strip'); strip.innerHTML = '';
  r.matches.forEach((m, k) => {
    const b = document.createElement('button'); b.setAttribute('aria-pressed', String(k === 0));
    b.setAttribute('aria-label', `Letra ${m.sample.label}, similaridade ${fmt(m.score)}`);
    const cv = document.createElement('canvas'); cv.width = 112; cv.height = 112;
    drawPair(cv, m, 64, { dx: m.dx, dy: m.dy, g: m.gain, sc: 1 }, 'cores');
    const l = document.createElement('span'); l.className = 'sl'; l.textContent = `${m.sample.label} · ${fmt(m.score, 0)}`;
    b.append(cv, l);
    b.addEventListener('click', () => { strip.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); selectMatch(k); });
    strip.append(b);
  });
  selectMatch(0);
}
function selectMatch(k) {
  S.cmp.match = k;
  const m = currentMatch(); if (!m) return;
  const rr = S.cmp.results[S.cmp.row];
  $('detailMeta').textContent = `${S.cmp.sample} × ${rr.group}` + (m.ref.g && m.ref.g.cat ? ` · letra “${m.ref.label}” do catálogo ${m.ref.g.cat}, p. ${m.ref.g.page}` : '');
  const o = S.cmp.ov; o.dx = 0; o.dy = 0; o.sc = 100; o.g = 0;
  syncOvInputs(); drawOverlay();
}
const currentMatch = () => { const r = S.cmp.results && S.cmp.results[S.cmp.row]; return r && r.matches[S.cmp.match]; };
function syncOvInputs() {
  const o = S.cmp.ov;
  $('ovDx').value = o.dx; $('oDx').textContent = o.dx;
  $('ovDy').value = o.dy; $('oDy').textContent = o.dy;
  $('ovSc').value = o.sc; $('oSc').textContent = o.sc + '%';
  $('ovG').value = o.g; $('oG').textContent = o.g > 0 ? '+' + o.g : o.g;
}
[['ovDx', 'dx'], ['ovDy', 'dy'], ['ovSc', 'sc'], ['ovG', 'g']].forEach(([id, k]) => $(id).addEventListener('input', (e) => { S.cmp.ov[k] = +e.target.value; syncOvInputs(); drawOverlay(); }));
seg('segOv', v => { S.cmp.ov.mode = v; drawOverlay(); });
$('btnOvReset').addEventListener('click', () => selectMatch(S.cmp.match));

/* compõe amostra e referência numa grade N, aplicando o encaixe automático (em unidades da grade 64) + ajustes manuais */
function composePair(m, N, auto, manual) {
  const H = N * 52 / 64, k = N / 64;
  const A0 = Core.normalize(m.sample.mask, N, H);
  const A = Core.shift(Core.grow(A0, N, N, Math.round(auto.g * k) + (manual ? manual.g : 0)), N, Math.round(auto.dx * k), Math.round(auto.dy * k));
  const B = Core.normalize(m.ref.mask, N, H, manual ? { scale: manual.sc / 100, dx: manual.dx, dy: manual.dy } : null);
  return { A, B, H };
}
function paint(cv, A, B, N, mode, dist) {
  const c = cv.getContext('2d'); const id = c.createImageData(N, N);
  const am = hexToRgb(css('--amostra')), ca = hexToRgb(css('--catalogo')), so = hexToRgb(css('--sobre')), bg = hexToRgb(css('--sheet'));
  for (let i = 0; i < N * N; i++) {
    let col = bg, a = A[i], b = B[i];
    if (mode === 'opac') {
      // como no Figma: amostra e catálogo com 50% de opacidade
      let r = bg[0], g = bg[1], bl = bg[2];
      if (a) { r = r * 0.5 + am[0] * 0.5; g = g * 0.5 + am[1] * 0.5; bl = bl * 0.5 + am[2] * 0.5; }
      if (b) { r = r * 0.5 + ca[0] * 0.5; g = g * 0.5 + ca[1] * 0.5; bl = bl * 0.5 + ca[2] * 0.5; }
      col = [r, g, bl];
    } else if (mode === 'mapa' && dist) {
      if (a && b) col = mix(bg, so, 0.28);
      else if (a) col = mix(bg, am, Math.min(1, 0.25 + dist.B[i] / (N * 0.06)));
      else if (b) col = mix(bg, ca, Math.min(1, 0.25 + dist.A[i] / (N * 0.06)));
    } else {
      if (a && b) col = so; else if (a) col = am; else if (b) col = ca;
    }
    id.data[i * 4] = col[0]; id.data[i * 4 + 1] = col[1]; id.data[i * 4 + 2] = col[2]; id.data[i * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = N; tmp.height = N; tmp.getContext('2d').putImageData(id, 0, 0);
  c.imageSmoothingEnabled = false; c.clearRect(0, 0, cv.width, cv.height); c.drawImage(tmp, 0, 0, cv.width, cv.height);
}
const mix = (x, y, t) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
function drawPair(cv, m, N, auto, mode) { const { A, B } = composePair(m, N, auto, null); paint(cv, A, B, N, mode); }
function drawOverlay() {
  const m = currentMatch(); if (!m) return;
  const N = 256, o = S.cmp.ov;
  const { A, B, H } = composePair(m, N, { dx: m.dx, dy: m.dy, g: m.gain }, o);
  const met = Core.metrics(A, B, N, H);
  const dist = o.mode === 'mapa' ? { A: Core.edt(A, N, N), B: Core.edt(B, N, N) } : null;
  paint($('cvOv'), A, B, N, o.mode, dist);
  $('mScore').textContent = fmt(met.score); $('mIou').textContent = fmt(met.iou, 3);
  $('mCh').textContent = fmt(met.chamferPct) + '%'; $('mHd').textContent = fmt(met.hd95Pct) + '%';
}
$('btnOvPng').addEventListener('click', async () => {
  const m = currentMatch(); if (!m) return;
  const r = S.cmp.results[S.cmp.row];
  const W = 1100, Hh = 520, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, W, Hh);
  const N = 256, o = S.cmp.ov;
  const { A, B } = composePair(m, N, { dx: m.dx, dy: m.dy, g: m.gain }, o);
  const blank = new Uint8Array(N * N);
  const panes = [[A, blank, 'amostra'], [blank, B, 'catálogo'], [A, B, 'sobreposição']];
  const colors = { am: '#c93a73', ca: '#3556d4', so: '#6537b0' };
  panes.forEach(([a, b, label], i) => {
    const x = 30 + i * 360, y = 60, s = 330;
    const id = c.createImageData(N, N);
    for (let k = 0; k < N * N; k++) {
      let col = [255, 255, 255];
      if (a[k] && b[k]) col = hexToRgb(colors.so); else if (a[k]) col = hexToRgb(colors.am); else if (b[k]) col = hexToRgb(colors.ca);
      id.data[k * 4] = col[0]; id.data[k * 4 + 1] = col[1]; id.data[k * 4 + 2] = col[2]; id.data[k * 4 + 3] = 255;
    }
    const t = document.createElement('canvas'); t.width = N; t.height = N; t.getContext('2d').putImageData(id, 0, 0);
    c.imageSmoothingEnabled = false; c.drawImage(t, x, y, s, s);
    c.strokeStyle = '#bbb'; c.strokeRect(x + 0.5, y + 0.5, s, s);
    c.fillStyle = '#333'; c.font = '600 15px "Host Grotesk", Arial'; c.fillText(label, x, y + s + 26);
  });
  c.fillStyle = '#111'; c.font = '700 18px "Host Grotesk", Arial';
  c.fillText(`“${m.sample.label}” · ${S.cmp.sample} × ${r.group}`, 30, 36);
  c.fillStyle = '#555'; c.font = '13px "Host Grotesk", Arial, sans-serif';
  c.fillText(`Similaridade ${$('mScore').textContent} · IoU ${$('mIou').textContent} · Chamfer ${$('mCh').textContent} · HD95 ${$('mHd').textContent}`, 30, 500);
  saveFile(`sobreposicao-${slug(m.sample.label)}-${slug(r.group)}.png`, await canvasBlob(cv));
});

/* =================================================================
   dados, exemplos e início
   ================================================================= */
function onGlyphs() {
  const real = S.glyphs.length;
  // listas de sugestões coerentes com o acervo
  const fill = (id, vals) => { const dl = $(id); dl.innerHTML = ''; [...new Set(vals.filter(Boolean))].sort().forEach(v => { const o = document.createElement('option'); o.value = v; dl.append(o); }); };
  fill('dlArt', S.glyphs.map(g => g.artefact)); fill('dlCat', S.glyphs.map(g => g.catalog)); fill('dlFam', S.glyphs.map(g => g.family));
  if (!$('tab-acervo').hidden) renderGroups();
  if (!$('tab-comparar').hidden) fillSampleSelect();
  void real;
}

/* =================================================================
   CATÁLOGO FUNTIMOD (referência embutida)
   ================================================================= */
const pad3 = (n) => String(n).padStart(3, '0');
function rangeText(ps) {
  const out = []; let a = ps[0], b = ps[0];
  for (let i = 1; i <= ps.length; i++) { if (ps[i] === b + 1) b = ps[i]; else { out.push(a === b ? `${a}` : `${a}–${b}`); a = b = ps[i]; } }
  return out.join(', ');
}
function pagesText(info) { return Object.keys(info.pages).sort().map(c => `cat. ${c} p. ${rangeText(info.pages[c])}`).join(' · '); }
function pageLinks(info) {
  const box = document.createElement('div'); box.className = 'pagelinks';
  for (const c of Object.keys(info.pages).sort()) for (const p of info.pages[c]) box.append(button(`cat. ${c} · p. ${p}`, 'btn small', () => openPage(info, c, p)));
  return box;
}
function openPage(info, cat, page) {
  const list = []; for (const c of Object.keys(info.pages).sort()) for (const p of info.pages[c]) list.push([c, p]);
  let idx = list.findIndex(([c, p]) => c === cat && p === page);
  const body = document.createElement('div'); body.className = 'side pageview';
  const img = document.createElement('img'); img.alt = '';
  const row = document.createElement('div'); row.className = 'row';
  const prev = button('← Página anterior', 'btn small', () => { idx = (idx - 1 + list.length) % list.length; show(); });
  const next = button('Próxima página →', 'btn small', () => { idx = (idx + 1) % list.length; show(); });
  const lab = document.createElement('span'); lab.className = 'hint mono';
  row.append(prev, next, lab); prev.disabled = next.disabled = list.length < 2;
  const show = () => { const [c, p] = list[idx]; img.src = `thumbs/c${c}-${pad3(p)}.jpg`; img.alt = `${info.name}, catálogo ${c}, página ${p} do PDF`; lab.textContent = `catálogo ${c} · página ${p} do PDF`; };
  body.append(row, img); show();
  openModal(info.name, body);
}
async function loadCatalog() {
  try {
    const res = await fetch('funtimod.json'); if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    S.fams = data.families;
    S.builtin = data.glyphs.map((x, i) => ({ id: 'f' + i, builtin: true, kind: 'ref', source: 'funtimod', catalog: 'Funtimod', family: data.families[x[0]].name, label: x[1], w: x[2], h: x[3], bits: x[4], size: x[5], cat: x[6], page: x[7], fi: x[0] }));
    S.famGroups = S.fams.map((f, i) => ({ key: f.name, kind: 'ref', builtin: true, info: f, source: 'funtimod', items: S.builtin.filter(g => g.fi === i) })).filter(g => g.items.length);
    $('catMeta').textContent = `${S.famGroups.length} famílias · ${S.builtin.length.toLocaleString('pt-BR')} glifos`;
    $('catSummary').textContent = `${S.fams.length} famílias nos dois catálogos · ${S.famGroups.length} com glifos extraídos · ${S.builtin.length.toLocaleString('pt-BR')} glifos`;
    if (!$('tab-catalogo').hidden) renderCatalog();
    return true;
  } catch (e) {
    $('catMeta').textContent = 'catálogo indisponível';
    $('catList').innerHTML = '<p class="hint">Não consegui carregar o catálogo da Funtimod. Verifique a conexão e recarregue a página.</p>';
    toast('Não consegui carregar o catálogo da Funtimod. Recarregue a página.');
    return false;
  }
}
$('catSearch').addEventListener('input', () => renderCatalog());
const SPECIMEN = [...'Hamburgefonstiv'];
// seções do índice: agrupadas pelo nome da família (não por classificação estilística, para não arriscar rótulos errados)
const CAT_SECTIONS = [['Grotescas', /^Grotesca/], ['Kabel', /^Kabel/], ['Memphis', /^Memphis/], ['Mondial', /^Mondial/], ['Antigas', /Antiga/], ['Excelsior', /^Excelsior/], ['Garamond', /^Garamond/]];
const secOf = (name) => { const s = CAT_SECTIONS.find(([, re]) => re.test(name)); return s ? s[0] : 'Outras famílias'; };
function catSkeleton() {
  const sec = document.createElement('div'); sec.className = 'catsec skel'; sec.setAttribute('aria-busy', 'true'); sec.setAttribute('aria-label', 'Carregando catálogo');
  for (let i = 0; i < 7; i++) { const ln = document.createElement('div'); ln.className = 'ln'; ln.innerHTML = '<i class="t"></i><i class="g"></i><i class="m"></i>'; sec.append(ln); }
  return sec;
}
function renderCatalog() {
  const host = $('catList'); if (!S.fams.length) { host.innerHTML = ''; host.append(catSkeleton()); return; }
  const q = $('catSearch').value.trim().toLowerCase();
  host.innerHTML = '';
  const color = css('--catalogo');
  const order = CAT_SECTIONS.map(x => x[0]).concat('Outras famílias');
  const bySec = new Map(order.map(k => [k, []]));
  S.fams.forEach((f) => { if (q && !f.name.toLowerCase().includes(q)) return; bySec.get(secOf(f.name)).push(f); });
  const used = order.filter(k => bySec.get(k).length);
  if (!used.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `Nenhuma família com “${$('catSearch').value.trim()}” no nome.`; host.append(p); return; }
  if (!q) {
    const nav = document.createElement('nav'); nav.className = 'catjump'; nav.setAttribute('aria-label', 'Ir para a seção');
    used.forEach(k => { const a = document.createElement('a'); a.href = '#cs-' + slug(k); a.innerHTML = `${k}<small>${bySec.get(k).length}</small>`; a.addEventListener('click', (e) => { e.preventDefault(); $('cs-' + slug(k)).scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }); nav.append(a); });
    host.append(nav);
  }
  used.forEach(k => {
    const sec = document.createElement('section'); sec.className = 'catsec'; sec.id = 'cs-' + slug(k);
    const h = document.createElement('h2'); h.textContent = k; const sm = document.createElement('small'); sm.textContent = bySec.get(k).length === 1 ? '1 família' : `${bySec.get(k).length} famílias`; h.append(sm); sec.append(h);
    bySec.get(k).forEach(f => sec.append(famRow(f, color)));
    host.append(sec);
  });
}
function famRow(f, color) {
    const g = S.famGroups.find(x => x.info === f);
    const det = document.createElement('details'); det.className = 'fam';
    const sum = document.createElement('summary');
    const h = document.createElement('h3'); h.textContent = f.name;
    const sp = document.createElement('div'); sp.className = 'specimen'; sp.setAttribute('aria-hidden', 'true');
    if (g) {
      const bl = byLabel(g.items);
      let n = 0; for (const ch of SPECIMEN) { const it = bl.get(ch); if (!it || n >= 10) continue; n++; const cv = glyphCanvas(maskOf(it[0]), color, 30); cv.style.width = '26px'; cv.style.height = '32px'; sp.append(cv); }
      if (!n) for (const [ch, it] of [...bl].slice(0, 8)) sp.append(glyphCanvas(maskOf(it[0]), color, 30));
    }
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${g ? new Set(g.items.map(x => x.label)).size + ' caracteres' : 'sem glifos extraídos'} · ${pagesText(f)}`;
    sum.append(h, sp, meta); det.append(sum);
    det.addEventListener('toggle', () => {
      const anim = () => { const b = det.querySelector('.body'); if (b && det.open && !reduceMotion()) b.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE }); };
      if (!det.open) return;
      if (det.dataset.built) { anim(); return; }
      det.dataset.built = '1'; requestAnimationFrame(anim);
      const body = document.createElement('div'); body.className = 'body';
      if (g) body.append(alphaTable(g));
      else { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'O OCR não conseguiu separar letras desta família com segurança (tipos muito ornamentados, cursivos ou espacejados). Use as páginas abaixo para comparar visualmente.'; body.append(p); }
      const th = document.createElement('div'); th.className = 'thumbs';
      for (const c of Object.keys(f.pages).sort()) for (const p of f.pages[c]) {
        const b = document.createElement('button'); const img = document.createElement('img'); img.loading = 'lazy'; img.src = `thumbs/c${c}-${pad3(p)}.jpg`; img.alt = `Catálogo ${c}, página ${p}`;
        const t = document.createElement('span'); t.textContent = `cat. ${c} · p. ${p}`;
        b.append(img, t); b.addEventListener('click', () => openPage(f, c, p)); th.append(b);
      }
      body.append(th); det.append(body);
    });
    return det;
}

/* identificar o recorte atual sem salvar */
function buildTemp() {
  if (!S.proc) return 0;
  S.temp = [];
  S.boxes.forEach((b, i) => { if (!b.label) return; let m = currentMask(b); if (!m) return; m = Core.shrinkMask(m, 128); S.temp.push({ id: 't' + i, temp: true, kind: 'sample', label: b.label, mask: m, w: m.w, h: m.h }); });
  return S.temp.length;
}
async function identifyNow(go = true) {
  if (!S.famGroups.length) { toast('O catálogo ainda está carregando. Tente de novo em instantes.'); return; }
  if (!buildTemp()) { toast('Detecte e rotule pelo menos um caractere antes de identificar.'); return; }
  S.wantSample = TEMP_KEY; fillSampleSelect(); $('selSample').value = TEMP_KEY;
  if (go) showTab('comparar');
  await runRank();
}
$('btnIdentify').addEventListener('click', () => identifyNow(true));

const EXAMPLE_TEXT = 'ALEGRIA! ALEGRIA biriba boys';
async function loadExample() {
  try {
    const img = new Image(); img.src = 'exemplo-alegria.jpg'; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext('2d').drawImage(img, 0, 0);
    setImage(cv, 'exemplo: contracapa de “Alegria! Alegria!” (Rozenblit, 1967)');
    runProcess();
    const P = S.proc;
    const bx = Core.segment(P.bin, P.w, P.h, Math.max(2, P.minA));
    // o exemplo tem manchas de papel: descarta caixas muito menores que a altura das letras
    const hs = bx.map(b => b.y1 - b.y0).sort((x, y) => x - y), med = hs[hs.length >> 1] || 1;
    S.boxes = bx.filter(b => (b.y1 - b.y0) >= med * 0.35).map(b => ({ ...fromProc(b), label: '' }));
    const chars = [...EXAMPLE_TEXT.replace(/\s/g, '')];
    if (S.boxes.length === chars.length) S.boxes.forEach((b, i) => b.label = chars[i]);
    S.sel = S.boxes.length ? 0 : -1;
    $('seqInput').value = EXAMPLE_TEXT;
    drawBin();
    return S.boxes.length === chars.length;
  } catch (e) { return false; }
}

async function init() {
  $('inkSwatch').style.background = `rgb(${S.p.ink.join(',')})`;
  let tab = 'recorte'; try { tab = localStorage.getItem('bt-tab') || 'recorte'; } catch (e) {}
  showTab(['recorte', 'comparar', 'catalogo', 'acervo'].includes(tab) ? tab : 'recorte');
  Store.init();
  const [okCat, okEx] = await Promise.all([loadCatalog(), loadExample()]);
  if (!okEx && !S.img) $('srcViewer').insertAdjacentHTML('afterbegin', '<div class="empty" id="srcEmpty">Abra a foto de uma capa ou de um impresso para começar.</div>');
  onGlyphs(); fillSampleSelect();
  if (okCat && okEx) await identifyNow(false);
}
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const redraw = () => { drawSrc(); drawBin(); if (!$('tab-acervo').hidden) renderGroups(); if (!$('tab-catalogo').hidden) renderCatalog(); if (S.cmp.results) { selectRow(S.cmp.row); } };
mq.addEventListener && mq.addEventListener('change', redraw);
new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
/* ---------- modo claro / escuro ---------- */
const themeBtn = $('themeBtn');
const effectiveTheme = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || t === 'light' ? t : (mq.matches ? 'dark' : 'light'); };
function syncThemeBtn() {
  const t = effectiveTheme(); themeBtn.dataset.mode = t;
  const next = t === 'dark' ? 'claro' : 'escuro';
  themeBtn.setAttribute('aria-label', `Mudar para o modo ${next}`); themeBtn.title = `Modo ${next}`;
}
function setTheme(t, save) {
  const root = document.documentElement;
  // troca de brilho sem salto: cores fazem a transição por ~0,36 s
  if (!reduceMotion()) { root.classList.add('theme-anim'); clearTimeout(setTheme.t); setTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 420); }
  root.dataset.theme = t;
  if (save) { try { localStorage.setItem('bt-theme', t); } catch (e) {} }
  syncThemeBtn();
}
themeBtn.addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true));
try { const saved = localStorage.getItem('bt-theme'); if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved; } catch (e) {}
mq.addEventListener && mq.addEventListener('change', syncThemeBtn);
syncThemeBtn();
window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(drawBin, 150); });
// borda de rolagem: a sombra sob a barra só aparece quando há conteúdo passando por baixo
const topBar = document.querySelector('.top');
const onScroll = () => topBar.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
init();
})();
