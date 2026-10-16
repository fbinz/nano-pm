// Shared click-and-drag panning for the editable chart and public roadmap.
(() => {
  "use strict";

  const INTERACTIVE_SELECTOR = [
    'a', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable="true"]',
    '.bar', '.milestone', '#arrows .hit', '.task-creation-timeline', '.creation-target',
    '.roadmap-project-label', '.roadmap-corner',
  ].join(',');

  document.addEventListener('pointerdown', evt => {
    if (evt.button !== 0 || evt.isPrimary === false) return;
    // Keep native touch/pen scrolling and editing/creation gestures intact.
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const sc = evt.target.closest?.('#grid-scroll, [data-roadmap-chart]');
    if (!sc || evt.shiftKey || sc.classList.contains('creation-mode')) return;
    if (evt.target.closest(INTERACTIVE_SELECTOR)) return;

    const roadmap = sc.hasAttribute('data-roadmap-chart');
    const rect = sc.getBoundingClientRect();
    const leftW = roadmap
      ? sc.querySelector('.roadmap-project-label')?.getBoundingClientRect().width || 0
      : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 240;
    // Leave project labels and native scrollbar drags alone.
    if (evt.clientX < rect.left + leftW
      || evt.clientX >= rect.left + sc.clientWidth
      || evt.clientY >= rect.top + sc.clientHeight) return;

    evt.preventDefault();
    const pointerId = evt.pointerId;
    const startX = evt.clientX;
    const startY = evt.clientY;
    const startLeft = sc.scrollLeft;
    const startTop = roadmap ? window.scrollY : sc.scrollTop;
    const pageLeft = window.scrollX;
    sc.classList.add('chart-panning');
    document.body.classList.add('chart-panning');

    function cleanup() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', cleanup);
      sc.classList.remove('chart-panning');
      document.body.classList.remove('chart-panning');
    }
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      sc.scrollLeft = startLeft - (ev.clientX - startX);
      const top = startTop - (ev.clientY - startY);
      // The roadmap grows with its content: vertical panning moves the page.
      if (roadmap) window.scrollTo(pageLeft, top);
      else sc.scrollTop = top;
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    }
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', cleanup);
  });
})();
