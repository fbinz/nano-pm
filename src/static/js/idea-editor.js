(() => {
  const textarea = document.getElementById('idea-body-editor');
  if (!textarea || !window.tinymce) return;

  const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const inlineMarkdownToHtml = (value) => escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const markdownToHtml = (markdown) => {
    const blocks = markdown.replace(/\r\n/g, '\n').split(/\n{2,}/);
    return blocks.map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`;
      }
      const lines = trimmed.split('\n');
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${inlineMarkdownToHtml(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map(inlineMarkdownToHtml).join('<br>')}</p>`;
    }).join('');
  };

  const inlineNodeToMarkdown = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const content = Array.from(node.childNodes).map(inlineNodeToMarkdown).join('');
    if (tag === 'strong' || tag === 'b') return `**${content}**`;
    if (tag === 'em' || tag === 'i') return `*${content}*`;
    if (tag === 'code') return `\`${content}\``;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      return href ? `[${content}](${href})` : content;
    }
    if (tag === 'br') return '\n';
    return content;
  };

  const blockNodeToMarkdown = (node, index = 1) => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const inline = () => Array.from(node.childNodes).map(inlineNodeToMarkdown).join('').trim();

    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inline()}`;
    if (tag === 'p' || tag === 'div') return inline();
    if (tag === 'blockquote') {
      return inline().split('\n').map((line) => `> ${line}`).join('\n');
    }
    if (tag === 'pre') return `\`\`\`\n${node.textContent.trim()}\n\`\`\``;
    if (tag === 'ul') {
      return Array.from(node.children).map((li) => `- ${Array.from(li.childNodes).map(inlineNodeToMarkdown).join('').trim()}`).join('\n');
    }
    if (tag === 'ol') {
      return Array.from(node.children).map((li, i) => `${i + index}. ${Array.from(li.childNodes).map(inlineNodeToMarkdown).join('').trim()}`).join('\n');
    }
    if (tag === 'br') return '';
    return inline();
  };

  const htmlToMarkdown = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.body.childNodes)
      .map((node) => blockNodeToMarkdown(node))
      .filter((block) => block.length > 0)
      .join('\n\n');
  };

  const syncTextarea = (editor) => {
    textarea.value = htmlToMarkdown(editor.getContent());
  };

  window.tinymce.init({
    selector: '#idea-body-editor',
    license_key: 'gpl',
    base_url: textarea.dataset.tinymceBaseUrl || '/static/vendor/tinymce',
    suffix: '.min',
    promotion: false,
    branding: false,
    menubar: false,
    min_height: 520,
    resize: true,
    readonly: textarea.readOnly,
    elementpath: false,
    plugins: 'autolink autoresize code codesample fullscreen link lists quickbars wordcount',
    toolbar: 'undo redo | blocks | bold italic | bullist numlist blockquote | link codesample | code fullscreen',
    quickbars_insert_toolbar: false,
    quickbars_image_toolbar: false,
    quickbars_selection_toolbar: 'bold italic | quicklink h2 h3 blockquote',
    block_formats: 'Paragraph=p; Heading 1=h1; Heading 2=h2; Heading 3=h3; Quote=blockquote; Code=pre',
    convert_urls: false,
    entity_encoding: 'raw',
    content_style: 'body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; font-size: 15px; line-height: 1.55; }',
    setup: (editor) => {
      editor.on('init', () => {
        editor.setContent(markdownToHtml(textarea.value || ''));
      });
      editor.on('change keyup input undo redo setcontent', () => syncTextarea(editor));
      const form = textarea.closest('form');
      if (form) {
        form.addEventListener('submit', () => syncTextarea(editor));
      }
    },
  });
})();
