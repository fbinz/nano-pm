(() => {
  const textarea = document.getElementById('idea-body-editor');
  const EasyMDE = window.EasyMDE;
  if (!textarea || !EasyMDE) return;

  const isReadOnly = textarea.readOnly;
  const editor = new EasyMDE({
    element: textarea,
    autofocus: false,
    forceSync: true,
    initialValue: textarea.value || '',
    minHeight: '360px',
    placeholder: textarea.getAttribute('placeholder') || '',
    spellChecker: false,
    status: false,
    toolbar: isReadOnly ? false : [
      'heading', 'bold', 'italic', 'strikethrough',
      '|', 'quote', 'unordered-list', 'ordered-list',
      '|', 'link', 'code',
      '|', 'preview', 'side-by-side', 'fullscreen',
    ],
    toolbarTips: true,
  });

  if (isReadOnly) {
    editor.codemirror.setOption('readOnly', 'nocursor');
  }

  const syncTextarea = () => {
    textarea.value = editor.value();
  };

  editor.codemirror.on('change', syncTextarea);

  // Keep the old tiny adapter used by tests and any page-specific hooks while
  // exposing the EasyMDE instance underneath.
  editor.setMarkdown = (value) => {
    editor.value(value);
    syncTextarea();
  };
  editor.getMarkdown = () => editor.value();
  window.nanoIdeaEditor = editor;

  const form = textarea.closest('form');
  if (form) {
    form.addEventListener('submit', syncTextarea);
  }
})();
