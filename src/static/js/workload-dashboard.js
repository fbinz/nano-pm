// Progressive enhancement: all shares and month details work without JavaScript.
const timeline = document.getElementById('workload-timeline');
timeline?.addEventListener('click', event => {
  const button = event.target.closest('[data-highlight-category]');
  if (!button) return;
  const selected = button.getAttribute('aria-pressed') !== 'true'
    ? button.dataset.highlightCategory : null;
  timeline.querySelectorAll('[data-highlight-category]').forEach(item => {
    item.setAttribute('aria-pressed', String(item.dataset.highlightCategory === selected));
  });
  timeline.querySelectorAll('[data-category-key]').forEach(segment => {
    segment.classList.toggle('is-muted', selected !== null && segment.dataset.categoryKey !== selected);
  });
});
