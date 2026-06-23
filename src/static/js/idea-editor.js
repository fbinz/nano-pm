(() => {
  const textarea = document.getElementById('idea-body-editor');
  const container = document.getElementById('idea-body-editor-ui');
  const Editor = window.toastui?.Editor;
  if (!textarea || !container || !Editor) return;

  const initialValue = textarea.value || '';
  const isReadOnly = textarea.readOnly;
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';

  textarea.hidden = true;

  if (isReadOnly) {
    Editor.factory({
      el: container,
      viewer: true,
      initialValue,
      usageStatistics: false,
      theme,
    });
    return;
  }

  const editor = new Editor({
    el: container,
    height: '520px',
    minHeight: '360px',
    initialValue,
    initialEditType: 'markdown',
    previewStyle: 'vertical',
    placeholder: textarea.getAttribute('placeholder') || '',
    usageStatistics: false,
    autofocus: false,
    theme,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['quote', 'ul', 'ol'],
      ['link', 'code', 'codeblock'],
    ],
  });

  const syncTextarea = () => {
    textarea.value = editor.getMarkdown();
  };

  editor.on('change', syncTextarea);
  window.nanoIdeaEditor = editor;

  const form = textarea.closest('form');
  if (form) {
    form.addEventListener('submit', syncTextarea);
  }
})();
