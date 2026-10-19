// Animated background of the launcher. One scene per design, chosen by <html data-theme="...">.
//   galaxy    stars + shooting stars          aurora   northern lights curtains + stars
//   inferno   rising embers + heat glow         ocean    light rays + bubbles + plankton
//   sakura    falling cherry petals + moon      neon     synthwave sun + moving grid
//   halloween full moon + fog + bats + sparks
//   clouds    sunset sky, three layers of soft clouds drifting, birds
// Capped at ~30 fps, paused while the window is hidden, a single still frame with reduced motion.
(() => {
  const canvas = document.getElementById('galaxy');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  let w = 0, h = 0, dpr = 1, tx = 0, ty = 0, px = 0, py = 0, last = 0, raf = 0, scene = null, sceneName = '';

  // ---------------------------------------------------------------- shared: stars
  function makeStars(n, tints) {
    return Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, z: rnd(.25, 2), r: rnd(.35, 1.5) * dpr, tw: rnd(0, TAU), sp: rnd(.5, 2), tint: tints[(Math.random() * tints.length) | 0] }));
  }
  function drawStars(stars, t, dt, drift = .012, maxY = h) {
    for (const s of stars) {
      if (!reduce && drift) { s.x -= s.z * drift * dt * dpr; if (s.x < -4) { s.x = w + 4; s.y = Math.random() * maxY; } }
      const a = reduce ? .8 : .35 + .65 * (.5 + .5 * Math.sin(t * .001 * s.sp + s.tw));
      const x = s.x + px * s.z * 14 * dpr, y = s.y + py * s.z * 14 * dpr;
      if (y > maxY) continue;
      ctx.fillStyle = `rgba(${s.tint},${a.toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, s.r, 0, TAU); ctx.fill();
      if (s.r > 1.2 * dpr) { ctx.fillStyle = `rgba(${s.tint},${(a * .18).toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, s.r * 3.2, 0, TAU); ctx.fill(); }
    }
  }
  const area = () => (w * h) / (dpr * dpr);

  // ---------------------------------------------------------------- scenes
  const SCENES = {
    galaxy() {
      const stars = makeStars(Math.round(Math.min(230, area() / 8500)), ['255,255,255', '255,255,255', '214,200,255', '170,225,255', '255,190,235']);
      const shoots = []; let next = 2500;
      return (t, dt) => {
        drawStars(stars, t, dt);
        next -= dt;
        if (next <= 0 && !reduce) { next = rnd(4500, 10500); shoots.push({ x: Math.random() * w * .8, y: Math.random() * h * .4, vx: rnd(.55, .95) * dpr, vy: rnd(.2, .45) * dpr, life: 900 }); }
        for (let i = shoots.length - 1; i >= 0; i--) {
          const m = shoots[i]; m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt;
          if (m.life <= 0) { shoots.splice(i, 1); continue; }
          const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 90, m.y - m.vy * 90);
          g.addColorStop(0, `rgba(255,255,255,${Math.min(1, m.life / 300)})`); g.addColorStop(1, 'rgba(160,140,255,0)');
          ctx.strokeStyle = g; ctx.lineWidth = 1.6 * dpr; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 90, m.y - m.vy * 90); ctx.stroke();
        }
      };
    },
    aurora() {
      const stars = makeStars(Math.round(Math.min(140, area() / 12000)), ['255,255,255', '210,255,240', '190,230,255']);
      const bands = [
        { base: .30, amp: .07, len: .36, k: 2.1, sp: .00011, col: [62, 240, 192], ph: 0 },
        { base: .22, amp: .05, len: .28, k: 3.3, sp: .00016, col: [122, 216, 255], ph: 2 },
        { base: .38, amp: .06, len: .24, k: 1.6, sp: .00009, col: [180, 140, 255], ph: 4 }
      ];
      return t => {
        drawStars(stars, t, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        const step = Math.max(3, Math.round(4 * dpr));
        for (const b of bands) {
          for (let x = 0; x <= w; x += step) {
            const u = x / w;
            const y = h * (b.base + b.amp * Math.sin(u * b.k * TAU + t * b.sp * 6 + b.ph) + .02 * Math.sin(u * 13 + t * .0007));
            const len = h * b.len * (.6 + .4 * Math.sin(u * 5 + t * .0004 + b.ph));
            const flick = .5 + .5 * Math.sin(u * 40 + t * .002 + b.ph);
            const a = .06 + .07 * flick;
            const g = ctx.createLinearGradient(0, y - len, 0, y);
            g.addColorStop(0, `rgba(${b.col},0)`); g.addColorStop(.75, `rgba(${b.col},${a * .7})`); g.addColorStop(1, `rgba(${b.col},${a})`);
            ctx.fillStyle = g; ctx.fillRect(x, y - len, step + 1, len);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      };
    },
    inferno() {
      const embers = []; const max = Math.round(Math.min(160, area() / 7000));
      const spawn = (initial) => ({ x: Math.random() * w, y: initial ? Math.random() * h : h + rnd(0, 40) * dpr, r: rnd(.8, 2.6) * dpr, vy: rnd(.03, .1) * dpr, sway: rnd(.4, 1.4), ph: rnd(0, TAU), life: 1, hue: rnd(18, 45) });
      for (let i = 0; i < max; i++) embers.push(spawn(true));
      return (t, dt) => {
        const g = ctx.createLinearGradient(0, h, 0, h * .55);
        g.addColorStop(0, `rgba(255,90,30,${.20 + .05 * Math.sin(t * .002)})`); g.addColorStop(1, 'rgba(255,60,20,0)');
        ctx.fillStyle = g; ctx.fillRect(0, h * .55, w, h * .45);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < embers.length; i++) {
          const e = embers[i];
          if (!reduce) { e.y -= e.vy * dt; e.x += Math.sin(t * .001 * e.sway + e.ph) * .25 * dpr; }
          const life = Math.max(0, Math.min(1, e.y / h));
          if (e.y < -10) { embers[i] = spawn(false); continue; }
          const flick = .6 + .4 * Math.sin(t * .01 * e.sway + e.ph);
          const a = life * flick;
          ctx.fillStyle = `hsla(${e.hue},100%,60%,${(a * .25).toFixed(3)})`; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 3.5, 0, TAU); ctx.fill();
          ctx.fillStyle = `hsla(${e.hue + 10},100%,72%,${a.toFixed(3)})`; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (.4 + .6 * life), 0, TAU); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      };
    },
    ocean() {
      const bubbles = Array.from({ length: Math.round(Math.min(60, area() / 22000)) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: rnd(1.5, 6) * dpr, vy: rnd(.02, .06) * dpr, ph: rnd(0, TAU) }));
      const dust = makeStars(Math.round(Math.min(120, area() / 10000)), ['170,230,255', '120,255,240']);
      const rays = Array.from({ length: 6 }, (_, i) => ({ x: (i + .5) / 6, wd: rnd(.04, .1), ph: rnd(0, TAU), sp: rnd(.00015, .0003) }));
      return (t, dt) => {
        ctx.globalCompositeOperation = 'lighter';
        for (const r of rays) {
          const cx = w * (r.x + .03 * Math.sin(t * r.sp + r.ph)), half = w * r.wd;
          const a = .045 + .03 * Math.sin(t * r.sp * 3 + r.ph);
          const g = ctx.createLinearGradient(0, 0, 0, h * .9);
          g.addColorStop(0, `rgba(140,220,255,${a})`); g.addColorStop(1, 'rgba(140,220,255,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx - half * .4, 0); ctx.lineTo(cx + half * .4, 0); ctx.lineTo(cx + half * 1.6 - w * .08, h * .9); ctx.lineTo(cx - half * 1.6 - w * .08, h * .9); ctx.closePath(); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        drawStars(dust, t, dt, .004);
        for (const b of bubbles) {
          if (!reduce) { b.y -= b.vy * dt; b.x += Math.sin(t * .0015 + b.ph) * .18 * dpr; if (b.y < -10) { b.y = h + 10; b.x = Math.random() * w; } }
          ctx.strokeStyle = 'rgba(190,240,255,.35)'; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(b.x - b.r * .35, b.y - b.r * .35, b.r * .25, 0, TAU); ctx.fill();
        }
      };
    },
    sakura() {
      const petals = Array.from({ length: Math.round(Math.min(70, area() / 16000)) }, () => ({ x: Math.random() * w, y: Math.random() * h, s: rnd(4, 9) * dpr, vy: rnd(.02, .05) * dpr, vx: rnd(.01, .035) * dpr, rot: rnd(0, TAU), vr: rnd(-.002, .002), ph: rnd(0, TAU), hue: rnd(330, 352) }));
      const stars = makeStars(Math.round(Math.min(70, area() / 25000)), ['255,230,240', '255,255,255']);
      return (t, dt) => {
        drawStars(stars, t, 0, 0, h * .6);
        const mx = w * .6, my = h * .075, mr = Math.min(w, h) * .038;
        const glow = ctx.createRadialGradient(mx, my, mr * .6, mx, my, mr * 4);
        glow.addColorStop(0, 'rgba(255,220,235,.25)'); glow.addColorStop(1, 'rgba(255,220,235,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(mx, my, mr * 4, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,246,.75)'; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
        for (const p of petals) {
          if (!reduce) { p.y += p.vy * dt; p.x += (p.vx + Math.sin(t * .001 + p.ph) * .02 * dpr) * dt; p.rot += p.vr * dt; if (p.y > h + 12 || p.x > w + 12) { p.y = -12; p.x = Math.random() * w * 1.1 - w * .1; } }
          const flip = Math.abs(Math.sin(t * .002 + p.ph));
          ctx.save(); ctx.translate(p.x + px * 8 * dpr, p.y + py * 8 * dpr); ctx.rotate(p.rot);
          ctx.fillStyle = `hsla(${p.hue},90%,${80 + flip * 8}%,.85)`;
          ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s * (.35 + .3 * flip), 0, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(-p.s * .3, 0, p.s * .3, p.s * .12, 0, 0, TAU); ctx.fill();
          ctx.restore();
        }
      };
    },
    neon() {
      const stars = makeStars(Math.round(Math.min(110, area() / 14000)), ['255,255,255', '255,180,240', '150,240,255']);
      return t => {
        const hz = h * .7;
        drawStars(stars, t, 0, 0, hz);
        const sx = w * .58, sr = Math.min(w, h) * .17, sy = hz - sr * .15;
        const halo = ctx.createRadialGradient(sx, sy, sr * .4, sx, sy, sr * 2.4);
        halo.addColorStop(0, 'rgba(255,60,200,.35)'); halo.addColorStop(1, 'rgba(255,60,200,0)');
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(sx, sy, sr * 2.4, 0, TAU); ctx.fill();
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, hz); ctx.clip();
        const sun = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
        sun.addColorStop(0, '#ffe45e'); sun.addColorStop(.55, '#ff5ec4'); sun.addColorStop(1, '#a12cff');
        ctx.globalAlpha = .6; ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 7; i++) { const yy = sy + sr * (.1 + i * .13), th = sr * (.02 + i * .012); ctx.fillRect(sx - sr, yy, sr * 2, th); }
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';
        const floor = ctx.createLinearGradient(0, hz, 0, h);
        floor.addColorStop(0, 'rgba(60,0,90,.55)'); floor.addColorStop(1, 'rgba(10,0,20,.2)');
        ctx.fillStyle = floor; ctx.fillRect(0, hz, w, h - hz);
        ctx.strokeStyle = 'rgba(255,47,208,.38)'; ctx.lineWidth = 1.2 * dpr;
        const off = reduce ? 0 : (t * .00035) % 1;
        for (let i = 0; i < 16; i++) { const k = (i + off) / 16, y = hz + (h - hz) * k * k; ctx.globalAlpha = .2 + .6 * k; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(35,240,255,.25)';
        for (let i = -12; i <= 12; i++) { ctx.beginPath(); ctx.moveTo(sx + i * w * .02, hz); ctx.lineTo(sx + i * w * .16, h); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(255,120,230,.6)'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.moveTo(0, hz); ctx.lineTo(w, hz); ctx.stroke();
      };
    },
    halloween() {
      const stars = makeStars(Math.round(Math.min(80, area() / 20000)), ['255,240,220', '255,255,255']);
      const fog = Array.from({ length: 7 }, (_, i) => ({ x: Math.random() * w, y: h * rnd(.65, .95), r: rnd(.18, .32) * w, sp: rnd(.006, .015) * dpr * (i % 2 ? 1 : -1) }));
      const sparks = Array.from({ length: Math.round(Math.min(50, area() / 26000)) }, () => ({ x: Math.random() * w, y: Math.random() * h, vy: rnd(.01, .03) * dpr, ph: rnd(0, TAU), green: Math.random() < .3 }));
      const bats = []; let next = 1500;
      const drawBat = (x, y, s, flap) => {
        ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.fillStyle = 'rgba(10,4,14,.92)';
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-6, -6 * flap, -14, -2 * flap); ctx.quadraticCurveTo(-10, 0, -12, 4); ctx.quadraticCurveTo(-6, 2, -3, 5);
        ctx.lineTo(0, 3); ctx.lineTo(3, 5); ctx.quadraticCurveTo(6, 2, 12, 4); ctx.quadraticCurveTo(10, 0, 14, -2 * flap); ctx.quadraticCurveTo(6, -6 * flap, 0, 0);
        ctx.fill(); ctx.restore();
      };
      return (t, dt) => {
        drawStars(stars, t, 0, 0, h * .7);
        const mx = w * .6, my = h * .075, mr = Math.min(w, h) * .045;
        const glow = ctx.createRadialGradient(mx, my, mr * .7, mx, my, mr * 4.5);
        glow.addColorStop(0, 'rgba(255,190,90,.22)'); glow.addColorStop(1, 'rgba(255,190,90,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(mx, my, mr * 4.5, 0, TAU); ctx.fill();
        const moon = ctx.createRadialGradient(mx - mr * .3, my - mr * .3, mr * .1, mx, my, mr);
        moon.addColorStop(0, '#fff6d8'); moon.addColorStop(1, '#ffc566');
        ctx.globalAlpha = .85; ctx.fillStyle = moon; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
        next -= dt;
        if (next <= 0 && !reduce) { next = rnd(2500, 6000); const dir = Math.random() < .5 ? 1 : -1; bats.push({ x: dir > 0 ? -30 : w + 30, y: h * rnd(.1, .5), vx: dir * rnd(.12, .22) * dpr, s: rnd(1, 1.8) * dpr, ph: rnd(0, TAU) }); }
        for (let i = bats.length - 1; i >= 0; i--) { const b = bats[i]; b.x += b.vx * dt; b.y += Math.sin(t * .004 + b.ph) * .3 * dpr; if (b.x < -60 || b.x > w + 60) { bats.splice(i, 1); continue; } drawBat(b.x, b.y, b.s, Math.sin(t * .025 + b.ph)); }
        ctx.globalCompositeOperation = 'lighter';
        for (const s of sparks) {
          if (!reduce) { s.y -= s.vy * dt; if (s.y < -6) { s.y = h + 6; s.x = Math.random() * w; } }
          const a = .35 + .35 * Math.sin(t * .004 + s.ph);
          ctx.fillStyle = s.green ? `rgba(182,255,59,${a})` : `rgba(255,150,40,${a})`; ctx.beginPath(); ctx.arc(s.x + Math.sin(t * .001 + s.ph) * 6 * dpr, s.y, 1.6 * dpr, 0, TAU); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        for (const f of fog) {
          if (!reduce) { f.x += f.sp * dt; if (f.x - f.r > w) f.x = -f.r; if (f.x + f.r < 0) f.x = w + f.r; }
          const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
          g.addColorStop(0, 'rgba(170,150,200,.14)'); g.addColorStop(1, 'rgba(170,150,200,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill();
        }
      };
    },
    clouds() {
      // Every cloud is drawn ONCE into its own small picture (many soft puffs, lit on top, shaded below) and then only
      // moved: light on the PC.
      const S = Math.min(w, h);
      const sprite = (cw, opa, lit, shade) => {
        // One solid silhouette made of puffs (so no circles show inside), softly blurred, then lit from above.
        const c = document.createElement('canvas'), ch = Math.round(cw * .6), pad = Math.round(cw * .06);
        c.width = Math.round(cw) + pad * 2; c.height = ch + pad * 2;
        const g = c.getContext('2d'), base = pad + ch * .82;
        const puffs = Math.round(rnd(7, 11)), shape = [];
        for (let i = 0; i < puffs; i++) {
          const u = (i + .5) / puffs, r = cw * rnd(.1, .16) * (1.15 - Math.abs(u - .5) * 1.1);
          shape.push([pad + cw * (.1 + .8 * u) + rnd(-.02, .02) * cw, base - r * rnd(.45, 1.05), r]);
        }
        g.filter = `blur(${Math.max(1, cw * .012)}px)`;
        g.fillStyle = '#fff';
        for (const [x, y, r] of shape) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
        g.fillRect(pad + cw * .12, base - cw * .06, cw * .76, cw * .06);
        g.filter = 'none';
        g.globalCompositeOperation = 'source-atop';
        const top = Math.min(...shape.map(p => p[1] - p[2]));
        const body = g.createLinearGradient(0, top, 0, base);
        body.addColorStop(0, `rgb(${lit})`); body.addColorStop(.55, `rgb(${lit})`); body.addColorStop(1, `rgb(${shade})`);
        g.fillStyle = body; g.fillRect(0, 0, c.width, c.height);
        for (const [x, y, r] of shape) {                         // a soft highlight on each puff, towards the sun
          const hl = g.createRadialGradient(x + r * .25, y - r * .45, 0, x + r * .25, y - r * .45, r * .9);
          hl.addColorStop(0, 'rgba(255,250,240,.55)'); hl.addColorStop(1, 'rgba(255,250,240,0)');
          g.fillStyle = hl; g.fillRect(x - r * 1.2, y - r * 1.6, r * 2.4, r * 2.4);
        }
        g.globalCompositeOperation = 'source-over';
        c.__opa = opa;
        return c;
      };
      const layers = [
        { n: 6, size: [.20, .30], y: [.16, .40], sp: .006, opa: .42, lit: '214,170,214', shade: '104,78,158', par: 4 },
        { n: 5, size: [.30, .44], y: [.36, .66], sp: .012, opa: .66, lit: '255,196,206', shade: '138,92,170', par: 9 },
        { n: 4, size: [.44, .66], y: [.70, 1.02], sp: .022, opa: .9, lit: '255,226,214', shade: '160,104,176', par: 16 }
      ].map(L => ({ ...L, items: Array.from({ length: L.n }, () => { const cw = S * rnd(L.size[0], L.size[1]) * 1.6; return { img: sprite(cw, L.opa, L.lit, L.shade), x: rnd(-.2, 1.1) * w, y: h * rnd(L.y[0], L.y[1]), bob: rnd(0, TAU) }; }) }));
      const stars = makeStars(Math.round(Math.min(60, area() / 26000)), ['255,240,250', '255,255,255']);
      const birds = []; let next = 3000;
      return (t, dt) => {
        drawStars(stars, t, 0, 0, h * .35);
        const dusk = ctx.createLinearGradient(0, h * .35, 0, h);
        dusk.addColorStop(0, 'rgba(255,120,170,0)'); dusk.addColorStop(.6, 'rgba(255,130,150,.22)'); dusk.addColorStop(1, 'rgba(255,170,120,.32)');
        ctx.fillStyle = dusk; ctx.fillRect(0, h * .35, w, h * .65);
        // low sun behind the clouds
        const sx = w * .7, sy = h * .58, sr = S * .09;
        const halo = ctx.createRadialGradient(sx, sy, sr * .3, sx, sy, sr * 6);
        halo.addColorStop(0, 'rgba(255,200,150,.38)'); halo.addColorStop(.35, 'rgba(255,140,170,.14)'); halo.addColorStop(1, 'rgba(255,140,170,0)');
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(sx, sy, sr * 6, 0, TAU); ctx.fill();
        const sun = ctx.createRadialGradient(sx, sy - sr * .2, sr * .1, sx, sy, sr);
        sun.addColorStop(0, 'rgba(255,248,225,.95)'); sun.addColorStop(1, 'rgba(255,190,150,.75)');
        ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
        for (const L of layers) {
          for (const c of L.items) {
            if (!reduce) { c.x += L.sp * dt * dpr; if (c.x > w + 20) { c.x = -c.img.width - rnd(0, w * .3); c.y = h * rnd(L.y[0], L.y[1]); } }
            const y = c.y + Math.sin(t * .0004 + c.bob) * 3 * dpr + py * L.par * dpr;
            ctx.globalAlpha = c.img.__opa; ctx.drawImage(c.img, c.x + px * L.par * dpr, y - c.img.height); ctx.globalAlpha = 1;
          }
          if (L === layers[0]) {                       // birds fly between the far and middle clouds
            next -= dt;
            if (next <= 0 && !reduce) { next = rnd(6000, 13000); const n = 3 + ((Math.random() * 4) | 0), y0 = h * rnd(.15, .4); for (let i = 0; i < n; i++) birds.push({ x: -30 - i * 18 * dpr, y: y0 + Math.abs(i - n / 2) * 9 * dpr, vx: rnd(.05, .07) * dpr, ph: rnd(0, TAU), s: rnd(.8, 1.2) * dpr }); }
            ctx.strokeStyle = 'rgba(60,30,80,.55)'; ctx.lineWidth = 1.4 * dpr; ctx.lineCap = 'round';
            for (let i = birds.length - 1; i >= 0; i--) {
              const b = birds[i]; b.x += b.vx * dt; if (b.x > w + 40) { birds.splice(i, 1); continue; }
              const f = Math.sin(t * .012 + b.ph) * 3 * b.s, k = 6 * b.s;
              ctx.beginPath(); ctx.moveTo(b.x - k, b.y - f); ctx.quadraticCurveTo(b.x - k * .4, b.y - k * .5, b.x, b.y); ctx.quadraticCurveTo(b.x + k * .4, b.y - k * .5, b.x + k, b.y - f); ctx.stroke();
            }
          }
        }
      };
    }
  };

  // ---------------------------------------------------------------- loop
  function pickScene() {
    const name = SCENES[document.documentElement.dataset.theme] ? document.documentElement.dataset.theme : 'galaxy';
    sceneName = name; scene = SCENES[name]();
    if (reduce) { ctx.clearRect(0, 0, w, h); scene(0, 0); }
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = canvas.width = Math.floor(innerWidth * dpr);
    h = canvas.height = Math.floor(innerHeight * dpr);
    pickScene();
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = t - last;
    if (dt < 33) return;                 // ~30 fps is plenty for a background
    last = t;
    px += (tx - px) * .06; py += (ty - py) * .06;
    ctx.clearRect(0, 0, w, h);
    scene(t, Math.min(dt, 80));
  }
  function start() { if (reduce || raf) return; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('mousemove', e => {
    tx = (e.clientX / innerWidth - .5) * 2; ty = (e.clientY / innerHeight - .5) * 2;
    const c = document.getElementById('crystal');
    if (c) { c.style.setProperty('--rx', (-ty * 10).toFixed(2) + 'deg'); c.style.setProperty('--ry', (tx * 14).toFixed(2) + 'deg'); }
  }, { passive: true });
  let held = false;                     // paused by the launcher (a game is open and the launcher is not in front)
  document.addEventListener('visibilitychange', () => (document.hidden || held ? stop() : start()));
  window.__BB_BG_PAUSE__ = on => { held = Boolean(on); if (held) stop(); else if (!document.hidden) start(); };
  new MutationObserver(() => { if ((document.documentElement.dataset.theme || 'galaxy') !== sceneName) pickScene(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  resize(); start();
  window.__BB_SCENES__ = Object.keys(SCENES);
})();
