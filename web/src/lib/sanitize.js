// Markdown from agents / LLMs / Slack is untrusted: no images (exfiltration via URL), no forms or
// buttons (fake "Approve"), no frames/styles/svg, and links only to http(s), mailto or #/ routes.
// Takes the DOMPurify instance so the unit test can run it against a real browser DOM.

export const PURIFY_CONFIG = {
  FORBID_TAGS: ['img', 'image', 'picture', 'source', 'video', 'audio', 'track', 'form', 'button', 'select', 'option', 'textarea',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'style', 'link', 'meta', 'base', 'svg', 'math', 'dialog'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'poster', 'ping'],
  ALLOW_DATA_ATTR: false,
};

const SAFE_HREF = /^(https?:|mailto:|#\/)/i;

const hooked = new WeakSet();

function install(purify) {
  if (hooked.has(purify)) return;
  hooked.add(purify);
  purify.addHook('uponSanitizeElement', (node, data) => {
    // GFM task lists render <input type="checkbox" disabled>: keep those, drop every other input.
    if (data.tagName === 'input') {
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (type !== 'checkbox') node.parentNode?.removeChild(node);
    }
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'INPUT') {
      for (const a of [...node.attributes]) if (!['type', 'checked', 'disabled'].includes(a.name)) node.removeAttribute(a.name);
      node.setAttribute('disabled', '');
      return;
    }
    if (node.tagName !== 'A') return;
    const href = (node.getAttribute('href') || '').trim();
    if (!href || !SAFE_HREF.test(href)) {
      node.removeAttribute('href');
      node.removeAttribute('target');
      return;
    }
    if (/^https?:/i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      node.removeAttribute('target');
    }
  });
}

export function sanitizeMarkdownHtml(purify, html) {
  install(purify);
  return purify.sanitize(String(html ?? ''), PURIFY_CONFIG);
}
