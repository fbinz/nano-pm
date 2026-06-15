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
  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content ||
      document.querySelector('[name=csrfmiddlewaretoken]')?.value || '';
  }
  // Drag-gesture commits (move/resize/dep-add/rubber-band/milestone-move) are
  // dispatched as custom events. The app shell forwards these to Datastar's
  // @post with the command data as JSON payload, and Datastar applies the SSE
  // response. Keeps SSE handling on Datastar instead of hand-parsed in JS.
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

  // Orthogonal arrow routing — mirrors chart_view.build_chart_vm: a forward
  // flow uses M + 3 Ls (right stub → vertical → left to target); a backward
  // flow (target before source) detours through a horizontal lane.
  const ARROW_STUB = 8;
  function routeArrow(sx, sy, tx, ty) {
    if (sx + ARROW_STUB <= tx) {
      return `M ${sx} ${sy} L ${sx + ARROW_STUB} ${sy} L ${sx + ARROW_STUB} ${ty} L ${tx} ${ty}`;
    }
    const dy = ty > sy ? 14 : -14;
    return (
      `M ${sx} ${sy} L ${sx + ARROW_STUB} ${sy} L ${sx + ARROW_STUB} ${sy + dy} ` +
      `L ${tx - ARROW_STUB} ${sy + dy} L ${tx - ARROW_STUB} ${ty} L ${tx} ${ty}`
    );
  }

  // ---------------------------------------------------------------------- //
  // Selection (purely client-side; survives SSE re-renders via MutationObserver) //
  // ---------------------------------------------------------------------- //
  const selectedTaskIds = new Set();
  function applySelection() {
    document.querySelectorAll('.bar.selected').forEach(b => b.classList.remove('selected'));
    for (const id of selectedTaskIds) {
      const el = document.getElementById(`bar-${id}`);
      if (el) el.classList.add('selected');
    }
  }
  function toggleSelection(taskId) {
    if (selectedTaskIds.has(taskId)) selectedTaskIds.delete(taskId);
    else selectedTaskIds.add(taskId);
    applySelection();
  }
  function clearSelection() {
    if (selectedTaskIds.size === 0) return;
    selectedTaskIds.clear();
    applySelection();
  }

  // ---------------------------------------------------------------------- //
  // Bar move (drag the bar body)                                           //
  // ---------------------------------------------------------------------- //
  function barMouseDown(evt, taskId) {
    if (evt.button !== 0) return;
    // Don't move if mousedown landed on a child handle.
    if (evt.target.classList.contains('resize-handle')
     || evt.target.classList.contains('dep-handle')) return;
    // Shift-click toggles the bar in/out of the selection. No drag, no popover.
    if (evt.shiftKey) {
      evt.preventDefault();
      evt.stopPropagation();
      toggleSelection(taskId);
      return;
    }
    evt.preventDefault();
    const bar = evt.currentTarget;
    const startX = evt.clientX;
    const ppd = pxPerDay();
    const cs = chartStartDate();
    const origStart = bar.dataset.start;
    const [sy, sm, sd] = origStart.split('-').map(Number);
    const startDate = new Date(sy, sm - 1, sd);

    // If the grabbed bar is part of a multi-selection, drag the whole set.
    const isMulti = selectedTaskIds.has(taskId) && selectedTaskIds.size > 1;
    const dragIds = isMulti ? Array.from(selectedTaskIds) : [taskId];
    const dragSet = new Set(dragIds);
    const dragBars = dragIds
      .map(id => document.getElementById(`bar-${id}`))
      .filter(b => b);
    const origLefts = new Map(dragBars.map(b => [b, parseFloat(b.style.left)]));
    dragBars.forEach(b => b.classList.add('dragging'));

    // Snapshot every dep arrow that touches the drag set so we can re-route
    // it live during the gesture. Parsing the existing `d` is cheaper than
    // recomputing bar y-centers (the y values don't change on a horizontal
    // drag — only x does), and keeps this code from duplicating the row-
    // layout arithmetic in chart_view.py.
    const arrowState = [];
    document.querySelectorAll('#arrows .hit[data-dep]').forEach(hit => {
      const [fromId, toId] = hit.dataset.dep.split('-').map(Number);
      if (!dragSet.has(fromId) && !dragSet.has(toId)) return;
      const nums = (hit.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g);
      if (!nums || nums.length < 4) return;
      const visPath = hit.nextElementSibling;
      arrowState.push({
        fromId, toId,
        origSx: parseFloat(nums[0]), sy: parseFloat(nums[1]),
        origTx: parseFloat(nums[nums.length - 2]), ty: parseFloat(nums[nums.length - 1]),
        hitPath: hit, visPath,
      });
    });

    let moved = false;
    function onMove(ev) {
      const dxPx = ev.clientX - startX;
      const dxDays = Math.round(dxPx / ppd);
      if (dxDays !== 0) moved = true;
      const offset = dxDays * ppd;
      dragBars.forEach(b => {
        b.style.left = (origLefts.get(b) + offset) + 'px';
      });
      arrowState.forEach(a => {
        const sx = a.origSx + (dragSet.has(a.fromId) ? offset : 0);
        const tx = a.origTx + (dragSet.has(a.toId) ? offset : 0);
        const d = routeArrow(sx, a.sy, tx, a.ty);
        a.hitPath.setAttribute('d', d);
        if (a.visPath) a.visPath.setAttribute('d', d);
      });
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      dragBars.forEach(b => b.classList.remove('dragging'));
      if (!moved) {
        openTaskPopover(taskId);
        return;
      }
      const dxDays = Math.round((ev.clientX - startX) / ppd);
      if (isMulti) {
        commit(`/tasks/move-many/`, {
          task_ids: dragIds.join(','), delta_days: dxDays,
        });
      } else {
        commit(`/tasks/${taskId}/move/`, { start: fmt(addDays(startDate, dxDays)) });
      }
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

    function onMove(ev) {
      const tx = ev.clientX - overlayRect.left;
      const ty = ev.clientY - overlayRect.top;
      path.setAttribute('d', routeArrow(sx, sy, tx, ty));
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      svg.remove();
      let hit = document.elementsFromPoint(ev.clientX, ev.clientY)
        .find(el => el.classList && el.classList.contains('bar'));
      if (!hit) {
        hit = [...document.querySelectorAll('.bar')].find(el => {
          const r = el.getBoundingClientRect();
          return ev.clientX >= r.left && ev.clientX <= r.right &&
            ev.clientY >= r.top && ev.clientY <= r.bottom;
        });
      }
      if (!hit) {
        // gettext() comes from Django's JavaScriptCatalog (djangojs domain),
        // loaded via the jsi18n <script> in app-shell. Falls back to the
        // source string if the catalog hasn't loaded.
        const _ = window.gettext || (s => s);
        flashHint(_('Drop on another task to create a dependency.'));
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
      if (!moved) {
        // Click without a drag → create a milestone at the click date.
        const days = Math.round((ev.clientX - rect.left) / ppd);
        addMilestone(projectId, fmt(addDays(cs, days)));
        return;
      }
      const x = ev.clientX - rect.left;
      const lo = Math.min(startXLocal, x);
      const hi = Math.max(startXLocal, x);
      const startDays = Math.round(lo / ppd);
      const endDays = Math.round(hi / ppd);
      if (endDays - startDays < 1) return;
      commit(`/tasks/create/`, {
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
        openMilestonePopover(milestoneId);
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

  // Server creates a placeholder milestone and returns the editor (which
  // opens the right drawer). Optional `date` (YYYY-MM-DD) places the
  // milestone at that day; default is today.
  function addMilestone(projectId, date) {
    commit(`/projects/${projectId}/milestones/`, date ? { date } : {});
  }

  // ---------------------------------------------------------------------- //
  // Drawer (task / milestone / project editors and the People sheet)       //
  // ---------------------------------------------------------------------- //
  // Server returns a fragment whose root is <div id="drawer-slot">…</div>;
  // Datastar swaps it into the persistent drawer shell. The slot's "is
  // populated?" state drives the slide-in via a :has() rule in CSS.
  function openTaskPopover(taskId) {
    fetchInto(`/tasks/${taskId}/popover/`);
  }
  function openProjectPopover(projectId) {
    fetchInto(`/projects/${projectId}/popover/`);
  }
  function openMilestonePopover(milestoneId) {
    fetchInto(`/milestones/${milestoneId}/popover/`);
  }

  function closeDrawer() {
    const slot = document.getElementById('drawer-slot');
    if (slot) slot.innerHTML = '';
  }

  function onCollapseChanged(id, urlBase) {
    requestAnimationFrame(recalcArrows);
    const token = csrfToken();
    if (token) {
      const base = urlBase || '/projects';
      fetch(`${base}/${id}/toggle-collapse/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': token },
      });
    }
  }

  function onCollapseAllChanged(collapse, ids, urlBase) {
    requestAnimationFrame(recalcArrows);
    const token = csrfToken();
    if (token) {
      const base = urlBase || '/projects';
      fetch(`${base}/set-collapsed/`, {
        method: 'POST',
        headers: { 'X-CSRFToken': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'ids=' + (collapse ? ids.join(',') : ''),
      });
    }
  }

  function recalcArrows() {
    const grid = document.getElementById('grid');
    if (!grid) return;
    const barYCenters = {};
    const barPos = {};
    let y = 0;
    for (const el of grid.children) {
      if (el.matches('.chart-row.proj')) {
        y += 36;
      } else if (el.matches('.chart-row.add-project-spacer')) {
        // PMs see "Add Project" spacer rows before and after the project list
        // (chart.html). They take a full row_h of vertical space — counting
        // them keeps arrow y-coords aligned with bar y-coords.
        y += 32;
      } else if (el.matches('.chart-row[data-task-id]')) {
        if (getComputedStyle(el).display === 'none') continue;
        const taskId = el.dataset.taskId;
        const bar = el.querySelector('.bar');
        if (bar) {
          barYCenters[taskId] = y + 16;
          barPos[taskId] = { x: parseFloat(bar.style.left), w: parseFloat(bar.style.width) };
        }
        y += 32;
      }
    }
    for (const hit of document.querySelectorAll('#arrows path.hit[data-dep]')) {
      const [fromId, toId] = hit.dataset.dep.split('-');
      const vis = hit.nextElementSibling;
      if (!barYCenters[fromId] || !barYCenters[toId]) {
        hit.style.display = 'none';
        if (vis) vis.style.display = 'none';
        continue;
      }
      hit.style.display = '';
      if (vis) vis.style.display = '';
      const d = routeArrow(
        barPos[fromId].x + barPos[fromId].w, barYCenters[fromId],
        barPos[toId].x, barYCenters[toId],
      );
      hit.setAttribute('d', d);
      if (vis) vis.setAttribute('d', d);
    }
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
  // Position the workspace popover below the chevron trigger. Called from
  // `data-on:toggle` when the native popover opens; native popover renders in
  // the top layer (escaping sidebar overflow clipping) so we just need to set
  // its viewport coordinates.
  function positionWorkspaceMenu(menu) {
    const trigger = document.querySelector('.ws-chevron-btn');
    if (!trigger || !menu) return;
    const r = trigger.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `12px`;
  }

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
    closeDrawer, onCollapseChanged, onCollapseAllChanged, recalcArrows,
    scrollToToday, positionWorkspaceMenu,
  };

  // Restore sidebar width before first paint so the chart doesn't flash at the
  // default 240 then jump to the saved value on the next frame.
  restoreSidebarWidth();

  // Re-apply .bar.selected whenever the chart fragment is patched in (SSE
  // round-trips replace bar elements wholesale, so the class is gone otherwise).
  // We watch `body` rather than `#grid-scroll` because Datastar's patch
  // replaces the #grid-scroll element itself — an observer bound to the old
  // element would be orphaned. childList only (no attributes) keeps this
  // quiet during drags, which mutate style but never insert nodes.
  document.addEventListener('keydown', evt => {
    if (evt.key === 'Escape') clearSelection();
  });

  // Datastar fires `datastar-fetch` with detail.type = "finished" after the
  // SSE response has been processed and all chart DOM patches applied.
  // That's our cue to re-attach .selected to currently-selected bars (the
  // server template doesn't know about selection state, so the patched
  // markup arrives without the class).
  document.addEventListener('datastar-fetch', evt => {
    if (evt.detail && evt.detail.type === 'finished') {
      applySelection();
      recalcArrows();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(scrollToToday, 0);
  });
})();
