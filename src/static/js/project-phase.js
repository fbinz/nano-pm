// A small, deliberate gesture. Local progress is only a preview: phase state
// and the success celebration always come from the server's SSE patch.
const control = document.querySelector('.project-lifecycle-control');
if (control) {
  const gettext = window.gettext || (value => value);
  const duration = Number(control.dataset.holdDuration);
  let active = null;
  let pending = null;
  let celebrationTimer = 0;
  let sequence = 0;

  const feedback = () => document.getElementById('project-phase-feedback');
  const buttonFor = target => target instanceof Element ? target.closest('.phase-step') : null;
  const announce = message => {
    const node = feedback();
    node.setAttribute('role', 'status');
    node.textContent = message;
  };
  const busy = value => {
    control.toggleAttribute('data-phase-busy', value);
    document.getElementById('project-lifecycle').setAttribute('aria-busy', String(value));
  };
  const endHold = state => {
    const hold = active;
    if (!hold) return;
    active = null;
    cancelAnimationFrame(hold.frame);
    if (state) hold.button.dataset.holdState = state;
    else {
      delete hold.button.dataset.holdState;
      hold.button.style.removeProperty('--hold-progress');
    }
    if (hold.pointerId !== undefined && hold.button.hasPointerCapture(hold.pointerId)) {
      hold.button.releasePointerCapture(hold.pointerId);
    }
  };
  const cancel = () => {
    if (!active) return;
    endHold();
    announce(gettext('No change. Take your time.'));
  };
  const fail = () => {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timeout);
    busy(false);
    const button = document.getElementById(request.buttonId);
    if (button) {
      delete button.dataset.holdState;
      button.style.removeProperty('--hold-progress');
    }
    announce(gettext('Could not confirm the phase change. Please try again or reload to check.'));
    feedback().dataset.phaseResult = 'error';
  };

  const commit = () => {
    const button = active.button;
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++sequence}`;
    const reason = document.querySelector('[name="reason"]')?.value || '';
    endHold('saving');
    busy(true);
    announce(gettext('Saving this little step…'));
    pending = {
      id, buttonId: button.id, reason,
      timeout: setTimeout(fail, 15000), fetchElement: null,
    };
    const journal = new URLSearchParams(window.location.search);
    window.dispatchEvent(new CustomEvent('nano-commit', { detail: {
      url: control.dataset.phaseUrl,
      data: {
        phase: button.dataset.phase,
        reason,
        interaction: 'hold', phase_operation: id,
        journal_kind: journal.get('kind') || '', journal_page: journal.get('page') || '1',
        journal_present: document.querySelector('.journal-entries') !== null,
      },
    } }));
  };

  const start = (button, input) => {
    if (pending || active || !button || !control.contains(button)
      || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    clearTimeout(celebrationTimer);
    for (const previous of control.querySelectorAll('[data-hold-state="success"]')) {
      delete previous.dataset.holdState;
    }
    const hold = { button, ...input, started: performance.now(), frame: 0 };
    active = hold;
    button.dataset.holdState = 'holding';
    button.style.setProperty('--hold-progress', '0');
    delete feedback().dataset.phaseResult;
    announce(gettext('Keep holding…'));
    const tick = now => {
      if (active !== hold) return;
      if (!button.isConnected || document.hidden) { cancel(); return; }
      const progress = Math.min(1, (now - hold.started) / duration);
      button.style.setProperty('--hold-progress', String(progress));
      if (progress === 1) commit();
      else hold.frame = requestAnimationFrame(tick);
    };
    hold.frame = requestAnimationFrame(tick);
  };

  control.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const button = buttonFor(event.target);
    start(button, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
    if (active?.button === button) button.setPointerCapture(event.pointerId);
  });
  control.addEventListener('pointermove', event => {
    if (!active || active.pointerId !== event.pointerId) return;
    const rect = active.button.getBoundingClientRect();
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 12
      || event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) cancel();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    control.addEventListener(name, event => {
      if (active?.pointerId === event.pointerId) cancel();
    });
  }
  control.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key) || !buttonFor(event.target)) return;
    event.preventDefault();
    if (!event.repeat) start(buttonFor(event.target), { key: event.key });
  });
  control.addEventListener('keyup', event => {
    if (active?.key === event.key) { event.preventDefault(); cancel(); }
  });
  control.addEventListener('focusout', event => {
    if (active?.button === event.target) cancel();
  });
  control.addEventListener('click', event => {
    const button = buttonFor(event.target);
    if (!button) return;
    event.preventDefault();
    if (!pending && !button.disabled && button.getAttribute('aria-current') !== 'step') {
      announce(gettext('Hold a little longer to change phase.'));
    }
  });
  control.addEventListener('contextmenu', event => {
    if (buttonFor(event.target)) event.preventDefault();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  document.addEventListener('scroll', cancel, { capture: true, passive: true });
  window.addEventListener('blur', cancel);
  window.addEventListener('pagehide', cancel);

  // Morphing the server-rendered strip keeps focus/scroll and unposted notes.
  // Correlate feedback with this exact hold; old patches cannot celebrate it.
  new MutationObserver(() => {
    const result = feedback();
    if (!pending || result.dataset.phaseOperation !== pending.id) return;
    if (result.dataset.phaseResult === 'error') {
      const message = result.textContent;
      fail();
      announce(message);
      return;
    }
    if (result.dataset.phaseResult !== 'success') return;
    clearTimeout(pending.timeout);
    const button = document.getElementById(pending.buttonId);
    const submittedReason = pending.reason;
    pending = null;
    busy(false);
    if (button) {
      button.style.removeProperty('--hold-progress');
      button.dataset.holdState = 'success';
      celebrationTimer = setTimeout(() => { delete button.dataset.holdState; }, 1600);
    }
    const select = document.querySelector('[name="phase"]');
    if (select) select.value = result.dataset.committedPhase;
    const reason = document.querySelector('[name="reason"]');
    if (reason?.value === submittedReason) reason.value = '';
  }).observe(control, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase-operation', 'data-phase-result'] });

  document.addEventListener('datastar-fetch', event => {
    if (!pending) return;
    if (event.detail.type === 'started' && !pending.fetchElement) pending.fetchElement = event.detail.el;
    if (event.detail.el !== pending.fetchElement) return;
    if (['error', 'retries-failed'].includes(event.detail.type)) fail();
    else if (event.detail.type === 'finished') {
      const id = pending?.id;
      // A missing SSE acknowledgement (e.g. an expired login) is not success.
      queueMicrotask(() => { if (pending?.id === id) fail(); });
    }
  });
  control.dataset.phaseReady = 'true';
}
