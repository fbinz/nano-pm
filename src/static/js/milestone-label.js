import { rocket } from '../vendor/datastar-rocket-1.0.4.js';

// One observer/layout pass per project row, not per label. CSS measures the
// actual text and ellipsizes only when it exceeds the space before the next
// diamond. Font changes therefore need no character-width estimates.
const rows = new WeakMap();

function rowLayout(row) {
  let layout = rows.get(row);
  if (layout) return layout;

  const labels = new Map();
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const right = row.getBoundingClientRect().right;
      // Sort by rendered position rather than backend/DOM order, including
      // local drag previews. Stable ordering also handles identical dates.
      const milestones = Array.from(row.querySelectorAll(':scope > .milestone'))
        .map(diamond => ({ diamond, left: diamond.getBoundingClientRect().left }))
        .sort((a, b) => a.left - b.left);
      for (let i = 0; i < milestones.length; i++) {
        const host = milestones[i].diamond.nextElementSibling;
        const setWidth = labels.get(host);
        if (!setWidth) continue;
        const boundary = milestones[i + 1]?.left ?? right;
        const left = host.getBoundingClientRect().left;
        setWidth(Math.max(0, boundary - left - 4));
      }
    });
  };

  const resize = new ResizeObserver(schedule);
  resize.observe(row);
  const mutations = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList'
      || record.target.matches('.milestone, nano-milestone-label'))) schedule();
  });
  // Watch positional styles for drags, and children for SSE insertions,
  // deletions and edits. Ignore our span's max-width writes to avoid a loop.
  mutations.observe(row, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });

  layout = {
    add(host, setWidth) {
      labels.set(host, setWidth);
      schedule();
    },
    remove(host) {
      labels.delete(host);
      if (labels.size) {
        schedule();
      } else {
        resize.disconnect();
        mutations.disconnect();
        cancelAnimationFrame(frame);
        rows.delete(row);
      }
    },
  };
  rows.set(row, layout);
  return layout;
}

// A behaviour-only Rocket component: retain the full, escaped backend label.
// Do not emit Rocket-local expressions in server HTML: Datastar may apply it
// before this module has downloaded/registered the custom element. The span's
// data-preserve-attr keeps its client-owned width across SSE morphs.
rocket('nano-milestone-label', {
  mode: 'light',
  onFirstRender({ host, cleanup }) {
    const row = host.closest('.chart-row.proj');
    if (!row) return;
    const layout = rowLayout(row);
    layout.add(host, width => {
      const text = host.firstElementChild;
      if (text) text.style.maxWidth = `${width}px`;
    });
    cleanup(() => layout.remove(host));
  },
});
