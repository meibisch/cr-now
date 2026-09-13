/* Now — one song for the hour you are in.
   Everything happens in the listener's browser, in local time.
   No network call except the Spotify player itself. */

(function () {
  'use strict';

  const SPOTIFY_OPEN = 'https://open.spotify.com/track/';
  const EMBED = 'https://open.spotify.com/embed/track/';
  const TOP_N = 8;            // how many near matches "another" cycles through
  const SILENCE_MS = 45000;   // how long the page stays dark after a song ends

  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), cover = $('cover'), title = $('title'),
        release = $('release'), clock = $('clock'), embed = $('embed'),
        another = $('another'), open = $('open'), silence = $('silence');

  // ── season-aware anchors (clock times, approx. 50°N) ─────────────────
  function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }
  function anchors(d) {
    const c = Math.cos(2 * Math.PI * (dayOfYear(d) - 172) / 365);
    return { dawn: 6.9 - 1.6 * c, dusk: 19.15 + 2.65 * c };
  }
  function resolveHour(h, a) {
    if (typeof h === 'number') return h;
    const m = /^(dawn|dusk)([+-][\d.]+)?$/.exec(h);
    if (!m) return 12;
    return a[m[1]] + (m[2] ? parseFloat(m[2]) : 0);
  }
  function circDist(a, b) {
    const d = Math.abs(a - b) % 24;
    return Math.min(d, 24 - d);
  }
  function mmdd(d) {
    return String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }
  function inWindow(now, win) {
    const [a, b] = win;
    return a <= b ? (now >= a && now <= b) : (now >= a || now <= b);
  }

  // ── scoring ───────────────────────────────────────────────────────────
  function score(t, ctx) {
    const center = resolveHour(t.h, ctx.anchors);
    const sd = t.sd || 3;
    const dist = circDist(ctx.hour, center);
    let s = Math.exp(-(dist * dist) / (2 * sd * sd)) * (t.w || 1);

    let seasonal = null;
    if (t.m) seasonal = t.m.includes(ctx.month);
    if (t.dates) seasonal = t.dates.some((w) => inWindow(ctx.mmdd, w));
    if (seasonal === true) s *= 1.3;
    else if (seasonal === false) s *= t.strict ? 0.02 : 0.6;

    if (t.d === 'we') s *= ctx.weekend ? 1.25 : 0.75;
    if (t.d === 'wd') s *= ctx.weekend ? 0.75 : 1.2;
    if (t.d === 'sun') s *= ctx.sunday ? 1.4 : (ctx.weekend ? 1.05 : 0.75);
    return s;
  }

  // deterministic per hour: a refresh gives the same song, tomorrow another
  function seededIndex(seed, n) {
    let x = seed | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return Math.abs(x) % n;
  }

  function context(d) {
    const day = d.getDay();
    return {
      hour: d.getHours() + d.getMinutes() / 60,
      month: d.getMonth() + 1,
      mmdd: mmdd(d),
      weekend: day === 0 || day === 6,
      sunday: day === 0,
      anchors: anchors(d),
      seed: d.getFullYear() * 1000000 + (d.getMonth() + 1) * 10000 + d.getDate() * 100 + d.getHours()
    };
  }

  function ranked(d) {
    const ctx = context(d);
    const list = TRACKS.map((t) => ({ t, s: score(t, ctx) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, TOP_N)
      .map((x) => x.t);
    // start somewhere in the top five, weighted toward the best
    const start = [0, 0, 0, 1, 1, 2, 2, 3, 4][seededIndex(ctx.seed, 9)];
    return list.slice(start).concat(list.slice(0, start));
  }

  // ── clock ─────────────────────────────────────────────────────────────
  // Weekday always in English (the page is English); the hour format follows
  // the visitor's region (15:02 in Europe, 3:02 PM in the US). Time zone is
  // always the visitor's own, that comes for free with Date.
  const fmtDay = new Intl.DateTimeFormat('en', { weekday: 'long' });
  let fmtTime;
  try { fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', numberingSystem: 'latn' }); }
  catch (e) { fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function tick() {
    const d = new Date();
    clock.textContent = fmtDay.format(d) + ' · ' + fmtTime.format(d);
    document.body.classList.toggle('night', d.getHours() >= 23 || d.getHours() < 5);
  }

  // ── player ────────────────────────────────────────────────────────────
  let controller = null, apiReady = false, pendingUri = null, ended = false;

  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    apiReady = true;
    const el = document.createElement('div');
    embed.replaceChildren(el);
    IFrameAPI.createController(el, {
      uri: pendingUri || ('spotify:track:' + current.id),
      width: '100%', height: 80, theme: 'dark'
    }, (ctrl) => {
      controller = ctrl;
      ctrl.addListener('playback_update', (e) => {
        const p = e.data;
        if (!p || !p.duration) return;
        const atEnd = p.position >= p.duration - 1500;
        if (atEnd && p.isPaused && !ended) { ended = true; enterSilence(); }
        if (!atEnd) ended = false;
      });
    });
  };

  function fallbackIframe(id) {
    const f = document.createElement('iframe');
    f.src = EMBED + id + '?utm_source=generator&theme=0';
    f.loading = 'lazy';
    f.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    embed.replaceChildren(f);
  }

  function loadPlayer(id) {
    ended = false;
    if (controller) controller.loadUri('spotify:track:' + id);
    else if (!apiReady) pendingUri = 'spotify:track:' + id;
  }
  // if the API never arrives, use a plain embed
  setTimeout(() => { if (!apiReady) fallbackIframe(current.id); }, 4000);

  // ── render ────────────────────────────────────────────────────────────
  let queue = ranked(new Date()), qi = 0, current = queue[0];

  function show(t) {
    current = t;
    stage.classList.remove('in');
    let loaded = false;
    const img = new Image();
    img.onload = img.onerror = () => { loaded = true; };
    img.src = 'covers/' + t.cover;
    // fade out, swap once the cover is there, fade in
    setTimeout(function swap() {
      if (!loaded) { setTimeout(swap, 60); return; }
      cover.src = img.src;
      title.textContent = t.t;
      title.classList.toggle('accent', !!t.acc);
      release.textContent = (t.with_ ? 'with ' + t.with_ + ' · ' : (t.rel === t.t ? '' : t.rel + ' · ')) + t.y;
      open.href = SPOTIFY_OPEN + t.id;
      document.title = t.t + ' — Chasing Reverbs';
      loadPlayer(t.id);
      setTimeout(() => stage.classList.add('in'), 30);   // not rAF: throttled in hidden tabs
    }, 450);
  }

  function next() {
    const nowQueue = ranked(new Date());
    // keep cycling within the hour's list; refresh the list when the hour moves on
    if (nowQueue[0].id !== queue[0].id && qi >= queue.length - 1) { queue = nowQueue; qi = 0; }
    else qi = (qi + 1) % queue.length;
    show(queue[qi]);
  }

  // ── silence ───────────────────────────────────────────────────────────
  let silenceTimer = null;
  function enterSilence() {
    silence.classList.add('on');
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(leaveSilence, SILENCE_MS);
  }
  function leaveSilence() {
    clearTimeout(silenceTimer);
    if (!silence.classList.contains('on')) return;
    silence.classList.remove('on');
    next();
  }
  silence.addEventListener('click', leaveSilence);
  silence.addEventListener('touchstart', leaveSilence, { passive: true });

  another.addEventListener('click', next);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'n') next();
  });

  tick();
  setInterval(tick, 15000);
  show(current);
})();
