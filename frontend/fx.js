// DOM-level motion: 3D card tilt with glare, staggered page reveal, count-up
// stats and hero parallax. Everything is opt-out under prefers-reduced-motion.
const TILT = '.panel, .hx-feature, .hx-stats > div, .comparison-headline';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountTilt(root) {
  if (reducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return () => {};
  let active = null, frame = 0;
  const reset = el => {el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); el.classList.remove('is-tilting');};
  const onMove = event => {
    const el = event.target.closest?.(TILT);
    if (active && active !== el) reset(active);
    active = el && root.contains(el) ? el : null;
    if (!active) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!active) return;
      const box = active.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
      // Kept to a couple of degrees so text stays sharp in screen recordings.
      const max = Math.max(0.6, Math.min(2.5, 900 / Math.max(box.width, box.height)));
      active.classList.add('is-tilting');
      active.style.setProperty('--rx', `${((0.5 - y) * max).toFixed(2)}deg`);
      active.style.setProperty('--ry', `${((x - 0.5) * max).toFixed(2)}deg`);
      active.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
      active.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
    });
  };
  const onLeave = () => {if (active) reset(active); active = null;};
  root.addEventListener('pointermove', onMove, {passive: true});
  root.addEventListener('pointerleave', onLeave);
  return () => {cancelAnimationFrame(frame); root.removeEventListener('pointermove', onMove); root.removeEventListener('pointerleave', onLeave);};
}

// Assign stagger order to the visible cards of the freshly mounted page.
export function staggerReveal(main) {
  [...main.querySelectorAll(`${TILT}, .model-table, .comparison-note`)].forEach((el, index) => {
    el.style.setProperty('--i', Math.min(index, 14));
    el.classList.add('reveal');
  });
}

// Animate numbers such as "~ 28 KB" or "< 8%" from zero to their value.
export function countUp(scope) {
  if (reducedMotion()) return;
  scope.querySelectorAll('.hx-stats strong, .comparison-headline-badges strong, .final-badge strong').forEach(el => {
    const node = [...el.childNodes].find(child => child.nodeType === 3 && /\d/.test(child.textContent));
    if (!node) return;
    const text = node.textContent, match = text.match(/[\d,]+(\.\d+)?/);
    if (!match) return;
    const target = parseFloat(match[0].replace(/,/g, '')), decimals = match[1] ? match[1].length - 1 : 0;
    const grouped = match[0].includes(','), start = performance.now(), duration = 1400;
    const format = value => {
      const fixed = value.toFixed(decimals);
      return grouped ? Number(fixed).toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) : fixed;
    };
    const step = now => {
      const p = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - p, 4);
      node.textContent = text.replace(match[0], format(target * eased));
      if (p < 1) requestAnimationFrame(step); else node.textContent = text;
    };
    requestAnimationFrame(step);
  });
}

export function mountHeroParallax(hero) {
  if (!hero || reducedMotion()) return () => {};
  let frame = 0;
  const onMove = event => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const x = event.clientX / window.innerWidth - 0.5, y = event.clientY / window.innerHeight - 0.5;
      hero.style.setProperty('--px', x.toFixed(3));
      hero.style.setProperty('--py', y.toFixed(3));
    });
  };
  window.addEventListener('pointermove', onMove, {passive: true});
  return () => {cancelAnimationFrame(frame); window.removeEventListener('pointermove', onMove);};
}

// Orbit cursor: a saffron core, a lagging ring with a satellite circling it,
// and a ripple on click. Fine pointers only; the native cursor stays for text.
const CURSOR_HOT = 'a, button, [role="button"], .panel, .hx-feature, .hx-stats > div, .mission-step, .hx-globe';
export function mountCursor() {
  if (reducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return () => {};
  const root = document.createElement('div');
  root.className = 'orbit-cursor';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = '<span class="oc-ring"><i class="oc-sat"></i></span><span class="oc-dot"></span>';
  document.body.appendChild(root);
  document.documentElement.classList.add('has-orbit-cursor');
  const ring = root.firstChild, dot = root.lastChild;
  let x = -100, y = -100, rx = x, ry = y, frame = 0, seen = false;
  const onMove = event => {
    x = event.clientX; y = event.clientY;
    if (!seen) {rx = x; ry = y; seen = true; root.classList.add('visible');}
    const el = event.target.closest?.(CURSOR_HOT);
    root.classList.toggle('hot', Boolean(el && el.matches('a, button, [role="button"]')));
    root.classList.toggle('warm', Boolean(el && !el.matches('a, button, [role="button"]')));
  };
  const onDown = event => {
    const ripple = document.createElement('span');
    ripple.className = 'oc-ripple';
    ripple.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    document.body.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
    root.classList.add('down');
  };
  const onUp = () => root.classList.remove('down');
  const onLeave = () => {root.classList.remove('visible'); seen = false;};
  const tick = () => {
    rx += (x - rx) * 0.4; ry += (y - ry) * 0.4;
    dot.style.transform = `translate(${x}px, ${y}px)`;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    frame = requestAnimationFrame(tick);
  };
  window.addEventListener('pointermove', onMove, {passive: true});
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  document.addEventListener('pointerleave', onLeave);
  tick();
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointerleave', onLeave);
    document.documentElement.classList.remove('has-orbit-cursor');
    root.remove();
  };
}
