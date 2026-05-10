// nano-pm — client-side drag/resize/dep-handle/rubber-band glue.
// Datastar drives almost everything; this module only handles the live mouse
// gestures that would feel laggy through round-tripped HTML. On mouseup, the
// chosen result is sent to the server via @post — the server commits, runs
// auto-cascade, and returns the patched chart fragment.

(() => {
  "use strict";

  const ONE_DAY = 86400000;
  function chartScroll() { return document.getElementById('grid-scroll'); }
  function pxPerDay() { return parseFloat(chartScroll().dataset.pxPerDay); }
  function chartStartDate() {
    const [y, m, d] = chartScroll().dataset.chartStart.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function fmt(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  }
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }
  // Drag-gesture commits (move/resize/dep-add/rubber-band/milestone-move) are
  // dispatched as custom events. The #nano-bridge in the gantt template
  // listens for these, populates a hidden form, and lets Datastar fire the
  // actual @post + apply the SSE response. Keeps the SSE handling on Datastar
  // instead of hand-parsed in JS.
  function commit(url, data) {
    window.dispatchEvent(new CustomEvent('nano-commit', {
      detail: { url, data },
    }));
  }

  // Popover-open helpers dispatch a nano-fetch event; the bridge in the
  // gantt template forwards to Datastar's @get(url).
  function fetchInto(url) {
    window.dispatchEvent(new CustomEvent('nano-fetch', {
      detail: { url },
    }));
  }

  // ---------------------------------------------------------------------- //
  // Bar move (drag the bar body)                                           //
  // ---------------------------------------------------------------------- //
  function barMouseDown(evt, taskId) {
    if (evt.button !== 0) return;
    // Don't move if mousedown landed on a child handle.
    if (evt.target.classList.contains('resize-handle')
     || evt.target.classList.contains('dep-handle')) return;
    evt.preventDefault();
    const bar = evt.currentTarget;
    const startX = evt.clientX;
    const ppd = pxPerDay();
    const cs = chartStartDate();
    const origStart = bar.dataset.start;
    const origEnd = bar.dataset.end;
    const [sy, sm, sd] = origStart.split('-').map(Number);
    const startDate = new Date(sy, sm - 1, sd);
    const origLeft = parseFloat(bar.style.left);
    bar.classList.add('dragging');
    let moved = false;
    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dxDays = Math.round(dxPx / ppd);
      if (dxDays !== 0) moved = true;
      bar.style.left = (origLeft + dxDays * ppd) + 'px';
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bar.classList.remove('dragging');
      if (!moved) {
        openTaskPopover(taskId, ev.clientX, ev.clientY);
        return;
      }
      const dxDays = Math.round((ev.clientX - startX) / ppd);
      const newStart = fmt(addDays(startDate, dxDays));
      commit(`/tasks/${taskId}/move/`, { start: newStart });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------------------------------------------------------------------- //
  // Edge resize                                                            //
  // ---------------------------------------------------------------------- //
  function resizeEnd(evt, taskId) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    const handle = evt.currentTarget;
    const bar = handle.parentElement;
    const startX = evt.clientX;
    const ppd = pxPerDay();
    const origWidth = parseFloat(bar.style.width);
    const [ey, em, ed] = bar.dataset.end.split('-').map(Number);
    const origEnd = new Date(ey, em - 1, ed);
    bar.classList.add('dragging');
    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dxDays = Math.round(dxPx / ppd);
      const newW = Math.max(2, origWidth + dxDays * ppd);
      bar.style.width = newW + 'px';
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bar.classList.remove('dragging');
      const dxDays = Math.round((ev.clientX - startX) / ppd);
      if (dxDays === 0) return;
      const newEnd = fmt(addDays(origEnd, dxDays));
      commit(`/tasks/${taskId}/resize/end/`, { end: newEnd });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function resizeStart(evt, taskId) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    const handle = evt.currentTarget;
    const bar = handle.parentElement;
    const startX = evt.clientX;
    const ppd = pxPerDay();
    const origLeft = parseFloat(bar.style.left);
    const origWidth = parseFloat(bar.style.width);
    const [sy, sm, sd] = bar.dataset.start.split('-').map(Number);
    const origStart = new Date(sy, sm - 1, sd);
    bar.classList.add('dragging');
    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dxDays = Math.round(dxPx / ppd);
      const newLeft = origLeft + dxDays * ppd;
      const newWidth = Math.max(2, origWidth - dxDays * ppd);
      bar.style.left = newLeft + 'px';
      bar.style.width = newWidth + 'px';
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bar.classList.remove('dragging');
      const dxDays = Math.round((ev.clientX - startX) / ppd);
      if (dxDays === 0) return;
      const newStart = fmt(addDays(origStart, dxDays));
      commit(`/tasks/${taskId}/resize/start/`, { start: newStart });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------------------------------------------------------------------- //
  // Dependency-handle drag                                                  //
  // ---------------------------------------------------------------------- //
  function depHandle(evt, fromTaskId) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    evt.stopPropagation();

    // Draw a dashed line from the source bar's right edge to the cursor while
    // the user drags, so the gesture is discoverable. The line lives in an
    // overlay-local SVG that we tear down on mouseup.
    const fromBar = evt.currentTarget.parentElement;
    const overlay = document.getElementById('overlay');
    const overlayRect = overlay.getBoundingClientRect();
    const fromRect = fromBar.getBoundingClientRect();
    const sx = fromRect.right - overlayRect.left;
    const sy = fromRect.top + fromRect.height / 2 - overlayRect.top;
    // The overlay itself has width:0 (its absolute children don't contribute
    // to its intrinsic size). Use the existing #arrows SVG's rendered size
    // to know where the chart actually extends.
    const refSvg = document.getElementById('arrows');
    const refRect = refSvg ? refSvg.getBoundingClientRect() : overlayRect;
    const dragW = refRect.width;
    const dragH = overlayRect.height;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('id', 'dep-drag');
    // Sizing the SVG explicitly is what locks 1 user-unit = 1 pixel for the
    // path coordinates. Without these attrs, the user coord system defaults
    // to the spec's 300×150 and the path renders far outside the visible area.
    svg.setAttribute('width', String(dragW));
    svg.setAttribute('height', String(dragH));
    Object.assign(svg.style, {
      position: 'absolute', top: '0', left: '0',
      pointerEvents: 'none', overflow: 'visible', zIndex: '50',
    });
    const path = document.createElementNS(NS, 'path');
    // Match the committed-arrow style so the preview shows exactly what the
    // final dependency will look like.
    path.setAttribute('stroke', '#475569');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#arrowhead)');
    svg.appendChild(path);
    overlay.appendChild(svg);

    // Mirror the orthogonal routing in chart_view.build_chart_vm: a forward
    // flow uses M + 3 Ls (right stub → vertical → left to target); a backward
    // flow (cursor before source) detours through a horizontal lane.
    const stub = 8;
    function routeD(tx, ty) {
      if (sx + stub <= tx) {
        return `M ${sx} ${sy} L ${sx + stub} ${sy} L ${sx + stub} ${ty} L ${tx} ${ty}`;
      }
      const dy = ty > sy ? 14 : -14;
      return (
        `M ${sx} ${sy} L ${sx + stub} ${sy} L ${sx + stub} ${sy + dy} ` +
        `L ${tx - stub} ${sy + dy} L ${tx - stub} ${ty} L ${tx} ${ty}`
      );
    }

    function onMove(ev) {
      const tx = ev.clientX - overlayRect.left;
      const ty = ev.clientY - overlayRect.top;
      path.setAttribute('d', routeD(tx, ty));
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      svg.remove();
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      let hit = target;
      while (hit && !(hit.classList && hit.classList.contains('bar'))) hit = hit.parentElement;
      if (!hit) {
        flashHint('Drop on another task to create a dependency.');
        return;
      }
      const toId = hit.dataset.taskId;
      if (!toId || Number(toId) === fromTaskId) return;
      commit(`/dependencies/`, {
        predecessor: fromTaskId, successor: toId,
      });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Inject a transient toast into the slot the server normally writes to,
  // mirroring its DOM shape so it picks up the existing `.toast` styling.
  function flashHint(msg) {
    const slot = document.getElementById('toast-slot');
    if (!slot) return;
    slot.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    slot.appendChild(t);
    setTimeout(() => { if (slot.contains(t)) t.remove(); }, 2500);
  }

  // ---------------------------------------------------------------------- //
  // Rubber-band on a project header row → create a new task                //
  // ---------------------------------------------------------------------- //
  function projectRowMouseDown(evt, projectId) {
    if (evt.button !== 0) return;
    if (evt.target.classList.contains('milestone')
     || evt.target.classList.contains('milestone-label')) return;
    evt.preventDefault();
    const row = evt.currentTarget;
    const rect = row.getBoundingClientRect();
    const startXLocal = evt.clientX - rect.left;
    const ppd = pxPerDay();
    const cs = chartStartDate();
    const rb = document.createElement('div');
    rb.id = 'rubber-band';
    rb.style.left = startXLocal + 'px';
    rb.style.top = '4px';
    rb.style.height = (row.offsetHeight - 8) + 'px';
    rb.style.width = '0px';
    row.appendChild(rb);
    let moved = false;
    function onMove(ev) {
      const x = ev.clientX - rect.left;
      const lo = Math.min(startXLocal, x);
      const hi = Math.max(startXLocal, x);
      rb.style.left = lo + 'px';
      rb.style.width = (hi - lo) + 'px';
      if (Math.abs(x - startXLocal) > 4) moved = true;
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      rb.remove();
      if (!moved) return;
      const x = ev.clientX - rect.left;
      const lo = Math.min(startXLocal, x);
      const hi = Math.max(startXLocal, x);
      const startDays = Math.round(lo / ppd);
      const endDays = Math.round(hi / ppd);
      if (endDays - startDays < 1) return;
      commit(`/tasks/`, {
        project_id: projectId,
        title: 'New task',
        start: fmt(addDays(cs, startDays)),
        end: fmt(addDays(cs, endDays - 1)),
      });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---------------------------------------------------------------------- //
  // Milestone — drag to reschedule, click (no movement) to open editor     //
  // ---------------------------------------------------------------------- //
  function milestoneMouseDown(evt, milestoneId) {
    if (evt.button !== 0) return;
    // Stop propagation so the project-row's mousedown doesn't kick off a
    // rubber-band gesture beneath the milestone.
    evt.preventDefault();
    evt.stopPropagation();

    const target = evt.currentTarget;
    const startX = evt.clientX;
    const startY = evt.clientY;
    const ppd = pxPerDay();
    const origDate = target.dataset.date;
    const [oy, om, od] = origDate.split('-').map(Number);
    const origDateObj = new Date(oy, om - 1, od);
    const origDiamondLeft = parseFloat(target.style.left);
    // The text label is the diamond's next sibling (see milestone.html).
    const label = target.nextElementSibling;
    const origLabelLeft = (label && label.classList.contains('milestone-label'))
      ? parseFloat(label.style.left) : null;
    let moved = false;

    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dxDays = Math.round(dxPx / ppd);
      if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
        moved = true;
      }
      target.style.left = (origDiamondLeft + dxDays * ppd) + 'px';
      if (origLabelLeft !== null) {
        label.style.left = (origLabelLeft + dxDays * ppd) + 'px';
      }
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!moved) {
        openMilestonePopover(milestoneId, ev.clientX, ev.clientY);
        return;
      }
      const dxDays = Math.round((ev.clientX - startX) / ppd);
      if (dxDays === 0) return;
      const newDate = fmt(addDays(origDateObj, dxDays));
      commit(`/milestones/${milestoneId}/move/`, { date: newDate });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function openMilestonePopover(milestoneId, x, y) {
    fetchInto(`/milestones/${milestoneId}/popover/?popoverX=${Math.round(x)}&popoverY=${Math.round(y)}`);
  }

  // Server creates a placeholder milestone (today's date) and returns the
  // editor. The popover's data-init self-anchors to the freshly-rendered
  // diamond on the chart, so no client-side repositioning needed here.
  function addMilestone(projectId) {
    commit(`/projects/${projectId}/milestones/`, {});
  }

  // ---------------------------------------------------------------------- //
  // Popovers                                                               //
  // ---------------------------------------------------------------------- //
  function openTaskPopover(taskId, x, y) {
    // x, y are kept as fallback anchor coords in case the bar element isn't
    // findable by the popover's data-init (it normally is).
    fetchInto(`/tasks/${taskId}/popover/?popoverX=${Math.round(x)}&popoverY=${Math.round(y)}`);
  }

  function openProjectPopover(projectId, evt) {
    const x = evt && evt.clientX ? evt.clientX : 200;
    const y = evt && evt.clientY ? evt.clientY : 200;
    fetchInto(`/projects/${projectId}/popover/?popoverX=${Math.round(x)}&popoverY=${Math.round(y)}`);
  }

  // Floating UI handles viewport-aware popover positioning. We pass either
  // a click point (x, y) as a virtual reference or, in the new-milestone
  // flow, the actual diamond element. flip() retreats above the anchor when
  // the popover would overflow downward; shift() slides it horizontally to
  // stay in view; offset() adds a small gap to the anchor.
  function _placeWith(reference, el) {
    const FUI = window.FloatingUIDOM;
    if (!FUI) {
      // Fallback if Floating UI didn't load (offline, blocked CDN, etc.)
      const r = reference.getBoundingClientRect();
      el.style.left = Math.max(8, r.left) + 'px';
      el.style.top = Math.max(8, r.bottom + 6) + 'px';
      return;
    }
    FUI.computePosition(reference, el, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [FUI.offset(6), FUI.flip(), FUI.shift({ padding: 8 })],
    }).then(({ x, y }) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
  }

  function placePopover(el, anchorX, anchorY) {
    // Virtual reference at the click point (zero-size box at anchorX/Y).
    const ref = {
      getBoundingClientRect: () => ({
        x: anchorX, y: anchorY,
        top: anchorY, bottom: anchorY,
        left: anchorX, right: anchorX,
        width: 0, height: 0,
      }),
    };
    _placeWith(ref, el);
  }

  function placePopoverNear(el, refEl) {
    _placeWith(refEl, el);
  }

  // Called from each popover template's data-init. Looks up the reference
  // element by selector (the bar / project header / milestone diamond the
  // popover is logically anchored to) and positions the popover next to it.
  // Falls back to the click coords if the reference isn't in the DOM.
  function anchorPopover(el, refSelector, fallbackX, fallbackY) {
    const ref = refSelector && document.querySelector(refSelector);
    if (ref) placePopoverNear(el, ref);
    else placePopover(el, fallbackX, fallbackY);
  }

  function closePopover() {
    const slot = document.getElementById('popover-slot');
    if (slot) slot.innerHTML = '';
  }

  function closeModal() {
    const slot = document.getElementById('modal-slot');
    if (slot) slot.innerHTML = '';
  }

  // ---------------------------------------------------------------------- //
  // Sidebar width resize                                                   //
  // ---------------------------------------------------------------------- //
  // The sidebar is the sticky-left column controlled by the --left-w CSS
  // variable on :root. Setting it on document.documentElement.style survives
  // SSE chart patches (which only replace #grid-scroll's contents) and we
  // persist the chosen value to localStorage so it survives reloads — there's
  // no server-side notion of per-user UI prefs to push to.
  const SIDEBAR_KEY = 'nano-pm:sidebar-width';
  const SIDEBAR_MIN = 140;
  const SIDEBAR_MAX = 600;

  function setSidebarWidth(px) {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
    document.documentElement.style.setProperty('--left-w', clamped + 'px');
    return clamped;
  }

  // Pointer events so the gesture works for both mouse and touch (finger drag
  // on tablets/phones). Touch drags don't fire mousedown/mousemove/mouseup —
  // only pointer/touch events. CSS `touch-action: none` on the handle keeps
  // the browser from hijacking the drag for page scroll.
  function sidebarResizeStart(evt) {
    if (evt.button !== 0) return;
    evt.preventDefault();
    const handle = evt.currentTarget;
    const startX = evt.clientX;
    const origW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 240;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    function onMove(ev) {
      setSidebarWidth(origW + (ev.clientX - startX));
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      const finalW = setSidebarWidth(origW + (ev.clientX - startX));
      try { localStorage.setItem(SIDEBAR_KEY, String(finalW)); } catch (e) { /* ignore quota */ }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function restoreSidebarWidth() {
    let saved;
    try { saved = localStorage.getItem(SIDEBAR_KEY); } catch (e) { return; }
    if (saved == null) return;
    const px = parseFloat(saved);
    if (Number.isFinite(px)) setSidebarWidth(px);
  }

  // ---------------------------------------------------------------------- //
  // Misc                                                                   //
  // ---------------------------------------------------------------------- //
  function scrollToToday() {
    const sc = chartScroll();
    if (!sc) return;
    const ppd = pxPerDay();
    const cs = chartStartDate();
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dx = Math.round((t0 - cs) / ONE_DAY) * ppd;
    const leftW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 240;
    sc.scrollLeft = Math.max(0, dx - (sc.clientWidth - leftW) / 2);
  }

  // ---------------------------------------------------------------------- //
  window.nano = {
    barMouseDown, resizeStart, resizeEnd, depHandle,
    projectRowMouseDown, milestoneMouseDown,
    sidebarResizeStart,
    openTaskPopover, openProjectPopover, openMilestonePopover, addMilestone,
    placePopover, placePopoverNear, anchorPopover, closePopover, closeModal,
    scrollToToday,
  };

  // Restore sidebar width before first paint so the chart doesn't flash at the
  // default 240 then jump to the saved value on the next frame.
  restoreSidebarWidth();

  // Initial: jump to today.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(scrollToToday, 0);
  });
})();
