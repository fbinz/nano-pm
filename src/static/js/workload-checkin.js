import './workload.js';

const dialog = document.getElementById('workload-checkin-dialog');
if (dialog) {
  const trigger = document.querySelector('[data-workload-checkin-open]');
  const key = dialog.dataset.dismissalKey;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(key) === 'dismissed'; } catch (_) { /* Storage may be disabled. */ }
  const open = () => {
    if (!dialog.isConnected || dialog.open) return;
    dialog.showModal();
    document.getElementById('workload-checkin-title').focus();
  };
  const dismiss = () => {
    try { sessionStorage.setItem(key, 'dismissed'); } catch (_) { /* Closing must still work. */ }
    dialog.close();
    trigger.focus();
  };
  trigger.addEventListener('click', open);
  dialog.querySelector('[data-workload-checkin-close]').addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dismiss();
  });
  if (!dismissed) open();
  dialog.dataset.initialized = 'true';
}
