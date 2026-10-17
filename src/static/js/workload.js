// Draft-only preview. Named number inputs remain the source of truth for the
// existing form/SSE endpoint; no allocations are persisted until explicit save.
const gettext = window.gettext || (text => text);
const message = (text, values = {}) => text.replace(/%\((\w+)\)s/g, (_, key) => values[key]);
const number = input => Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0;
const percentage = input => Math.max(0, Math.min(100, number(input)));
const valid = input => input.value !== '' && input.validity.valid;
const setText = (element, text) => { if (element && element.textContent !== text) element.textContent = text; };

function projectArc(arc, amount, offset, visible) {
  const gap = amount === 100 ? 0 : 0.4;
  arc.dataset.percentage = amount;
  arc.style.display = visible && amount > 0 ? '' : 'none';
  arc.setAttribute('stroke-dasharray', `${Math.max(0, amount - gap)} ${100 - amount + gap}`);
  arc.setAttribute('stroke-dashoffset', -offset - gap / 2);
  if (arc.getAttribute('role') === 'button') arc.setAttribute('tabindex', visible && amount > 0 ? '0' : '-1');
}

function preview() {
  const form = document.getElementById('workload-form');
  if (!form) return;
  const rows = [...form.querySelectorAll('[data-workload-row]')];
  const total = rows.reduce((sum, row) => sum + number(row.querySelector('[data-workload-percentage]')), 0);
  const remaining = Math.max(0, 100 - total);
  const categoriesValid = rows.every(row => valid(row.querySelector('[data-workload-percentage]')));
  let validDraft = total === 100 && rows.length > 0 && categoriesValid;
  let offset = 0;
  let hasProjectBreakdown = false;
  form.dataset.total = total;
  form.dataset.over = total > 100;
  form.dataset.invalid = !categoriesValid;
  setText(form.querySelector('#workload-total'), categoriesValid ? `${total}%` : '—');
  setText(form.querySelector('[data-workload-center-value]'), `${total}%`);
  setText(form.querySelector('[data-workload-center-label]'), gettext('allocated'));
  setText(form.querySelector('[data-workload-feedback]'), !categoriesValid ? gettext('Enter whole percentages between 0 and 100.') : total > 100
    ? message(gettext('%(amount)s% over — reduce an allocation'), { amount: total - 100 })
    : remaining ? message(gettext('%(amount)s% left to allocate'), { amount: remaining }) : gettext('100% allocated'));

  for (const row of rows) {
    const input = row.querySelector('[data-workload-percentage]');
    const value = percentage(input);
    input.setAttribute('aria-invalid', !valid(input));
    const slider = row.querySelector('[data-workload-slider]');
    // Leave the native range control alone when already in sync, especially
    // during a pointer drag. Number-input edits and server patches still sync.
    if (slider.valueAsNumber !== value) slider.value = value;
    slider.style.setProperty('--allocation-value', `${value}%`);
    const fill = row.querySelector('[data-workload-fill]');
    fill.hidden = remaining === 0 || !categoriesValid;
    setText(fill, message(gettext('Fill remaining %(amount)s%'), { amount: remaining }));

    const slice = form.querySelector(`[data-workload-slice="${input.name}"]`);
    // Never normalize an overallocated draft into a misleading full pie.
    slice.style.display = value > 0 && total <= 100 && categoriesValid ? '' : 'none';
    slice.setAttribute('tabindex', value > 0 && total <= 100 && categoriesValid ? '0' : '-1');
    const label = `${row.dataset.categoryName}: ${value}%`;
    slice.setAttribute('aria-label', label);
    setText(slice.querySelector('title'), label);
    slice.setAttribute('stroke-dasharray', `${Math.max(0, value - (value === 100 ? 0 : 0.8))} ${100 - value + (value === 100 ? 0 : 0.8)}`);
    slice.setAttribute('stroke-dashoffset', -offset - (value === 100 ? 0 : 0.4));
    offset += value;

    const allProjects = [...row.querySelectorAll('[data-workload-project]')];
    const projects = allProjects.filter(project => project.closest('[data-workload-project-row]').dataset.selected === 'true');
    if (row.querySelector('.workload-projects')) {
      const assigned = projects.reduce((sum, project) => sum + percentage(project), 0);
      const projectValid = assigned <= value && projects.every(valid);
      const showBreakdown = categoriesValid && total <= 100 && projectValid && assigned > 0;
      hasProjectBreakdown ||= showBreakdown;
      form.querySelector(`[data-workload-project-legend-category="${input.name}"]`).hidden = !showBreakdown;
      // Project shares use the same overall-workload scale and start angle as
      // their category, rather than being normalized into another full pie.
      let projectOffset = offset - value;
      validDraft = validDraft && projectValid;
      const error = row.querySelector('[data-workload-project-error]');
      error.hidden = projectValid;
      setText(error, projects.every(valid) ? gettext('Project allocations cannot exceed their category percentage.') : gettext('Enter whole percentages between 0 and 100.'));
      if (!projectValid) row.querySelector('details').open = true;
      setText(row.querySelector('[data-workload-project-summary]'), assigned > value
        ? message(gettext('%(amount)s% over category'), { amount: assigned - value })
        : message(gettext('%(assigned)s% assigned · %(unspecified)s% unspecified'), { assigned, unspecified: value - assigned }));
      for (const project of allProjects) {
        const projectRow = project.closest('[data-workload-project-row]');
        const selected = projectRow.dataset.selected === 'true';
        projectRow.hidden = !selected;
        project.disabled = !selected;
        projectRow.querySelector('[data-workload-project-selected]').disabled = !selected;
        row.querySelector(`[data-workload-project-add="${project.name}"]`).hidden = selected;
        const segment = row.querySelector(`[data-workload-project-segment="${project.name}"]`);
        project.setAttribute('aria-invalid', selected && (!valid(project) || assigned > value));
        segment.dataset.percentage = selected ? percentage(project) : 0;
        segment.style.width = `${selected && value && projectValid ? percentage(project) / value * 100 : 0}%`;
        const amount = selected ? percentage(project) : 0;
        const arc = form.querySelector(`[data-workload-project-slice="${project.name}"]`);
        projectArc(arc, amount, projectOffset, showBreakdown);
        const label = `${row.dataset.categoryName}: ${projectRow.dataset.projectName}: ${amount}%`;
        arc.setAttribute('aria-label', label);
        setText(arc.querySelector('title'), label);
        const legend = form.querySelector(`[data-workload-project-legend-item="${project.name}"]`);
        legend.hidden = !showBreakdown || amount === 0;
        legend.setAttribute('aria-label', label);
        setText(legend.querySelector('[data-workload-project-legend-value]'), `${amount}%`);
        projectOffset += amount;
      }
      const unspecified = Math.max(0, value - assigned);
      const remainderArc = form.querySelector(`[data-workload-project-ring-remainder="${input.name}"]`);
      projectArc(remainderArc, unspecified, projectOffset, showBreakdown);
      const remainderLabel = message(gettext('Unspecified: %(amount)s%'), { amount: unspecified });
      setText(remainderArc.querySelector('title'), `${row.dataset.categoryName}: ${remainderLabel}`);
      const remainderLegend = form.querySelector(`[data-workload-project-legend-remainder="${input.name}"]`);
      remainderLegend.hidden = !showBreakdown || unspecified === 0;
      setText(remainderLegend.querySelector('[data-workload-project-legend-remainder-label]'), remainderLabel);
      row.querySelector('[data-workload-project-empty]').hidden = projects.length > 0 || allProjects.length === 0;
      const picker = row.querySelector('[data-workload-project-picker]');
      if (picker) picker.hidden = projects.length === allProjects.length;
    }
  }
  form.querySelector('[data-workload-project-legend]').hidden = !hasProjectBreakdown;
  const remainder = form.querySelector('[data-workload-remainder]');
  remainder.dataset.percentage = remaining;
  remainder.setAttribute('stroke-dasharray', `${remaining} ${100 - remaining}`);
  remainder.setAttribute('stroke-dashoffset', -offset);
  remainder.style.display = remaining > 0 && categoriesValid ? '' : 'none';
  const save = form.querySelector('[data-workload-save]');
  if (save) save.disabled = !validDraft;
  // Guidance chips navigate to existing inputs; without project-enabled
  // categories they're labels only, never imply an allocation was added.
  document.querySelectorAll('[data-workload-project-focus]').forEach(button => {
    button.disabled = !form.querySelector(`[data-project-id="${button.dataset.workloadProjectFocus}"]`);
  });
}

function highlight(field, project) {
  document.querySelectorAll('[data-workload-slice]').forEach(slice => {
    slice.classList.toggle('is-highlighted', slice.dataset.workloadSlice === field);
  });
  document.querySelectorAll('[data-workload-project-slice]').forEach(slice => {
    slice.classList.toggle('is-highlighted', slice.dataset.workloadProjectSlice === project);
  });
}

function focusSlice(slice) {
  document.getElementById(slice.dataset.workloadSlice)?.focus();
}

function selectProject(input, selected) {
  input.closest('[data-workload-project-row]').dataset.selected = String(selected);
  if (!selected) input.value = '0';
  input.closest('details').open = true;
  preview();
  if (selected) input.focus();
  else document.getElementById(`workload-project-add-${input.name}`)?.focus();
}

document.addEventListener('input', event => {
  if (!event.target.closest('#workload-form')) return;
  if (event.target.matches('[data-workload-slider]')) {
    const input = event.target.closest('[data-workload-row]').querySelector('[data-workload-percentage]');
    input.value = event.target.value;
  }
  preview();
});

document.addEventListener('click', event => {
  const previous = event.target.closest('[data-workload-previous-for]');
  if (previous) {
    const input = document.getElementById(previous.dataset.workloadPreviousFor);
    if (input && !input.disabled) {
      input.value = previous.dataset.workloadPrevious;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  }
  const fill = event.target.closest('[data-workload-fill]');
  if (fill) {
    const form = fill.closest('form');
    const input = fill.closest('[data-workload-row]').querySelector('[data-workload-percentage]');
    input.value = percentage(input) + Math.max(0, 100 - Number(form.dataset.total));
    preview();
    input.focus();
  }
  const slice = event.target.closest('[data-workload-slice]');
  if (slice) focusSlice(slice);
  const project = event.target.closest('[data-workload-project-slice], [data-workload-project-legend-item]');
  if (project) selectProject(document.getElementById(project.dataset.workloadProjectSlice || project.dataset.workloadProjectLegendItem), true);
  const add = event.target.closest('[data-workload-project-add]');
  if (add) selectProject(document.getElementById(add.dataset.workloadProjectAdd), true);
  const remove = event.target.closest('[data-workload-project-remove]');
  if (remove) selectProject(document.getElementById(remove.dataset.workloadProjectRemove), false);
  const chip = event.target.closest('[data-workload-project-focus]');
  if (chip) {
    const input = document.querySelector(`[data-workload-project][data-project-id="${chip.dataset.workloadProjectFocus}"]`);
    if (input) selectProject(input, true);
  }
});

document.addEventListener('keydown', event => {
  const slice = event.target.closest('[data-workload-slice], [data-workload-project-slice]');
  if (slice && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    if (slice.dataset.workloadProjectSlice) selectProject(document.getElementById(slice.dataset.workloadProjectSlice), true);
    else focusSlice(slice);
  }
});

function fieldOf(target) {
  return target?.closest?.('[data-workload-slice]')?.dataset.workloadSlice
    || target?.closest?.('[data-category-field]')?.dataset.categoryField
    || target?.closest?.('[data-workload-row]')?.dataset.workloadRow;
}
function projectOf(target) {
  const arc = target?.closest?.('[data-workload-project-slice], [data-workload-project-legend-item]');
  return arc?.dataset.workloadProjectSlice || arc?.dataset.workloadProjectLegendItem
    || target?.closest?.('[data-workload-project-row]')?.querySelector('[data-workload-project]')?.name;
}
document.addEventListener('pointerover', event => {
  const field = fieldOf(event.target);
  if (field) highlight(field, projectOf(event.target));
});
document.addEventListener('pointerout', event => {
  if (fieldOf(event.target) && !fieldOf(event.relatedTarget)) highlight(fieldOf(document.activeElement), projectOf(document.activeElement));
});
document.addEventListener('focusin', event => highlight(fieldOf(event.target), projectOf(event.target)));
document.addEventListener('focusout', event => {
  if (!fieldOf(event.relatedTarget)) highlight(null);
});

// Server patches replace the form. Delegated handlers remain attached and
// recompute sliders/chart/validation from the newly committed number inputs.
document.addEventListener('datastar-fetch', event => {
  if (event.detail?.type !== 'finished' || !event.detail.el?.closest('#workload-content')) return;
  // Morphing preserves dirty input properties even when the server restores
  // an unchanged value attribute (notably after “Still accurate”). A completed
  // workload response is authoritative, including validation-error drafts.
  document.querySelectorAll('#workload-form input[type="number"]').forEach(input => {
    input.value = input.getAttribute('value') ?? '';
  });
  preview();
});
preview();
