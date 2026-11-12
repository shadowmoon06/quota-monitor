// @ts-check
/* Pixel Quota Tree renderer. Everything is drawn on a 128x160 canvas and scaled up with
 * nearest-neighbour so every logical pixel is a crisp square. */
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const W = 128, H = 160, GROUND = H - 22, CX = W / 2;
  const FPS = 12;

  /** @type {HTMLCanvasElement} */
  const canvas = /** @type {any} */ (document.getElementById('tree'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.imageSmoothingEnabled = false;

  // leaf: [highlight, main, shade, outline]   bark: [light, mid, dark]
  const PALETTES = {
    claude: { leaf: ['#ffd2ad', '#f0895a', '#c25a32', '#7c3318'], bark: ['#a87650', '#7f5434', '#55361f'] },
    codex: { leaf: ['#c9f7a6', '#6fca4f', '#379440', '#1c5a29'], bark: ['#938676', '#6e6458', '#473f37'] },
    _0: { leaf: ['#bfe3ff', '#5aa7e8', '#2f6fb3', '#1a3f6e'], bark: ['#8a7f9e', '#665d78', '#433d50'] },
    _1: { leaf: ['#f3c6ff', '#c27be0', '#8a49a8', '#542a68'], bark: ['#9e8a7f', '#786458', '#4f4038'] },
  };
  const FLASH = '#fffbe0';
  const FRUIT = ['#fff3a0', '#ffcc33', '#d9831a', '#7a3d0a'];

  /** @param {string} id @param {number} i */
  function pal(id, i) {
    return PALETTES[id] || PALETTES['_' + (i % 2)];
  }

  // ---------- deterministic randomness ----------
  /** @param {string} s */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  /** @param {number} a */
  function mulberry(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rngFor = (/** @type {string} */ k) => mulberry(hash(k));

  /** @param {CanvasRenderingContext2D} c */
  function px(c, x, y, color) {
    c.fillStyle = color;
    c.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  // ---------- state ----------
  /** @type {any} */
  let snap = null;
  let treeKey = '';
  /** @type {{layer: HTMLCanvasElement, slots: {x:number,y:number}[], g:number} | null} */
  let tree = null;
  /** Slot index -> {agent, born} */
  /** @type {({agent:string, pi:number, born:number}|null)[]} */
  let leaves = [];
  /** @type {number[]} */
  let fruits = [];
  /** @type {{x:number,y:number,vx:number,phase:number,color:string,landed:number}[]} */
  let falling = [];
  let stress = 0; // highest quota usage 0..1+
  let firstPaint = true;

  // ---------- tree construction ----------
  /** Growth 0..1 from lifetime tokens (log scale: 10k -> 0, ~3B -> 1). */
  function growthOf(total) {
    const g = (Math.log10(total + 1) - 4) / 5.5;
    return Math.max(0, Math.min(1, g));
  }
  function stageName(g) {
    if (g < 0.08) return 'Seedling';
    if (g < 0.25) return 'Sprout';
    if (g < 0.45) return 'Sapling';
    if (g < 0.65) return 'Young tree';
    if (g < 0.85) return 'Mature tree';
    return 'Ancient tree';
  }

  /**
   * @param {number} g growth 0..1
   * @param {{id:string, pi:number, share:number}[]} shares lifetime share per agent (sum 1)
   */
  function buildTree(g, shares) {
    const layer = document.createElement('canvas');
    layer.width = W;
    layer.height = H;
    const c = /** @type {CanvasRenderingContext2D} */ (layer.getContext('2d'));
    /** @type {{x:number,y:number,r:number}[]} */
    const tips = [];
    const maxDepth = g < 0.06 ? 0 : 1 + Math.floor(g * 4.99);
    const trunkLen = 9 + g * 28;
    const trunkW = 2 + g * 7;

    const barkAt = (/** @type {number} */ f) => {
      let acc = 0;
      for (const s of shares) {
        acc += s.share;
        if (f <= acc + 1e-6) return pal(s.id, s.pi).bark;
      }
      return pal(shares[shares.length - 1].id, shares[shares.length - 1].pi).bark;
    };
    const pickBark = (/** @type {() => number} */ r) => barkAt(r());

    // Root flare
    const rr = rngFor('roots');
    for (let side = -1; side <= 1; side += 2) {
      const len = Math.round(trunkW / 2 + 2 + g * 5);
      for (let i = 0; i < len; i++) {
        const x = CX + side * (trunkW / 2 + i - 1);
        const y = GROUND - 1 + (i > len * 0.6 ? 1 : 0);
        const b = barkAt(side < 0 ? 0 : 0.999);
        px(c, x, y, b[i % 3 === 0 ? 0 : 1]);
        if (i < len - 2) px(c, x, y + 1, b[2]);
      }
      if (rr() < 0.5) px(c, CX + side * (trunkW / 2 + len), GROUND + 1, barkAt(0.5)[2]);
    }

    /**
     * @param {string} path @param {number} x @param {number} y @param {number} ang
     * @param {number} len @param {number} w @param {number} depth
     */
    function branch(path, x, y, ang, len, w, depth) {
      const r = rngFor(path);
      const ex = x + Math.cos(ang) * len;
      const ey = y + Math.sin(ang) * len;
      const w1 = Math.max(1, w * 0.68);
      const bark = depth === 0 ? null : pickBark(r);
      const steps = Math.ceil(Math.max(Math.abs(ex - x), Math.abs(ey - y))) * 2 + 1;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const cx = x + (ex - x) * t, cy = y + (ey - y) * t;
        const rad = (w + (w1 - w) * t) / 2;
        const ir = Math.max(0, Math.ceil(rad) - 1);
        for (let oy = -ir; oy <= ir; oy++) {
          for (let ox = -ir; ox <= ir; ox++) {
            if (ox * ox + oy * oy > rad * rad + 0.5) continue;
            const f = (ox + ir + 0.5) / (2 * ir + 1); // 0 = left edge, 1 = right edge
            const b = bark || barkAt(f);
            const shade = f < 0.28 ? 0 : f > 0.72 ? 2 : 1;
            px(c, cx + ox, cy + oy, b[ir === 0 ? 1 : shade]);
          }
        }
      }
      // bark knots on the trunk
      if (depth === 0 && w > 4) {
        for (let k = 0; k < 2 + g * 4; k++) {
          const t = 0.15 + r() * 0.7;
          px(c, x + (ex - x) * t + (r() - 0.5) * (w * 0.5), y + (ey - y) * t, barkAt(0.5)[2]);
        }
      }

      if (depth >= maxDepth) {
        tips.push({ x: ex, y: ey, r: 3 + g * 5 });
        return;
      }
      if (depth >= maxDepth - 1 && depth > 0) tips.push({ x: ex, y: ey, r: 2 + g * 3 });

      const n = depth === 0 ? 2 + (r() < 0.6 ? 1 : 0) : 2 + (r() < 0.3 ? 1 : 0);
      const spread = 0.42 + r() * 0.22;
      for (let i = 0; i < n; i++) {
        let a = ang + (i - (n - 1) / 2) * spread + (r() - 0.5) * 0.35;
        a = a * 0.85 + (-Math.PI / 2) * 0.15; // gentle pull toward vertical keeps the crown balanced
        // keep branches from drooping below horizontal
        const ca = Math.max(-Math.PI + 0.25, Math.min(-0.25, a));
        branch(path + i, ex, ey, ca, len * (0.62 + r() * 0.1), w1, depth + 1);
      }
    }
    branch('t', CX, GROUND, -Math.PI / 2 + (rngFor('lean')() - 0.5) * 0.12, trunkLen, trunkW, 0);

    // Leaf slots on a 2px grid around tips, shuffled into a stable fill order.
    /** @type {Map<string, {x:number,y:number}>} */
    const slots = new Map();
    tips.forEach((tip, ti) => {
      const r = rngFor('leaf' + ti);
      const count = Math.round(tip.r * tip.r * 0.9) + 2;
      for (let k = 0; k < count; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * tip.r;
        const x = Math.round((tip.x + Math.cos(a) * d) / 2) * 2;
        const y = Math.round((tip.y + Math.sin(a) * d * 0.8) / 2) * 2;
        if (y > GROUND - 3 || x < 1 || x > W - 3 || y < 1) continue;
        slots.set(x + ',' + y, { x, y });
      }
    });
    const arr = [...slots.values()];
    const sr = rngFor('shuffle');
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(sr() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return { layer, slots: arr, g };
  }

  // ---------- background ----------
  let bgHour = -1;
  /** @type {HTMLCanvasElement|null} */
  let bg = null;
  function skyFor(hour) {
    if (hour >= 7 && hour < 17) return { bands: ['#5fb6f0', '#74c3f4', '#8cd0f7', '#a6dcf9', '#c3e8fb'], body: 'sun', stars: false };
    if ((hour >= 17 && hour < 19) || (hour >= 5 && hour < 7))
      return { bands: ['#3b3f78', '#6b4f8f', '#b0618b', '#e8846f', '#f7b779'], body: 'sun', stars: false };
    return { bands: ['#0d1330', '#141c42', '#1b2552', '#233063', '#2c3b72'], body: 'moon', stars: true };
  }
  function buildBg(hour) {
    const b = document.createElement('canvas');
    b.width = W;
    b.height = H;
    const c = /** @type {CanvasRenderingContext2D} */ (b.getContext('2d'));
    const sky = skyFor(hour);
    const bandH = Math.ceil(GROUND / sky.bands.length);
    sky.bands.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(0, i * bandH, W, bandH + 1);
      // dither the seam between bands
      if (i > 0) {
        c.fillStyle = sky.bands[i - 1];
        for (let x = (i % 2); x < W; x += 2) c.fillRect(x, i * bandH, 1, 1);
      }
    });
    if (sky.stars) {
      const r = rngFor('stars');
      for (let i = 0; i < 40; i++) px(c, r() * W, r() * (GROUND - 30), r() < 0.2 ? '#fff6c8' : '#9aa6d8');
    }
    // sun / moon
    const sx = 104, sy = 20;
    for (let y = -6; y <= 6; y++)
      for (let x = -6; x <= 6; x++) {
        const d = x * x + y * y;
        if (d > 36) continue;
        if (sky.body === 'sun') px(c, sx + x, sy + y, d > 25 ? '#ffd76a' : '#fff1a8');
        else if (!((x - 3) * (x - 3) + (y + 2) * (y + 2) < 26)) px(c, sx + x, sy + y, d > 25 ? '#c9cfe8' : '#eef0ff');
      }
    // distant hills
    const hr = rngFor('hills');
    const hillCol = sky.stars ? '#1c2a3a' : '#7fb38a';
    for (let x = 0; x < W; x++) {
      const h = Math.round(6 + Math.sin(x / 13 + 1) * 3 + Math.sin(x / 5) * 1.2);
      c.fillStyle = hillCol;
      c.fillRect(x, GROUND - h, 1, h);
    }
    // ground
    const grass = sky.stars ? ['#2d5a32', '#234a29', '#1b3a20'] : ['#79c850', '#5aa83c', '#3f8a2e'];
    const dirt = sky.stars ? ['#3a2a1e', '#2e2117'] : ['#8a5f3b', '#6e4a2d'];
    c.fillStyle = grass[1];
    c.fillRect(0, GROUND, W, 4);
    c.fillStyle = grass[2];
    c.fillRect(0, GROUND + 3, W, 1);
    c.fillStyle = dirt[0];
    c.fillRect(0, GROUND + 4, W, H - GROUND - 4);
    const gr = rngFor('grass');
    for (let x = 0; x < W; x++) {
      if (gr() < 0.45) px(c, x, GROUND - 1, grass[0]);
      if (gr() < 0.12) px(c, x, GROUND - 2, grass[0]);
      if (gr() < 0.3) px(c, x, GROUND + 1, grass[0]);
    }
    for (let i = 0; i < 70; i++) px(c, gr() * W, GROUND + 5 + gr() * (H - GROUND - 5), dirt[1]);
    // pebbles
    for (let i = 0; i < 6; i++) {
      const x = gr() * W, y = GROUND + 6 + gr() * 12;
      px(c, x, y, '#a89a8a');
      px(c, x + 1, y, '#7d7266');
    }
    return b;
  }

  function drawCloud(x, y, night) {
    const col = night ? '#3a4470' : '#ffffff';
    const sh = night ? '#2c355c' : '#dbeefa';
    ctx.fillStyle = col;
    ctx.fillRect(x + 3, y, 8, 2);
    ctx.fillRect(x + 1, y + 2, 14, 2);
    ctx.fillRect(x, y + 4, 17, 2);
    ctx.fillStyle = sh;
    ctx.fillRect(x + 1, y + 6, 15, 1);
  }

  // ---------- leaves ----------
  /**
   * Fill the first N slots of the (shuffled) fill order, then hand them out left-to-right in the
   * same agent order as the bark stripes, so each agent owns its side of the crown.
   */
  function assign(counts, slots) {
    const capacity = slots.length;
    const total = counts.reduce((s, c) => s + c.n, 0);
    const scale = total > capacity ? capacity / total : 1;
    const want = counts.map((c) => ({ ...c, n: Math.round(c.n * scale) }));
    const N = Math.min(capacity, want.reduce((s, c) => s + c.n, 0));
    /** @type {({agent:string, pi:number}|null)[]} */
    const out = new Array(capacity).fill(null);
    const filled = Array.from({ length: N }, (_, k) => k).sort((a, b) => slots[a].x - slots[b].x || a - b);
    let w = 0, used = 0;
    for (const k of filled) {
      while (w < want.length && used >= want[w].n) { w++; used = 0; }
      if (w >= want.length) break;
      out[k] = { agent: want[w].id, pi: want[w].pi };
      used++;
    }
    return { out, overflow: Math.max(0, total - capacity) };
  }

  function drawLeaf(x, y, colors, flash) {
    const [hi, mid, sh, ol] = colors;
    if (flash >= 1) {
      px(ctx, x + 1, y + 1, FLASH);
      return;
    }
    const f = flash > 0;
    px(ctx, x + 1, y, f ? FLASH : hi);
    px(ctx, x, y + 1, f ? FLASH : hi);
    px(ctx, x + 1, y + 1, f ? hi : mid);
    px(ctx, x + 2, y + 1, mid);
    px(ctx, x + 1, y + 2, sh);
    px(ctx, x + 2, y + 2, ol);
  }

  function drawFruit(x, y) {
    px(ctx, x + 1, y - 1, '#5a3a1a');
    px(ctx, x, y, FRUIT[1]);
    px(ctx, x + 1, y, FRUIT[0]);
    px(ctx, x + 2, y, FRUIT[1]);
    px(ctx, x, y + 1, FRUIT[2]);
    px(ctx, x + 1, y + 1, FRUIT[1]);
    px(ctx, x + 2, y + 1, FRUIT[2]);
    px(ctx, x + 1, y + 2, FRUIT[3]);
  }

  function dropLeaf(x, y, color) {
    if (falling.length > 120) return;
    falling.push({ x, y, vx: (Math.random() - 0.5) * 0.4, phase: Math.random() * 6, color, landed: 0 });
  }

  // ---------- update from extension ----------
  function onSnapshot(s) {
    snap = s;
    const agents = s.agents.filter((a) => a.available);
    const lifetime = agents.reduce((t, a) => t + a.lifetimeTokens, 0);
    const g = growthOf(lifetime);
    const shares = agents
      .map((a, i) => ({ id: a.id, pi: i, share: lifetime > 0 ? a.lifetimeTokens / lifetime : 1 / Math.max(1, agents.length) }))
      .filter((x) => x.share > 0);
    if (!shares.length) shares.push({ id: 'claude', pi: 0, share: 1 });

    const key = Math.round(g * 100) + '|' + shares.map((x) => x.id + Math.round(x.share * 20)).join(',');
    if (key !== treeKey) {
      treeKey = key;
      tree = buildTree(g, shares);
      leaves = new Array(tree.slots.length).fill(null);
    }
    if (!tree) return;

    const counts = agents.map((a, i) => ({ id: a.id, pi: i, n: Math.round(a.windowTokens / s.tokensPerLeaf) }));
    const { out, overflow } = assign(counts, tree.slots);
    const now = performance.now();
    out.forEach((a, k) => {
      const prev = leaves[k];
      if (!a) {
        if (prev && !firstPaint) {
          const sl = tree.slots[k];
          dropLeaf(sl.x, sl.y, pal(prev.agent, prev.pi).leaf[1]);
        }
        leaves[k] = null;
      } else if (!prev || prev.agent !== a.agent) {
        leaves[k] = { ...a, born: firstPaint ? now + k * 6 : now + Math.random() * 600 };
      }
    });
    const nFruit = overflow > 0 ? Math.min(14, Math.ceil(overflow / Math.max(1, tree.slots.length * 0.15))) : 0;
    fruits = Array.from({ length: nFruit }, (_, i) => tree.slots.length - 1 - i * 3).filter((k) => k >= 0);
    stress = Math.max(0, ...agents.flatMap((a) => a.quotas.map((q) => q.usedPercent / 100)));
    firstPaint = false;

    renderPanel(s, agents, g, lifetime, out.filter(Boolean).length, tree.slots.length, overflow);
  }

  // ---------- frame loop ----------
  let last = 0;
  function frame() {
    requestAnimationFrame(frame);
    const t = performance.now();
    if (t - last < 1000 / FPS) return;
    last = t;
    const hour = new Date().getHours();
    if (hour !== bgHour || !bg) {
      bgHour = hour;
      bg = buildBg(hour);
    }
    ctx.drawImage(bg, 0, 0);
    const night = skyFor(hour).stars;
    const sec = t / 1000;
    drawCloud(Math.round(((sec * 1.5) % (W + 40)) - 20), 14, night);
    drawCloud(Math.round(((sec * 0.9 + 70) % (W + 40)) - 20), 32, night);

    if (!tree) return;
    ctx.drawImage(tree.layer, 0, 0);

    const gust = Math.sin(sec * 0.7) > 0.6 ? 1 : 0;
    for (let k = 0; k < leaves.length; k++) {
      const lf = leaves[k];
      if (!lf || t < lf.born) continue;
      const sl = tree.slots[k];
      const age = (t - lf.born) / 1000;
      const flash = age < 0.35 ? 1 : age < 2.5 ? Math.floor(age * 4) % 2 === 0 ? 0.5 : 0 : 0;
      const sway = gust && Math.sin(sec * 3 + sl.y * 0.3 + sl.x * 0.1) > 0.3 ? 1 : 0;
      drawLeaf(sl.x + sway, sl.y, pal(lf.agent, lf.pi).leaf, flash);
    }
    for (const k of fruits) {
      const sl = tree.slots[k];
      drawFruit(sl.x, sl.y);
    }

    // Under quota pressure, leaves start to fall.
    if (stress >= 0.8 && Math.random() < (stress - 0.7) * 0.6) {
      const filled = leaves.map((l, k) => (l ? k : -1)).filter((k) => k >= 0);
      if (filled.length) {
        const k = filled[Math.floor(Math.random() * filled.length)];
        const lf = /** @type {any} */ (leaves[k]);
        dropLeaf(tree.slots[k].x, tree.slots[k].y, pal(lf.agent, lf.pi).leaf[stress >= 1 ? 3 : 2]);
      }
    }
    falling = falling.filter((p) => {
      if (p.landed) {
        p.landed++;
        if (p.landed > FPS * 4) return false;
      } else {
        p.y += 0.55;
        p.phase += 0.3;
        p.x += p.vx + Math.sin(p.phase) * 0.5;
        if (p.y >= GROUND + 1 + (p.x % 3)) p.landed = 1;
      }
      px(ctx, p.x, p.y, p.color);
      if (!p.landed) px(ctx, p.x + 1, p.y, p.color);
      return p.x > -2 && p.x < W + 2;
    });
  }
  requestAnimationFrame(frame);

  // ---------- HTML panel ----------
  /**
   * @param {string} tag @param {Record<string, any>} [props] @param {...any} kids
   * @returns {HTMLElement}
   */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'style') Object.assign(el.style, v);
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function until(ms) {
    const d = Math.max(0, ms - Date.now());
    const hh = Math.floor(d / 3600000), mm = Math.floor((d % 3600000) / 60000);
    if (hh >= 48) return Math.round(hh / 24) + 'd';
    return hh ? `${hh}h ${mm}m` : `${mm}m`;
  }
  function ago(ts) {
    const d = (Date.now() - ts) / 60000;
    if (d < 1) return 'just now';
    if (d < 60) return Math.round(d) + 'm ago';
    if (d < 48 * 60) return Math.round(d / 60) + 'h ago';
    return Math.round(d / 1440) + 'd ago';
  }

  function bar(pct) {
    const segs = 20;
    const filled = Math.min(segs, Math.round((pct / 100) * segs));
    const color = pct >= 90 ? 'var(--q-red)' : pct >= 70 ? 'var(--q-yellow)' : 'var(--q-green)';
    return h('div', { class: 'bar' },
      Array.from({ length: segs }, (_, i) => h('i', i < filled ? { style: { background: color } } : {})));
  }

  function renderPanel(s, agents, g, lifetime, shown, capacity, overflow) {
    document.querySelectorAll('#windows button').forEach((b) =>
      b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.w === s.window));

    const cap = document.getElementById('caption');
    if (cap) {
      cap.replaceChildren(
        h('div', {}, h('b', {}, stageName(g)), ` · trunk = ${fmt(lifetime)} lifetime tokens`),
        h('div', {}, `${shown}/${capacity} leaves · 1 leaf = ${fmt(s.tokensPerLeaf)} tokens`,
          overflow > 0 ? ` · canopy full (+${fmt(overflow * s.tokensPerLeaf)} as fruit)` : ''),
      );
    }

    const box = document.getElementById('agents');
    if (!box) return;
    box.replaceChildren(
      ...s.agents.map((a, i) => {
        const p = pal(a.id, agents.indexOf(a) >= 0 ? agents.indexOf(a) : i);
        if (!a.available) {
          return h('div', { class: 'agent off' },
            h('div', { class: 'hdr' }, h('span', { class: 'sw', style: { background: p.leaf[1] } }), a.name),
            h('div', { class: 'dim' }, 'No logs found in ', a.searchedDirs.join(', ') || '—'));
        }
        const b = a.windowBreakdown;
        return h('div', { class: 'agent' },
          h('div', { class: 'hdr' },
            h('span', { class: 'sw', style: { background: p.leaf[1], boxShadow: `2px 2px 0 ${p.leaf[3]}` } }),
            a.name,
            h('span', { class: 'dim right' }, a.lastActivity ? ago(a.lastActivity) : '')),
          h('div', { class: 'row' }, h('span', {}, s.window.toUpperCase()), h('b', {}, fmt(a.windowTokens))),
          h('div', { class: 'row dim small' },
            `in ${fmt(b.input)} · out ${fmt(b.output)} · cache w ${fmt(b.cacheWrite)} · cache r ${fmt(b.cacheRead)}${s.countCacheReads ? '' : ' (excl.)'}`),
          h('div', { class: 'row' }, h('span', {}, 'LIFETIME'), h('b', {}, fmt(a.lifetimeTokens)),
            h('span', { class: 'dim small' }, ` ${a.sessions} sessions`)),
          a.quotas.length
            ? a.quotas.map((q) =>
                h('div', { class: 'quota' },
                  h('div', { class: 'row' },
                    h('span', {}, q.label.toUpperCase(), q.source === 'budget' ? h('span', { class: 'dim' }, ' (budget)') : ''),
                    h('b', {}, q.usedPercent.toFixed(0) + '%')),
                  bar(q.usedPercent),
                  q.resetsAt ? h('div', { class: 'dim small' }, 'resets in ' + until(q.resetsAt)) : null))
            : h('div', { class: 'dim small hint' },
                a.id === 'claude'
                  ? 'Plan limits are not in Claude Code logs — set quotaTree.claude.tokenBudget5h for a quota bar.'
                  : 'No quota info reported yet.'));
      }),
    );

    const up = document.getElementById('updated');
    if (up) up.textContent = 'updated ' + new Date(s.generatedAt).toLocaleTimeString();
  }

  // ---------- wiring ----------
  document.querySelectorAll('#windows button').forEach((b) =>
    b.addEventListener('click', () => vscode.postMessage({ type: 'setWindow', window: /** @type {HTMLElement} */ (b).dataset.w })));
  document.getElementById('settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'openSettings' });
  });
  canvas.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  const stage = /** @type {HTMLElement} */ (document.querySelector('.stage'));
  function fit() {
    const scale = Math.max(1, Math.floor(stage.clientWidth / W));
    canvas.style.width = W * scale + 'px';
    canvas.style.height = H * scale + 'px';
  }
  new ResizeObserver(fit).observe(stage);
  fit();

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'update') onSnapshot(e.data.payload);
  });
  vscode.postMessage({ type: 'ready' });
})();
