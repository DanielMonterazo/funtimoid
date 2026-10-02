/* ===== Núcleo de processamento (sem DOM) ===== */
const Core = (() => {
  // ---------- tons de cinza ----------
  function toGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const a = rgba[j + 3] / 255;
      // fundo transparente vira papel branco
      g[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a);
    }
    return g;
  }
  // distância à cor da tinta: tinta = escuro (0), resto = claro
  function colorDistGray(rgba, w, h, ink) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const dr = rgba[j] - ink[0], dg = rgba[j + 1] - ink[1], db = rgba[j + 2] - ink[2];
      g[i] = Math.min(255, Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.6);
    }
    return g;
  }

  // ---------- imagens integrais ----------
  function integrals(g, w, h) {
    const W = w + 1;
    const s = new Float64Array(W * (h + 1)), s2 = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0, rs2 = 0;
      for (let x = 0; x < w; x++) {
        const v = g[y * w + x];
        rs += v; rs2 += v * v;
        s[(y + 1) * W + x + 1] = s[y * W + x + 1] + rs;
        s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + rs2;
      }
    }
    return { s, s2, W };
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    const total = g.length;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /** limiares de Otsu para k classes (histograma de 64 faixas, busca exaustiva) */
  function multiOtsu(g, k) {
    const B = 64, hist = new Float64Array(B);
    for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(B - 1, (g[i] / 4) | 0))]++;
    const P = new Float64Array(B + 1), S = new Float64Array(B + 1);
    for (let i = 0; i < B; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
    const term = (a, b) => { const w = P[b] - P[a]; if (w <= 0) return 0; const m = S[b] - S[a]; return m * m / w; };
    let best = -1, bestT = null; const cur = [];
    const rec = (start, left) => {
      if (left === 0) {
        let v = 0, prev = 0; for (const c of cur) { v += term(prev, c); prev = c; } v += term(prev, B);
        if (v > best) { best = v; bestT = cur.slice(); } return;
      }
      for (let c = start; c <= B - left; c++) { cur.push(c); rec(c + 1, left - 1); cur.pop(); }
    };
    rec(1, k - 1);
    return bestT.map(c => c * 4 - 0.5);
  }
  /** Binariza: devolve Uint8Array com tinta = 1.
   * opts: {method:'otsu'|'sauvola'|'manual', thr, win, k, polarity:'auto'|'dark'|'light'} */
  function binarize(g, w, h, opts) {
    const out = new Uint8Array(w * h);
    let gg = g;
    if (opts.polarity === 'light') { gg = new Float32Array(g.length); for (let i = 0; i < g.length; i++) gg[i] = 255 - g[i]; }
    if (opts.method === 'multi') {
      // Otsu multinível: separa o recorte em k faixas de tom e fica com a faixa extrema (a do texto)
      const t = multiOtsu(gg, Math.max(2, Math.min(5, opts.levels || 3)));
      let nd = 0, nl = 0;
      for (let i = 0; i < gg.length; i++) { if (gg[i] <= t[0]) nd++; if (gg[i] > t[t.length - 1]) nl++; }
      const lightInk = opts.polarity === 'auto' ? nl < nd : false; // 'light' já veio invertido
      for (let i = 0; i < gg.length; i++) out[i] = lightInk ? (gg[i] > t[t.length - 1] ? 1 : 0) : (gg[i] <= t[0] ? 1 : 0);
      return out;
    }
    if (opts.method === 'sauvola') {
      const { s, s2, W } = integrals(gg, w, h);
      const r = Math.max(2, (opts.win | 0) >> 1), k = opts.k ?? 0.3, R = 128;
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          const n = (x1 - x0) * (y1 - y0);
          const sum = s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
          const sq = s2[y1 * W + x1] - s2[y0 * W + x1] - s2[y1 * W + x0] + s2[y0 * W + x0];
          const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
          const t = m * (1 + k * (sd / R - 1));
          out[y * w + x] = gg[y * w + x] < t ? 1 : 0;
        }
      }
    } else {
      const t = opts.method === 'manual' ? opts.thr : otsu(gg);
      for (let i = 0; i < gg.length; i++) out[i] = gg[i] <= t ? 1 : 0;
    }
    if (opts.polarity === 'auto') {
      let ink = 0; for (let i = 0; i < out.length; i++) ink += out[i];
      if (ink > out.length * 0.5) for (let i = 0; i < out.length; i++) out[i] ^= 1;
    }
    return out;
  }

  // ---------- morfologia (quadrado separável) ----------
  function dilate(b, w, h, r) {
    if (r <= 0) return b;
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let d = -r; d <= r && !v; d++) { const xx = x + d; if (xx >= 0 && xx < w && b[row + xx]) v = 1; }
        t[row + x] = v;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) { const yy = y + d; if (yy >= 0 && yy < h && t[yy * w + x]) v = 1; }
      o[y * w + x] = v;
    }
    return o;
  }
  function invert(b) { const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i] ^ 1; return o; }
  function erode(b, w, h, r) { return r <= 0 ? b : invert(dilate(invert(b), w, h, r)); }
  function close(b, w, h, r) { return r <= 0 ? b : erode(dilate(b, w, h, r), w, h, r); }
  function grow(b, w, h, g) { return g > 0 ? dilate(b, w, h, g) : g < 0 ? erode(b, w, h, -g) : b; }

  // ---------- componentes conexos (8-vizinhança) ----------
  function components(b, w, h) {
    const lab = new Int32Array(w * h), comps = [];
    const stack = new Int32Array(w * h);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      if (!b[i] || lab[i]) continue;
      n++;
      let sp = 0; stack[sp++] = i; lab[i] = n;
      let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
      while (sp) {
        const p = stack[--sp], px = p % w, py = (p / w) | 0;
        area++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (b[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
          }
        }
      }
      comps.push({ id: n, x0, y0, x1, y1, area });
    }
    return { lab, comps };
  }

  function removeSmall(b, w, h, minArea) {
    if (minArea <= 1) return b;
    const { lab, comps } = components(b, w, h);
    const keep = new Uint8Array(comps.length + 1);
    for (const c of comps) keep[c.id] = c.area >= minArea ? 1 : 0;
    const o = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) o[i] = lab[i] && keep[lab[i]] ? 1 : 0;
    return o;
  }

  /** Remove fios retos (cordas, filetes, riscos) mais longos que L px. vertical=true para fios verticais.
   * tol: tolerância lateral em px para fios levemente inclinados. */
  function removeLines(b, w, h, L, vertical, tol = 2) {
    const out = new Uint8Array(b);
    if (vertical) {
      for (let x = 0; x < w; x++) {
        let y = 0;
        while (y < h) {
          const on = (yy) => { for (let d = -tol; d <= tol; d++) { const xx = x + d; if (xx >= 0 && xx < w && b[yy * w + xx]) return true; } return false; };
          if (on(y)) { const y0 = y; while (y < h && on(y)) y++; if (y - y0 >= L) for (let k = y0; k < y; k++) out[k * w + x] = 0; }
          else y++;
        }
      }
    } else {
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const on = (xx) => { for (let d = -tol; d <= tol; d++) { const yy = y + d; if (yy >= 0 && yy < h && b[yy * w + xx]) return true; } return false; };
          if (on(x)) { const x0 = x; while (x < w && on(x)) x++; if (x - x0 >= L) for (let k = x0; k < x; k++) out[y * w + k] = 0; }
          else x++;
        }
      }
    }
    return out;
  }
  /** Escala do texto num recorte binário: espessura típica do traço (px) e área de uma letra típica (px²) */
  function textScale(b, w, h) {
    const { comps } = components(b, w, h);
    const big = comps.filter(c => c.area >= 12).sort((x, y) => y.area - x.area);
    if (!big.length) return { stroke: 2, letterArea: 100 };
    const top = big.filter(c => c.area >= big[0].area * 0.05);
    const letterArea = top[top.length >> 1].area;
    let ink = 0, edge = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!b[i]) continue; ink++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !b[i - 1] || !b[i + 1] || !b[i - w] || !b[i + w]) edge++;
    }
    return { stroke: Math.max(1, edge ? 2 * ink / edge : 2), letterArea };
  }
  /** Detecta caracteres: componentes + fusão de pingos/acentos + ordem de leitura */
  function segment(b, w, h, minArea) {
    let { comps } = components(b, w, h);
    comps = comps.filter(c => c.area >= minArea);
    if (!comps.length) return [];
    const hs = comps.map(c => c.y1 - c.y0 + 1).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1];
    const areas = comps.map(c => c.area).sort((a, b) => a - b);
    const medA = areas[areas.length >> 1];
    // pequenos (pingos, acentos, til) se juntam ao maior componente logo abaixo/acima
    const small = comps.filter(c => c.area < medA * 0.35);
    const big = comps.filter(c => c.area >= medA * 0.35);
    const boxes = big.map(c => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }));
    for (const s of small) {
      const sw = s.x1 - s.x0 + 1;
      let best = -1, bestGap = Infinity;
      boxes.forEach((bx, i) => {
        const ov = Math.min(s.x1, bx.x1) - Math.max(s.x0, bx.x0) + 1;
        if (ov < sw * 0.5) return;
        const gap = s.y1 < bx.y0 ? bx.y0 - s.y1 : s.y0 > bx.y1 ? s.y0 - bx.y1 : 0;
        if (gap < medH * 0.6 && gap < bestGap) { bestGap = gap; best = i; }
      });
      if (best >= 0) {
        const bx = boxes[best];
        bx.x0 = Math.min(bx.x0, s.x0); bx.y0 = Math.min(bx.y0, s.y0);
        bx.x1 = Math.max(bx.x1, s.x1); bx.y1 = Math.max(bx.y1, s.y1);
      } else boxes.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 });
    }
    return readingOrder(boxes, medH);
  }

  function readingOrder(boxes, medH) {
    if (!medH) { const hs = boxes.map(b => b.y1 - b.y0 + 1).sort((a, b) => a - b); medH = hs[hs.length >> 1] || 1; }
    const sorted = boxes.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const b of sorted) {
      const cy = (b.y0 + b.y1) / 2;
      let line = lines.find(l => Math.abs(l.cy - cy) < medH * 0.6);
      if (!line) { line = { cy, items: [] }; lines.push(line); }
      line.items.push(b);
      line.cy = line.items.reduce((s, i) => s + (i.y0 + i.y1) / 2, 0) / line.items.length;
    }
    lines.sort((a, b) => a.cy - b.cy);
    return lines.flatMap(l => l.items.sort((a, b) => a.x0 - b.x0));
  }

  // ---------- máscaras ----------
  /** recorta a tinta dentro da caixa, justa ao desenho */
  function extractMask(b, w, h, box) {
    let x0 = box.x1, y0 = box.y1, x1 = box.x0 - 1, y1 = box.y0 - 1;
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++)
      if (b[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < x0) return null;
    const mw = x1 - x0 + 1, mh = y1 - y0 + 1, d = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) d[y * mw + x] = b[(y + y0) * w + x + x0];
    return { w: mw, h: mh, data: d };
  }
  /** reduz para no máximo maxDim (média por área + limiar 0,5) */
  function shrinkMask(m, maxDim) {
    const s = Math.min(1, maxDim / Math.max(m.w, m.h));
    if (s >= 1) return m;
    const W = Math.max(1, Math.round(m.w * s)), H = Math.max(1, Math.round(m.h * s));
    const d = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx0 = Math.floor(x / s), sx1 = Math.min(m.w, Math.ceil((x + 1) / s));
      const sy0 = Math.floor(y / s), sy1 = Math.min(m.h, Math.ceil((y + 1) / s));
      let a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { a += m.data[yy * m.w + xx]; n++; }
      d[y * W + x] = a * 2 >= n ? 1 : 0;
    }
    return { w: W, h: H, data: d };
  }
  function packMask(m) {
    const bytes = new Uint8Array(Math.ceil(m.data.length / 8));
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) bytes[i >> 3] |= 1 << (i & 7);
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unpackMask(w, h, b64) {
    const s = atob(b64), d = new Uint8Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
    return { w, h, data: d };
  }

  /** Normaliza numa grade N×N: altura do desenho = H (limitado pela largura), centro da caixa no centro.
   * t = {scale, dx, dy} ajustes manuais em pixels da grade */
  function normalize(m, N, H, t) {
    t = t || {};
    let s = H / m.h;
    if (m.w * s > N * 0.92) s = (N * 0.92) / m.w;
    s *= t.scale || 1;
    const cx = N / 2 + (t.dx || 0), cy = N / 2 + (t.dy || 0);
    const out = new Uint8Array(N * N);
    const mx = m.w / 2, my = m.h / 2;
    for (let y = 0; y < N; y++) {
      const sy = (y + 0.5 - cy) / s + my - 0.5;
      if (sy < -1 || sy > m.h) continue;
      for (let x = 0; x < N; x++) {
        const sx = (x + 0.5 - cx) / s + mx - 0.5;
        if (sx < -1 || sx > m.w) continue;
        // bilinear sobre a máscara binária
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        const v = (xx, yy) => (xx >= 0 && yy >= 0 && xx < m.w && yy < m.h) ? m.data[yy * m.w + xx] : 0;
        const val = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
        out[y * N + x] = val >= 0.5 ? 1 : 0;
      }
    }
    return out;
  }
  function shift(b, N, dx, dy) {
    if (!dx && !dy) return b;
    const o = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      const sy = y - dy; if (sy < 0 || sy >= N) continue;
      for (let x = 0; x < N; x++) { const sx = x - dx; if (sx >= 0 && sx < N) o[y * N + x] = b[sy * N + sx]; }
    }
    return o;
  }

  // ---------- transformada de distância euclidiana (Felzenszwalb) ----------
  function edt1(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  }
  function edt(feat, w, h) {
    const INF = 1e20, g = new Float64Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = feat[i] ? 0 : INF;
    const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1(f, w, d, v, z);
      for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
    }
    return g;
  }
  function edges(b, N) {
    const e = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (!b[i]) continue;
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1 || !b[i - 1] || !b[i + 1] || !b[i - N] || !b[i + N]) e[i] = 1;
    }
    return e;
  }

  function iou(a, b) {
    let i = 0, u = 0;
    for (let k = 0; k < a.length; k++) { const x = a[k], y = b[k]; i += x & y; u += x | y; }
    return u ? i / u : 0;
  }

  /** métricas completas entre duas grades já alinhadas */
  function metrics(a, b, N, H) {
    const ea = edges(a, N), eb = edges(b, N);
    const da = edt(ea, N, N), db = edt(eb, N, N);
    const ds = [];
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      if (ea[i]) { const d = db[i]; if (d < 1e9) { sa += d; na++; ds.push(d); } }
      if (eb[i]) { const d = da[i]; if (d < 1e9) { sb += d; nb++; ds.push(d); } }
    }
    ds.sort((x, y) => x - y);
    const chamfer = ((na ? sa / na : N) + (nb ? sb / nb : N)) / 2;
    const hd95 = ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))] : N;
    const IoU = iou(a, b);
    const chamferPct = (chamfer / H) * 100, hd95Pct = (hd95 / H) * 100;
    return { iou: IoU, chamferPct, hd95Pct, score: similarity(IoU, chamferPct), distA: da, distB: db };
  }
  function similarity(IoU, chamferPct) { return 100 * (0.55 * IoU + 0.45 * Math.exp(-chamferPct / 4)); }

  const N0 = 64, H0 = 52;
  // cache das grades normalizadas por máscara (as referências se repetem em todas as comparações)
  const cache64 = new WeakMap(), cache32 = new WeakMap();
  function norm64(m) { let g = cache64.get(m); if (!g) { g = normalize(m, N0, H0); cache64.set(m, g); } return g; }
  function norm32(m) { let g = cache32.get(m); if (!g) { g = normalize(m, 32, 26); cache32.set(m, g); } return g; }
  /** espessura média do traço ≈ 2·área/perímetro, em fração da altura normalizada */
  function stroke(b, N, H) {
    let a = 0, e = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (!b[i]) continue; a++;
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1 || !b[i - 1] || !b[i + 1] || !b[i - N] || !b[i + N]) e++;
    }
    return e ? (2 * a / e) / H : 0;
  }
  /** comparação rápida, sem busca de encaixe: serve para pré-filtrar famílias */
  function coarse(ma, mb) { return iou(norm32(ma), norm32(mb)); }
  /** Compara amostra (a) com referência (b): busca deslocamento e compensação de ganho de tinta */
  function compare(ma, mb, opts) {
    opts = opts || {};
    const range = opts.shift ?? 3, gains = opts.gains ?? [-1, 0, 1];
    const B = norm64(mb);
    const A0 = norm64(ma);
    let best = { iou: -1 };
    for (const g of gains) {
      const A = grow(A0, N0, N0, g);
      for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
        const v = iouShift(A, B, N0, dx, dy);
        if (v > best.iou) best = { iou: v, g, dx, dy };
      }
    }
    const A = shift(grow(A0, N0, N0, best.g), N0, best.dx, best.dy);
    const m = metrics(A, B, N0, H0);
    const ra = ma.w / ma.h, rb = mb.w / mb.h;
    const sb = stroke(B, N0, H0);
    return { iou: m.iou, chamferPct: m.chamferPct, hd95Pct: m.hd95Pct, score: m.score, gain: best.g, dx: best.dx, dy: best.dy, aspect: ra / rb, weight: sb ? stroke(A0, N0, H0) / sb : 1 };
  }
  function iouShift(A, B, N, dx, dy) {
    let i = 0, u = 0;
    for (let y = 0; y < N; y++) {
      const sy = y - dy;
      for (let x = 0; x < N; x++) {
        const sx = x - dx;
        const a = (sy >= 0 && sy < N && sx >= 0 && sx < N) ? A[sy * N + sx] : 0;
        const b = B[y * N + x];
        i += a & b; u += a | b;
      }
    }
    return u ? i / u : 0;
  }

  // letras cuja maiúscula e minúscula têm o mesmo desenho: o OCR e quem rotula costumam trocar a caixa
  const AMB = new Set([...'cosuvwxzCOSUVWXZ']);
  function altLabels(l) { if (!AMB.has(l)) return [l]; const o = l === l.toUpperCase() ? l.toLowerCase() : l.toUpperCase(); return [l, o]; }
  /** Ranking: samples/refs = [{label, mask, group}] */
  function rank(samples, refs) {
    const byGroup = new Map();
    for (const r of refs) { if (!byGroup.has(r.group)) byGroup.set(r.group, []); byGroup.get(r.group).push(r); }
    const labels = new Set(samples.map(s => s.label));
    const out = [];
    for (const [group, list] of byGroup) {
      const byLabel = new Map();
      for (const r of list) { if (!byLabel.has(r.label)) byLabel.set(r.label, []); byLabel.get(r.label).push(r); }
      const matches = [];
      for (const s of samples) {
        const cands = altLabels(s.label).flatMap(l => byLabel.get(l) || []); if (!cands.length) continue;
        let best = null;
        for (const c of cands) {
          const res = compare(s.mask, c.mask);
          if (!best || res.score > best.res.score) best = { ref: c, res };
        }
        matches.push({ sample: s, ref: best.ref, ...best.res });
      }
      const covered = new Set(matches.map(m => m.sample.label));
      const mean = (k) => matches.length ? matches.reduce((a, m) => a + m[k], 0) / matches.length : 0;
      out.push({
        group, matches, n: matches.length,
        coverage: labels.size ? covered.size / labels.size : 0,
        coveredLabels: covered.size, totalLabels: labels.size,
        score: mean('score'), iou: mean('iou'), chamferPct: mean('chamferPct'), hd95Pct: mean('hd95Pct'),
        aspect: matches.length ? Math.exp(matches.reduce((a, m) => a + Math.log(m.aspect), 0) / matches.length) : 1,
        weight: matches.length ? Math.exp(matches.reduce((a, m) => a + Math.log(m.weight || 1), 0) / matches.length) : 1,
      });
    }
    out.sort((a, b) => (b.n ? b.score : -1) - (a.n ? a.score : -1));
    return out;
  }

  return { toGray, colorDistGray, otsu, binarize, dilate, erode, close, grow, components, removeSmall, segment, readingOrder,
    extractMask, shrinkMask, packMask, unpackMask, normalize, shift, edt, edges, iou, metrics, compare, rank, similarity, coarse, stroke, altLabels, textScale, removeLines, multiOtsu };
})();
if (typeof module !== 'undefined') module.exports = Core;
