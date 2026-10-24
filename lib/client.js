/*
 * dsh-pet — browser half.
 *
 * Registers a Settings section that lists every pet the host ships and lets
 * the user pick one and set its size. The gallery is read from the host at
 * runtime, so a pet added to `pets/` shows up here without this file
 * changing; the two settings are written through DSH's own settings form, so
 * they land in the profile patch like every other plugin setting.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.pet';

    /** Exact Fetch routes the host answers. */
    const API = {
      pets: '/api/dsh-pet/pets',
      sprite: '/api/dsh-pet/sprite',
      preview: '/api/dsh-pet/preview',
    };

    /** Panel bounds, in CSS pixels; the host clamps to the same range. */
    const MIN_SIZE = 120;
    const MAX_SIZE = 260;
    const DEFAULT_SIZE = 220;

    const en = {
      nav: 'Pet',
      title: 'Desktop pet',
      description: 'Pick the pet that floats on your desktop and set how large it is.',
      gallery: 'Available pets',
      size: 'Size',
      sizeHint: 'The edge of the floating panel, in pixels.',
      preview: 'Preview',
      saveFailed: 'The change was not accepted; try again.',
      loadFailed: 'The pet gallery could not be loaded.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      selected: 'Selected',
      current: 'Current',
    };

    const zh = {
      nav: '宠物',
      title: '桌面宠物',
      description: '挑选飘在桌面上的宠物，并设置它的大小。',
      gallery: '可选宠物',
      size: '尺寸',
      sizeHint: '悬浮窗的边长，单位是像素。',
      preview: '预览',
      saveFailed: '这次修改没有写进去，请再试一次。',
      loadFailed: '宠物列表加载失败。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      selected: '已选中',
      current: '当前',
    };

    /** Read a JSON payload from a same-origin route. */
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`request failed: ${response.status}`);
      return response.json();
    }

    /** Read a binary payload and hand it back as an object URL. */
    async function fetchObjectUrl(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`request failed: ${response.status}`);
      return URL.createObjectURL(await response.blob());
    }

    const css = [
      '.dshpet_page{display:flex;flex-direction:column;gap:18px;max-width:760px}',
      '.dshpet_title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dshpet_desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dshpet_label{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}',
      '.dshpet_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px}',
      '.dshpet_card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 8px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;font-family:inherit;transition:border-color 120ms cubic-bezier(.23,1,.32,1),background 120ms cubic-bezier(.23,1,.32,1)}',
      '.dshpet_card:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpet_card[data-selected="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
      '.dshpet_card:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshpet_thumb{width:112px;height:112px;object-fit:contain;image-rendering:pixelated}',
      '.dshpet_thumbFallback{width:112px;height:112px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpet_name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);text-align:center;word-break:break-word}',
      // The stage is as tall as the largest pet needs, so dragging the size
      // slider only changes the pet inside it and never the page around it.
      '.dshpet_stage{box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:' + (MAX_SIZE + 24) + 'px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dshpet_canvas{image-rendering:pixelated;display:block}',
      '.dshpet_row{display:flex;align-items:center;gap:12px}',
      '.dshpet_range{flex:1;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_value{min-width:64px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dshpet_actions{display:flex;align-items:center;gap:10px}',
      '.dshpet_note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshpet_error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    /** Install the page's stylesheet once. */
    function useStyles() {
      useEffect(() => {
        const id = 'dsh-pet/styles.css';
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-pet';
        tag.dataset.pluginCss = id;
        tag.textContent = css;
        document.head.appendChild(tag);
      }, []);
    }

    /** Load the pet gallery from the host. */
    function useGallery() {
      const [state, setState] = useState({ pets: [], loading: true, failed: false });
      useEffect(() => {
        let cancelled = false;
        fetchJson(API.pets)
          .then((payload) => {
            if (cancelled) return;
            const pets = Array.isArray(payload?.pets) ? payload.pets : [];
            setState({ pets, loading: false, failed: false });
          })
          .catch(() => {
            if (!cancelled) setState({ pets: [], loading: false, failed: true });
          });
        return () => {
          cancelled = true;
        };
      }, []);
      return state;
    }

    /** Load one pet's still preview as an object URL. */
    function usePreviewUrl(petId) {
      const [url, setUrl] = useState(null);
      useEffect(() => {
        if (!petId) {
          setUrl(null);
          return;
        }
        let cancelled = false;
        let created = null;
        fetchObjectUrl(API.preview + '?id=' + encodeURIComponent(petId))
          .then((objectUrl) => {
            created = objectUrl;
            if (cancelled) URL.revokeObjectURL(objectUrl);
            else setUrl(objectUrl);
          })
          .catch(() => {
            if (!cancelled) setUrl(null);
          });
        return () => {
          cancelled = true;
          if (created !== null) URL.revokeObjectURL(created);
        };
      }, [petId]);
      return url;
    }

    /**
     * Play a pet's idle animation on a canvas.
     *
     * The atlas is fetched once per pet; the loop redraws from the live
     * canvas size, so the preview follows the size slider without reloading
     * the atlas.
     */
    function useSpriteCanvas(pet) {
      const canvasRef = useRef(null);
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !pet || !pet.animations) return undefined;
        const cell = pet.cell || { width: 192, height: 208 };
        const spec = pet.animations[pet.idle || 'idle'];
        if (!spec) return undefined;
        const durations = Array.isArray(spec.durations) && spec.durations.length > 0 ? spec.durations : [120];
        const total = durations.reduce((sum, value) => sum + value, 0) || 1;

        let cancelled = false;
        let image = null;
        let objectUrl = null;
        let raf = 0;
        let last = 0;
        let elapsed = 0;
        let frame = -1;

        const draw = () => {
          const dpr = window.devicePixelRatio || 1;
          const rect = canvas.getBoundingClientRect();
          const width = Math.max(1, Math.round(rect.width * dpr));
          const height = Math.max(1, Math.round(rect.height * dpr));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          const context = canvas.getContext('2d');
          if (!context) return;
          context.imageSmoothingEnabled = false;
          context.clearRect(0, 0, width, height);
          if (image === null) return;
          const scale = Math.min(width / cell.width, height / cell.height);
          const drawWidth = cell.width * scale;
          const drawHeight = cell.height * scale;
          context.drawImage(
            image,
            frame < 0 ? 0 : frame * cell.width,
            spec.row * cell.height,
            cell.width,
            cell.height,
            (width - drawWidth) / 2,
            (height - drawHeight) / 2,
            drawWidth,
            drawHeight,
          );
        };

        const tick = (now) => {
          if (cancelled) return;
          raf = requestAnimationFrame(tick);
          if (last === 0) last = now;
          elapsed = (elapsed + (now - last)) % total;
          last = now;
          let accumulated = 0;
          let index = 0;
          for (let i = 0; i < durations.length; i += 1) {
            accumulated += durations[i];
            if (elapsed < accumulated) {
              index = i;
              break;
            }
          }
          if (index !== frame) {
            frame = index;
            draw();
          }
        };

        fetchObjectUrl(API.sprite + '?id=' + encodeURIComponent(pet.id))
          .then((url) => {
            if (cancelled) {
              URL.revokeObjectURL(url);
              return;
            }
            objectUrl = url;
            const element = new Image();
            element.onload = () => {
              if (cancelled) return;
              image = element;
              draw();
              raf = requestAnimationFrame(tick);
            };
            element.src = url;
          })
          .catch(() => {});

        draw();
        return () => {
          cancelled = true;
          if (raf) cancelAnimationFrame(raf);
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        };
      }, [pet]);
      return canvasRef;
    }

    /** One gallery card: the pet's still preview and its name. */
    function PetCard(props) {
      const { pet, selected, onSelect } = props;
      const url = usePreviewUrl(pet.id);
      return h(
        'button',
        {
          type: 'button',
          className: 'dshpet_card',
          'data-selected': selected ? 'true' : 'false',
          'aria-pressed': selected ? 'true' : 'false',
          onClick: () => onSelect(pet.id),
        },
        url === null
          ? h('div', { className: 'dshpet_thumbFallback' })
          : h('img', { className: 'dshpet_thumb', src: url, alt: pet.name, loading: 'lazy' }),
        h('span', { className: 'dshpet_name' }, pet.name),
      );
    }

    /** The Settings section body. */
    function PetSection(props) {
      useStyles();
      const form = formRef.current;
      const t = translate;
      const subscribe = useCallback((listener) => form.subscribe(listener), [form]);
      const snapshot = useSyncExternalStore(subscribe, useCallback(() => form.getSnapshot(), [form]));
      const gallery = useGallery();

      const value = snapshot?.value || {};
      const [failed, setFailed] = useState(false);
      // The slider's own value while it is being dragged. The host's answer
      // trails the finger, so showing it would drag the thumb backwards.
      const [draftSize, setDraftSize] = useState(null);
      const pendingSize = useRef(null);
      const flushing = useRef(false);
      const written = useRef({ pet: null, size: null });

      // The host owns the values; a draft only survives a drag in progress.
      const pet = typeof value.pet === 'string' ? value.pet : (gallery.pets[0]?.id ?? '');
      const size = typeof value.size === 'number' ? value.size : DEFAULT_SIZE;
      const shownSize = draftSize ?? size;

      const selectedPet = gallery.pets.find((entry) => entry.id === pet) ?? null;
      const canvasRef = useSpriteCanvas(selectedPet);

      /**
       * Write a setting straight into the host.
       *
       * Both settings are volatile, so the host commits them into the running
       * plugin and the pet on screen changes by itself. There is nothing to
       * save, and therefore no button to press.
       */
      const apply = async (patch) => {
        let ok = true;
        // A value is only remembered as written once the host took it, so a
        // rejected write can still be retried by clicking the same card.
        if (typeof patch.pet === 'string' && patch.pet !== written.current.pet) {
          const done = await form.set('pet', patch.pet);
          if (done) written.current.pet = patch.pet;
          ok = done && ok;
        }
        if (typeof patch.size === 'number' && patch.size !== written.current.size) {
          const done = await form.set('size', patch.size);
          if (done) written.current.size = patch.size;
          ok = done && ok;
        }
        setFailed(!ok);
      };

      // Picking a pet applies it at once.
      const pick = (id) => {
        apply({ pet: id });
      };

      /**
       * The slider writes at every step, so the pet on the desktop grows and
       * shrinks while the thumb moves. A write is a round trip, so steps that
       * arrive while one is in flight are folded into the newest value; the
       * host is never asked for something that is already out of date.
       */
      const flushSize = async () => {
        if (flushing.current) return;
        flushing.current = true;
        while (pendingSize.current !== null) {
          const next = pendingSize.current;
          pendingSize.current = null;
          await apply({ size: next });
        }
        flushing.current = false;
        // Back to the host's value: it is the one that was written, or the
        // one that stayed when a write was refused.
        setDraftSize(null);
      };

      const resize = (next) => {
        setDraftSize(next);
        pendingSize.current = next;
        flushSize();
      };

      const writable = snapshot?.writable !== false;
      const petName = selectedPet ? selectedPet.name : pet;

      // The Plugins page asks every plugin for a one-liner beside its card.
      if (props.view === 'summary') {
        return h('span', null, `${t('current')}：${petName} · ${size} px`);
      }

      return h(
        'div',
        { className: 'dshpet_page' },
        h('div', null, h('div', { className: 'dshpet_title' }, t('title')), h('div', { className: 'dshpet_desc' }, t('description'))),
        h(
          'div',
          null,
          h('div', { className: 'dshpet_label' }, t('preview')),
          h(
            'div',
            { className: 'dshpet_stage' },
            h('canvas', {
              ref: canvasRef,
              className: 'dshpet_canvas',
              width: shownSize,
              height: shownSize,
              style: { width: shownSize + 'px', height: shownSize + 'px' },
            }),
          ),
        ),
        h(
          'div',
          null,
          h('div', { className: 'dshpet_label' }, t('size')),
          h(
            'div',
            { className: 'dshpet_row' },
            h('input', {
              className: 'dshpet_range',
              type: 'range',
              min: String(MIN_SIZE),
              max: String(MAX_SIZE),
              step: '10',
              value: String(shownSize),
              disabled: !writable,
              onChange: (event) => resize(Number(event.target.value)),
            }),
            h('span', { className: 'dshpet_value' }, shownSize + ' px'),
          ),
          h('div', { className: 'dshpet_note' }, t('sizeHint')),
        ),
        h(
          'div',
          null,
          h('div', { className: 'dshpet_label' }, t('gallery')),
          gallery.loading
            ? h('div', { className: 'dshpet_note' }, '…')
            : gallery.failed
              ? h('div', { className: 'dshpet_error' }, t('loadFailed'))
              : h(
                  'div',
                  { className: 'dshpet_grid' },
                  gallery.pets.map((entry) => h(PetCard, { key: entry.id, pet: entry, selected: entry.id === pet, onSelect: pick })),
                ),
        ),
        // Only trouble is worth a line; a write that worked says nothing.
        failed || !writable
          ? h(
              'div',
              { className: 'dshpet_actions' },
              failed ? h('span', { className: 'dshpet_error' }, t('saveFailed')) : null,
              !writable ? h('span', { className: 'dshpet_note' }, t('readOnly')) : null,
            )
          : null,
      );
    }

    /** The settings form of this plugin's host entry. */
    let formRef = { current: null };
    /** The locale reader of this page's dictionary. */
    let translate = (key) => key;

    /**
     * Mount the pet settings page while the Host serves this namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      translate = t;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');

      const form = ctx.configForms.get('dsh-pet');
      formRef.current = form;

      ctx.effect(
        () =>
          ctx.configForms.whileServed(['dsh-pet'], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'pet',
                  order: 25,
                  label: () => t('nav'),
                  locale: NS,
                },
                PetSection,
              ),
            ),
          ),
        'dsh-pet: settings section',
      );

      // The Plugins page lists every installed plugin; the pet's own page
      // carries the same picker, so it is reachable from both surfaces.
      ctx.slots.inject('plugins.item', () =>
        ctx.slots.register(
          {
            name: 'plugins.item',
            id: 'dsh-pet',
            order: 40,
            label: () => t('title'),
            locale: NS,
          },
          PetSection,
        ),
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'configForms'];
    return module.exports;
  },
});
