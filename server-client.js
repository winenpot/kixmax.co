// Injected into every mirrored page by server.js. It does the three things the captured
// WordPress front end cannot do on a static host: neutralise the Cloudflare Turnstile
// widget (its site key is bound to the original domain), take over Elementor form
// submission, and point WordPress-style search at the mirror's own search page.
(() => {
  const isMirror = location.hostname !== 'kixmax.co' && location.hostname !== 'www.kixmax.co';
  if (!isMirror) return;

  // 1. Turnstile. The widget's site key only validates on the original domain, so drop the
  //    settings the plugin reads, remove any widget it injected, and neuter the API object
  //    in case the Turnstile script itself still loads. The site declares the settings with
  //    a `var`, which creates a non-configurable global: only assignment gets through.
  try { window.cfturnstileElementorSettings = {}; } catch { /* ignore */ }
  const stubTurnstile = { render() {}, remove() {}, reset() {}, getResponse() { return ''; }, execute() {}, isExpired() { return false; } };
  for (const name of ['turnstile', 'cfTurnstile', 'grecaptcha']) {
    try { Object.defineProperty(window, name, { value: stubTurnstile, writable: true, configurable: true }); } catch { /* ignore */ }
  }

  // 2. Forms. Elementor posts to /wp-admin/admin-ajax.php, which the static server
  //    answers with an empty object, so submissions would silently do nothing. Intercept
  //    the submit in the capture phase, before Elementor's own handler runs, and POST the
  //    fields to the mirror backend instead.
  const statusOf = form => form.querySelector('.elementor-message, .kixmax-form-status');
  const setStatus = (form, text, kind) => {
    let node = statusOf(form);
    if (!node) {
      node = document.createElement('div');
      node.className = 'elementor-message kixmax-form-status';
      form.appendChild(node);
    }
    node.className = `elementor-message kixmax-form-status ${kind}`;
    node.textContent = text;
  };

  const payloadFrom = form => {
    const data = new FormData(form);
    const fields = {};
    let page = '';
    let formName = form.getAttribute('name') || null;
    let formId = null;
    let refererTitle = null;
    for (const [rawKey, value] of data.entries()) {
      const key = rawKey.trim();
      if (!key || key.startsWith('_')) continue;
      if (key === 'referer_title') { refererTitle = String(value); continue; }
      if (key === 'form_id') { formId = String(value); continue; }
      if (key === 'page' || key === 'PagePath') { page = String(value); continue; }
      if (key === 'cf-turnstile-response' || key === 'g-recaptcha-response' || key === 'cfturnstile_failsafe') continue;
      if (key.startsWith('form_fields[') && key.endsWith(']')) { fields[key.slice('form_fields['.length, -1)] = String(value); continue; }
      if (key === 'website') { fields.website = String(value); continue; }
      if (key === 'elementor-form-id') continue;
      fields[key] = String(value);
    }
    if (!page) page = location.pathname + location.search;
    return { page, formName, formId, refererTitle, fields };
  };

  const sending = new WeakSet();
  const submitterOf = event => {
    const form = event.target instanceof HTMLFormElement ? event.target : event.target.closest?.('form.elementor-form');
    return form || null;
  };
  // Elementor validates on the submit button and only then lets the submit event fire, so a
  // capture-phase submit listener alone never runs. Take the button click too, and keep the
  // submit listener for Enter-key submission.
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button[type="submit"], input[type="submit"], .elementor-button');
    const form = button?.closest('form.elementor-form');
    if (!form) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(form);
  }, true);
  document.addEventListener('submit', event => {
    const form = submitterOf(event);
    if (!form) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(form);
  }, true);

  async function send(form) {
    if (sending.has(form)) return;
    if (form.reportValidity && !form.reportValidity()) return;
    sending.add(form);
    const button = form.querySelector('button[type="submit"], input[type="submit"], .elementor-button');
    const label = button?.textContent;
    if (button) button.disabled = true;
    setStatus(form, 'Sending…', '');
    try {
      const response = await fetch('/api/forms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadFrom(form))
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Sending failed, please try again.');
      form.reset();
      setStatus(form, data.message || 'Thank you. Your message has been received.', 'success');
    } catch (error) {
      setStatus(form, error.message || 'Sending failed, please try again.', 'danger');
    } finally {
      sending.delete(form);
      if (button) { button.disabled = false; button.textContent = label; }
    }
  }

  // 3. Search. The site has no header search box, but Rank Math advertises
  //    https://kixmax.co/?s={search_term_string}, so make that URL work on the mirror.
  for (const form of document.querySelectorAll('form[action*="?s="], form[role="search"]')) {
    form.addEventListener('submit', event => {
      const input = form.querySelector('input[name="s"], input[type="search"]');
      const query = (input?.value || '').trim();
      if (!query) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      location.href = `/search/?q=${encodeURIComponent(query)}`;
    }, true);
  }

  // 4. Turnstile widgets injected after load still fail on the new domain.
  const sweep = () => {
    for (const node of document.querySelectorAll('.cf-turnstile, .elementor-turnstile-field, .g-recaptcha, iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"]')) {
      node.remove();
    }
  };
  sweep();
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
})();
