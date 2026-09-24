/* A settings form built from a model's field list.
 *
 * The fields come from the server (src/lib/media-params.js), which builds them
 * from whatever the provider publishes — a typed schema for images, typed
 * lists plus passthrough names for video, a verified manifest for speech. So
 * switching models rebuilds the form from data, and a model released tomorrow
 * gets the right controls without a code change.
 *
 * The server re-validates everything; this file only has to be convenient.
 * Values are remembered per model on this device, which is a convenience and
 * nothing more: a blocked or empty store just means defaults. */

const readStore = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    return {};
  }
};
const writeStore = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota: defaults next time */
  }
};

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function hintFor(field) {
  return field.hint ? node('span', 'xs muted param-hint', field.hint) : null;
}

/* Each control reads and writes a plain value; the form only deals in those. */
function control(field, value, changed) {
  const wrap = node('label', 'field param-field');
  wrap.dataset.key = field.key;
  const head = node('span', null, field.label);
  wrap.appendChild(head);
  let read;

  switch (field.type) {
    case 'enum': {
      const sel = node('select', 'input sm');
      // With no default, "not set" is an honest option: the provider decides.
      if (field.default === undefined) sel.appendChild(Object.assign(node('option', null, '指定しない'), { value: '' }));
      for (const v of field.values) sel.appendChild(Object.assign(node('option', null, String(v)), { value: String(v) }));
      const initial = value ?? field.default;
      sel.value = initial === undefined || initial === null ? '' : String(initial);
      sel.addEventListener('change', changed);
      wrap.appendChild(sel);
      read = () => (sel.value === '' ? undefined : sel.value);
      break;
    }
    case 'range': {
      /* A slider always has a position, but "the provider's default" is not a
       * position — compression 0 is a real, and bad, value to force on every
       * image. So a range without a declared default is unset until moved,
       * and can be put back. */
      const optional = field.default === undefined;
      let touched = !optional || (value !== undefined && value !== null);
      const out = node('b', 'xs param-value');
      head.appendChild(document.createTextNode(' '));
      head.appendChild(out);
      const input = Object.assign(node('input', 'slider'), {
        type: 'range',
        min: String(field.min),
        max: String(field.max),
        step: String(field.step ?? 1),
      });
      input.value = String(value ?? field.default ?? (field.min + field.max) / 2);
      const clear = optional ? Object.assign(node('button', 'btn quiet param-clear', '既定に戻す'), { type: 'button' }) : null;
      const show = () => {
        const pct = ((Number(input.value) - field.min) / (field.max - field.min)) * 100;
        input.style.setProperty('--fill', (touched ? pct : 0).toFixed(1) + '%');
        out.textContent = touched ? input.value : '既定';
        input.classList.toggle('unset', !touched);
        if (clear) clear.hidden = !touched;
      };
      input.addEventListener('input', () => {
        touched = true;
        show();
        changed();
      });
      wrap.appendChild(input);
      if (clear) {
        clear.addEventListener('click', (e) => {
          e.preventDefault();
          touched = false;
          show();
          changed();
        });
        wrap.appendChild(clear);
      }
      show();
      read = () => (touched ? Number(input.value) : undefined);
      break;
    }
    case 'number': {
      const input = Object.assign(node('input', 'input sm'), { type: 'number', placeholder: field.hint || '' });
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (value !== undefined && value !== null) input.value = String(value);
      input.addEventListener('change', changed);
      wrap.appendChild(input);
      read = () => (input.value === '' ? undefined : Number(input.value));
      break;
    }
    case 'boolean': {
      /* Without a declared default, a checkbox would have to send either true
       * or false — and "false" silently overrides a provider default such as
       * a watermark. Three states keep "leave it alone" possible. */
      if (field.default === undefined) {
        const sel = node('select', 'input sm');
        for (const [label, v] of [['既定', ''], ['オン', 'true'], ['オフ', 'false']]) {
          sel.appendChild(Object.assign(node('option', null, label), { value: v }));
        }
        sel.value = value === true ? 'true' : value === false ? 'false' : '';
        sel.addEventListener('change', changed);
        wrap.appendChild(sel);
        read = () => (sel.value === '' ? undefined : sel.value === 'true');
      } else {
        wrap.className = 'toggle-row param-field';
        wrap.textContent = '';
        const box = Object.assign(node('input'), { type: 'checkbox' });
        box.checked = value ?? field.default;
        box.addEventListener('change', changed);
        wrap.appendChild(box);
        wrap.appendChild(node('span', 'sm', field.label));
        read = () => box.checked;
      }
      break;
    }
    case 'longtext': {
      const area = Object.assign(node('textarea', 'input sm'), { rows: 2 });
      area.value = value || '';
      area.addEventListener('change', changed);
      wrap.appendChild(area);
      if (Array.isArray(field.values) && field.values.length) {
        const row = node('div', 'param-chips');
        for (const preset of field.values) {
          const chip = Object.assign(node('button', 'chip sm', preset), { type: 'button' });
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            area.value = area.value.trim() ? area.value.trim() + '、' + preset : preset;
            changed();
          });
          row.appendChild(chip);
        }
        wrap.appendChild(row);
      }
      read = () => area.value.trim() || undefined;
      break;
    }
    case 'tags': {
      const chosen = new Set(Array.isArray(value) ? value : []);
      const row = node('div', 'param-chips');
      const known = new Set(field.values.map((t) => t.value));
      for (const tag of field.values) {
        const chip = Object.assign(node('button', 'chip sm toggle', tag.label), { type: 'button' });
        chip.dataset.on = String(chosen.has(tag.value));
        chip.title = tag.value;
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          if (chosen.has(tag.value)) chosen.delete(tag.value);
          else chosen.add(tag.value);
          chip.dataset.on = String(chosen.has(tag.value));
          changed();
        });
        row.appendChild(chip);
      }
      wrap.appendChild(row);
      // Anything not in the presets — the model accepts free-form tags too.
      const custom = Object.assign(node('input', 'input sm'), { placeholder: '自由に追加（カンマ区切り）例: 優しく, 早口で' });
      custom.value = [...chosen].filter((t) => !known.has(t)).join(', ');
      custom.addEventListener('change', changed);
      wrap.appendChild(custom);
      read = () => {
        const extra = custom.value.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
        const all = [...[...chosen].filter((t) => known.has(t)), ...extra];
        return all.length ? all : undefined;
      };
      break;
    }
    default: {
      // text and raw: a single line.
      const input = Object.assign(node('input', 'input sm'), { placeholder: field.type === 'raw' ? field.hint || '' : '' });
      if (value !== undefined && value !== null) input.value = typeof value === 'string' ? value : JSON.stringify(value);
      input.addEventListener('change', changed);
      wrap.appendChild(input);
      read = () => input.value.trim() || undefined;
    }
  }

  const hint = field.type === 'raw' || field.type === 'number' ? null : hintFor(field);
  if (hint) wrap.appendChild(hint);
  return { el: wrap, read };
}

/**
 * Renders `fields` into `host`.
 * @param {HTMLElement} host
 * @param {object[]} fields
 * @param {{ store?: string, onChange?: (values: object) => void }} [opts]
 * @returns {{ values: () => object }}
 */
export function paramForm(host, fields, { store, onChange } = {}) {
  host.textContent = '';
  const saved = store ? readStore(store) : {};
  const controls = [];

  const values = () => {
    const out = {};
    for (const c of controls) {
      const v = c.read();
      if (v !== undefined) out[c.key] = v;
    }
    return out;
  };
  const changed = () => {
    const v = values();
    if (store) writeStore(store, v);
    onChange?.(v);
  };

  const basic = node('div', 'param-grid');
  const adv = node('details', 'param-adv');
  adv.appendChild(node('summary', 'xs', '詳細設定'));
  const advGrid = node('div', 'param-grid');
  adv.appendChild(advGrid);

  for (const field of fields || []) {
    const c = control(field, saved[field.key], changed);
    controls.push({ key: field.key, read: c.read });
    (field.advanced ? advGrid : basic).appendChild(c.el);
  }

  if (basic.childElementCount) host.appendChild(basic);
  if (advGrid.childElementCount) {
    const passthrough = (fields || []).some((f) => f.target === 'passthrough');
    if (passthrough) {
      advGrid.appendChild(
        node('p', 'xs muted param-note', 'プロバイダ固有の項目は、名前は API が公開していますが型や効果は保証されていません。効かない場合は既定のままにしてください。')
      );
    }
    host.appendChild(adv);
  }
  host.hidden = !host.childElementCount;

  return { values };
}
