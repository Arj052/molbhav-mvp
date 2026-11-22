// Page animations with Motion (motion.dev). Purely decorative: if Motion fails to load or the visitor
// prefers reduced motion, this does nothing and the plain CSS reveal in styles.css is used instead.
(function () {
  const M = window.Motion;
  if (!M || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const { animate, scroll, inView, stagger, hover } = M;
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ease = [0.2, 0.7, 0.2, 1];
  const springy = { type: 'spring', stiffness: 260, damping: 22 };
  document.documentElement.classList.add('motion-on');

  // red progress bar across the top as you scroll
  const bar = document.getElementById('progress');
  if (bar) scroll(animate(bar, { scaleX: [0, 1] }, { ease: 'linear' }));

  // a light green "money" glow mixes in as you scroll down, and faint ₹ signs float up
  const money = document.querySelector('.money');
  if (money) scroll(animate(money, { opacity: [0.12, 0.85] }, { ease: 'linear' }));
  $$('.coins i').forEach((c, i) => {
    const rise = 160 + (i % 4) * 70;
    c.style.color = 'rgba(62,207,122,.55)';
    scroll(animate(c, { y: [0, -rise], opacity: [0, 0.55, 0.25], rotate: [0, i % 2 ? 12 : -12] }, { ease: 'linear' }));
  });

  // background glows drift slowly
  $$('.orb').forEach((o, i) => animate(o, {
    x: [0, i % 2 ? -90 : 110, i % 2 ? 60 : -50, 0],
    y: [0, -70, 50, 0],
    scale: [1, 1.15, 0.95, 1],
  }, { duration: 16 + i * 5, repeat: Infinity, ease: 'easeInOut' }));

  // ---------- scroll story: pinned full-screen scenes that cross-fade and zoom as you scroll ----------
  const story = document.getElementById('story');
  if (story) {
    const scenes = $$('[data-scene]', story);
    const n = scenes.length;
    const nowEl = document.getElementById('storyNow');
    const barEl = document.getElementById('storyBar');
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const render = (p) => {
      const pos = clamp(p, 0, 1) * (n - 1); // 0 … n-1
      scenes.forEach((sc, i) => {
        const d = pos - i; // <0 coming up, 0 on screen, >0 leaving
        let o = clamp(1 - Math.abs(d), 0, 1);
        if (i === 0 && d < 0) o = 1;
        if (i === n - 1 && d > 0) o = 1;
        sc.style.opacity = o.toFixed(3);
        sc.style.zIndex = String(o > 0.5 ? 2 : 1);
        sc.style.pointerEvents = o > 0.5 ? 'auto' : 'none';
        // photo slowly zooms out while its scene is on screen (1.18 -> 1.0) and drifts up a little
        const bg = sc.querySelector('.scene-bg');
        const k = clamp((d + 1) / 2, 0, 1);
        bg.style.transform = `scale(${(1.18 - 0.18 * k).toFixed(4)}) translateY(${(-d * 3).toFixed(2)}%)`;
        // title rises in sharp and leaves upward with a blur
        const copy = sc.querySelector('.scene-copy');
        let cd = clamp(d, -1, 1);
        if (i === 0 && d < 0) cd = 0;
        if (i === n - 1 && d > 0) cd = 0;
        copy.style.opacity = clamp(1 - Math.abs(cd) * 1.7, 0, 1).toFixed(3);
        copy.style.transform = `translateY(${(-cd * 70).toFixed(1)}px) scale(${(1 - Math.abs(cd) * 0.06).toFixed(3)})`;
        copy.style.filter = `blur(${(Math.abs(cd) * 12).toFixed(1)}px)`;
      });
      // theme follows the scene on screen; once past the story it goes back to the chosen vegetable
      const inStory = p > 0.001 && p < 0.999;
      window.mbStoryActive = inStory;
      const sceneVeg = scenes[Math.min(n - 1, Math.round(pos))].dataset.veg || 'tomato';
      document.body.dataset.veg = inStory ? sceneVeg : (p <= 0.001 ? 'tomato' : (window.mbSelectedVeg || 'tomato'));
      if (nowEl) nowEl.textContent = String(Math.min(n, Math.round(pos) + 1)).padStart(2, '0');
      if (barEl) barEl.style.transform = `scaleX(${clamp(p, 0, 1).toFixed(4)})`;
    };
    render(0);
    scroll(render, { target: story, offset: ['start start', 'end end'] });
    // the big title glows in on first load
    const mega = story.querySelector('.mega');
    if (mega) animate(mega, { opacity: [0, 1], letterSpacing: ['0.08em', '-0.05em'], filter: ['blur(14px)', 'blur(0px)'] }, { duration: 1.4, ease });
  }

  // split section headings into words so they can rise in one by one
  $$('.section .sec-head h2, .cta-band h2').forEach((h) => {
    if (h.dataset.split) return;
    h.dataset.split = '1';
    const words = h.textContent.trim().split(/\s+/);
    h.textContent = '';
    words.forEach((w, i) => {
      const s = document.createElement('span'); s.className = 'w'; s.textContent = w; h.append(s);
      if (i < words.length - 1) h.append(' ');
    });
  });

  // sections and cards reveal as they scroll into view; siblings arrive one after another
  $$('[data-reveal]').forEach((el) => { el.style.opacity = '0'; });
  inView('[data-reveal]', (el) => {
    const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.hasAttribute('data-reveal')) : [];
    const delay = Math.min(Math.max(siblings.indexOf(el), 0), 6) * 0.09;
    animate(el, { opacity: [0, 1], y: [42, 0], filter: ['blur(8px)', 'blur(0px)'] }, { duration: 0.85, delay, ease });
    const words = el.querySelectorAll('.w');
    if (words.length) animate(words, { opacity: [0, 1], y: ['0.7em', '0em'], rotate: [4, 0], filter: ['blur(10px)', 'blur(0px)'] }, { delay: stagger(0.07, { startDelay: delay + 0.1 }), duration: 0.8, ease });
    const bigs = el.querySelectorAll('.big');
    if (bigs.length) animate(bigs, { opacity: [0, 1], scale: [1.25, 1], filter: ['blur(12px)', 'blur(0px)'] }, { duration: 0.9, delay: delay + 0.1, ease });
  }, { amount: 0.12 });

  // cards spring up slightly on hover
  hover('.tile, .band > div, .steps li, .price-card', (el) => {
    animate(el, { scale: 1.02 }, springy);
    return () => animate(el, { scale: 1 }, springy);
  });

  // soft red spotlight follows the pointer (mouse / trackpad only)
  const spot = document.getElementById('spot');
  if (spot && window.matchMedia('(pointer: fine)').matches) {
    let shown = false;
    window.addEventListener('pointermove', (e) => {
      if (!shown) { spot.classList.add('on'); shown = true; }
      animate(spot, { x: e.clientX, y: e.clientY }, { type: 'spring', stiffness: 140, damping: 22, mass: 0.6 });
    }, { passive: true });
  }
})();
