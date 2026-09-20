/*
 * naaradh.js — the Naaradh website snippet (SPEC §9.2, P1-API-3). No dependencies, no cookies,
 * no tracking. Load it with the merchant's PUBLIC site key (nrd_pk_…: intents:create only,
 * limited to the domains listed on the key):
 *
 *   <script src="https://cdn.naaradh.com/naaradh.js" data-key="nrd_pk_…" async></script>
 *   <form data-naaradh data-naaradh-require-consent>
 *     <input name="name"> <input name="phone" type="tel">
 *     <div data-naaradh-consent-slot></div>   <!-- or your own checkbox, see below -->
 *     <button>Call me back</button>
 *   </form>
 *
 * On submit it sends ONE thing to api.naaradh.com: a lead-callback request with the name and
 * phone fields the form maps (data-naaradh-name / data-naaradh-phone override the field names).
 * It never reads any other field. The form's own submission is not blocked; listen for the
 * `naaradh:submitted` event to show a message.
 *
 * Consent: a checkbox marked `data-naaradh-consent="service"` (or "promotional") and
 * `data-naaradh-consent-version="v1"` is sent as the consent record when ticked. With
 * `data-naaradh-require-consent`, nothing is sent unless it is ticked.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var key = script && script.getAttribute('data-key');
  var api = (script && script.getAttribute('data-api')) || 'https://api.naaradh.com';
  if (!key || !/^nrd_pk_[A-Za-z0-9]{32}$/.test(key)) {
    console.warn('naaradh.js: add data-key with your public site key (nrd_pk_…)');
    return;
  }

  function id() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function')
      return window.crypto.randomUUID();
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function value(form, name) {
    var el = form.elements.namedItem(name);
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  function consentOf(form) {
    var box = form.querySelector('input[type=checkbox][data-naaradh-consent]');
    if (!box) return undefined;
    if (!box.checked) return null;
    var purpose = box.getAttribute('data-naaradh-consent');
    var consent = {
      purpose: purpose === 'promotional' || purpose === 'all' ? purpose : 'service',
      source: 'form',
    };
    var version = box.getAttribute('data-naaradh-consent-version');
    if (version) consent.wording_version = version.slice(0, 64);
    return consent;
  }

  function submit(form) {
    var phone = value(form, form.getAttribute('data-naaradh-phone') || 'phone');
    if (!phone) return Promise.resolve({ ok: false, reason: 'no_phone' });
    var consent = consentOf(form);
    if (!consent && form.hasAttribute('data-naaradh-require-consent'))
      return Promise.resolve({ ok: false, reason: 'no_consent' });
    var body = {
      use_case: 'lead_callback',
      phone: phone.slice(0, 32),
      phone_region: (form.getAttribute('data-naaradh-region') || 'IN').slice(0, 2).toUpperCase(),
      external_ref: 'web-' + id(),
      event_ts: new Date().toISOString(),
      variables: {},
    };
    var name = value(form, form.getAttribute('data-naaradh-name') || 'name').slice(0, 120);
    if (name) {
      body.name = name;
      body.variables.customer_name = name;
    }
    if (consent) body.consent = consent;
    return fetch(api + '/v1/intents', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      keepalive: true,
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'idempotency-key': id(),
      },
      body: JSON.stringify(body),
    }).then(
      function (res) {
        return { ok: res.ok, status: res.status };
      },
      function () {
        return { ok: false, reason: 'network' };
      },
    );
  }

  /** Renders a consent checkbox into `target` with the merchant's own wording. */
  function consentCheckbox(target, options) {
    var opts = options || {};
    var label = document.createElement('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-naaradh-consent', opts.purpose || 'service');
    box.setAttribute('data-naaradh-consent-version', opts.version || 'v1');
    if (opts.required) box.required = true;
    label.appendChild(box);
    label.appendChild(
      document.createTextNode(
        ' ' +
          (opts.wording ||
            'I agree to receive a phone call about this request. The call may be made by an automated assistant and recorded.'),
      ),
    );
    target.appendChild(label);
    return box;
  }

  document.addEventListener(
    'submit',
    function (event) {
      var form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-naaradh')) return;
      submit(form).then(function (result) {
        form.dispatchEvent(new CustomEvent('naaradh:submitted', { detail: result, bubbles: true }));
      });
    },
    true,
  );

  var slots = document.querySelectorAll('[data-naaradh-consent-slot]');
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    consentCheckbox(slot, {
      wording: slot.getAttribute('data-wording') || undefined,
      version: slot.getAttribute('data-version') || undefined,
      purpose: slot.getAttribute('data-purpose') || undefined,
      required: slot.hasAttribute('data-required'),
    });
  }

  window.Naaradh = { submit: submit, consentCheckbox: consentCheckbox, version: '1' };
})();
