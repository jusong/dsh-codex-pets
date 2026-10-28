/*
 * dsh-codex-pets — browser half.
 *
 * Registers a Settings section that lists every pet the host ships and lets
 * the user pick one and set its size. The gallery is read from the host at
 * runtime, so a pet added to `pets/` shows up here without this file
 * changing; the two settings are written through DSH's own settings form, so
 * they land in the profile patch like every other plugin setting.
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-pets',
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
      pets: '/api/dsh-codex-pets/pets',
      sprite: '/api/dsh-codex-pets/sprite',
      preview: '/api/dsh-codex-pets/preview',
      install: '/api/dsh-codex-pets/install',
      remove: '/api/dsh-codex-pets/remove',
      reorder: '/api/dsh-codex-pets/reorder',
      codexPets: '/api/dsh-codex-pets/codex-pets',
      importCodex: '/api/dsh-codex-pets/import-codex',
      focus: '/api/dsh-codex-pets/focus',
      runtime: '/api/dsh-codex-pets/runtime',
    };

    /** Panel bounds, in CSS pixels; the host clamps to the same range. */
    const MIN_SIZE = 80;
    const MAX_SIZE = 260;
    /** Edge of a gallery thumbnail, in CSS pixels. */
    const THUMB_SIZE = 112;
    const DEFAULT_SIZE = 220;

    const en = {
      nav: 'Pet',
      title: 'Desktop pet',
      description: 'Pick the pet that floats on your desktop and set how large it is.',
      gallery: 'Available pets',
      galleryBundled: 'Built-in',
      galleryUser: 'Installed',
      galleryUserHint: 'Drag a card to change the order. Newly installed pets join the end.',
      removeBundled: 'Built-in pets cannot be deleted.',
      size: 'Size',
      sizeHint: 'The edge of the floating panel, in pixels.',
      preview: 'Preview',
      visible: 'Show the pet',
      visibleHint: 'Turn it off to hide the pet. Right-clicking the pet offers the same thing.',
      saveFailed: 'The change was not accepted; try again.',
      loadFailed: 'The pet gallery could not be loaded.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      selected: 'Selected',
      current: 'Current',
      remove: 'Delete',
      removeTitle: 'Delete {name}',
      removeLast: 'The last pet cannot be deleted.',
      confirmText: 'Delete "{name}"? This cannot be undone.',
      confirmYes: 'Delete',
      confirmNo: 'Cancel',
      removed: 'Deleted "{name}".',
      removedSwitched: 'Deleted "{name}" and switched to "{next}".',
      install: 'Install a pet',
      installHint: 'Pick a pet on codex-pets.net, then paste its ID or the link of its page here.',
      installPlaceholder: 'Pet ID or link, e.g. https://codex-pets.net/#/pets/deepseek',
      installButton: 'Install',
      installing: 'Installing…',
      browse: 'Browse codex-pets.net',
      installed: 'Installed "{name}" and switched to it.',
      installedAlready: '"{name}" is already installed; switched to it.',
      importTitle: 'Import from Codex',
      importFound: '{n} pet(s) in your Codex folder are not here yet.',
      importNone: 'Every pet in your Codex folder is already here.',
      importEmpty: 'No pets to import were found in Codex on this machine (~/.codex/pets or ChatGPT.app).',
      importButton: 'Import all',
      importing: 'Importing…',
      importDone: 'Imported {n} pet(s).',
      importSkipped: ' {n} already here.',
      importFailed: ' {n} could not be imported.',
      importNothing: 'There was nothing new to import.',
      errSource: 'Enter a pet ID or the link of a pet page on codex-pets.net.',
      errNotFound: 'codex-pets.net has no pet with that ID.',
      errUnreachable: 'Could not reach codex-pets.net. Check your network and try again.',
      errInvalidPet: 'That pet cannot be installed.',
      errGone: 'That pet is already gone.',
      errNetwork: 'The request did not go through; try again.',
      errGeneric: 'Something went wrong; try again.',
      sessions: 'Recent sessions',
      sessionsHint: 'Show a count under the pet. Click it for the sessions you used most recently, click again to fold it, and click a session to open it.',
      sessionLimit: 'How many',
      sessionLimitHint: 'From 1 to 10.',
      sessionMotion: 'React to tasks',
      sessionMotionHint: 'While a listed session is working, the pet keeps running. When one finishes, it jumps three times.',
      shortcut: 'New session shortcut',
      shortcutHint: 'Click the field and press a shortcut, for example ⌘⌥N. Press Delete to turn it off.',
      shortcutCapture: 'Press a shortcut',
      shortcutListening: 'Press keys to record',
      runtimeReady: 'Desktop window ready (Electron {version}).',
      runtimeDownloading: 'Downloading Electron… {pct}',
      runtimeDownloadingUnknown: 'Downloading Electron…',
      runtimeExtracting: 'Unpacking Electron…',
      runtimeFailed: 'The desktop pet needs Electron, and the download did not finish.',
      runtimeUnsupported: 'The floating pet runs in DSH Desktop on macOS.',
      runtimeRetry: 'Try again',
      runtimeSourcePlaceholder: 'Optional: address of an Electron zip',
      runtimeDrop: 'Offline: put {file} in {dir}, then try again.',
      runtimeBadSource: 'The address must start with http:// or https://.',
    };

    const zh = {
      nav: '宠物',
      title: '桌面宠物',
      description: '挑选飘在桌面上的宠物，并设置它的大小。',
      gallery: '可选宠物',
      galleryBundled: '内置',
      galleryUser: '已安装',
      galleryUserHint: '按住卡片拖动可调整顺序；新安装的宠物排在最后。',
      removeBundled: '随插件发布的宠物不能删除。',
      size: '尺寸',
      sizeHint: '悬浮窗的边长，单位是像素。',
      preview: '预览',
      visible: '显示宠物',
      visibleHint: '关掉后宠物从桌面消失；右键宠物也能隐藏。',
      saveFailed: '这次修改没有写进去，请再试一次。',
      loadFailed: '宠物列表加载失败。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      selected: '已选中',
      current: '当前',
      remove: '删除',
      removeTitle: '删除 {name}',
      removeLast: '至少要保留一只宠物，最后一只不能删除。',
      confirmText: '确定删除「{name}」吗？删除后无法恢复。',
      confirmYes: '删除',
      confirmNo: '取消',
      removed: '已删除「{name}」。',
      removedSwitched: '已删除「{name}」，已切换到「{next}」。',
      install: '安装宠物',
      installHint: '在 codex-pets.net 挑选宠物，把它的 ID 或页面链接粘贴到这里即可安装。',
      installPlaceholder: '宠物 ID 或链接，例如 https://codex-pets.net/#/pets/deepseek',
      installButton: '安装',
      installing: '安装中…',
      browse: '去 codex-pets.net 挑选',
      installed: '已安装「{name}」，并已切换到它。',
      installedAlready: '「{name}」之前已经安装过了，已切换到它。',
      importTitle: '从 Codex 导入',
      importFound: '本机 Codex 里有 {n} 只宠物还没导入。',
      importNone: '本机 Codex 里的宠物都已经导入过了。',
      importEmpty: '本机 Codex 里没有找到可导入的宠物（~/.codex/pets 或 ChatGPT.app）。',
      importButton: '一键导入',
      importing: '导入中…',
      importDone: '已导入 {n} 只宠物。',
      importSkipped: '另有 {n} 只已存在。',
      importFailed: '{n} 只导入失败。',
      importNothing: '没有可以导入的新宠物。',
      errSource: '请输入宠物 ID，或 codex-pets.net 上宠物页面的链接。',
      errNotFound: 'codex-pets.net 上没有这个 ID 的宠物。',
      errUnreachable: '连接不上 codex-pets.net，请检查网络后重试。',
      errInvalidPet: '这只宠物无法安装。',
      errGone: '这只宠物已经不在了。',
      errNetwork: '请求没有发出去，请再试一次。',
      errGeneric: '出了点问题，请再试一次。',
      sessions: '最近会话',
      sessionsHint: '打开后，宠物下方会出现一个数字球。点一下展开最近交互过的会话，再点收起；点某一条会打开窗口并跳到那个会话。',
      sessionLimit: '显示数量',
      sessionLimitHint: '最多 10 个。',
      sessionMotion: '任务反应',
      sessionMotionHint: '有任务在进行时，宠物切换为 running；有任务完成时，主动跳跃 3 次。',
      shortcut: '新会话快捷键',
      shortcutHint: '点一下输入框，按下组合键即可录入，例如 ⌘⌥N。按删除键可关闭。',
      shortcutCapture: '按下快捷键',
      shortcutListening: '请开始按键录入',
      runtimeReady: '桌面窗口已就绪（Electron {version}）。',
      runtimeDownloading: '正在下载 Electron… {pct}',
      runtimeDownloadingUnknown: '正在下载 Electron…',
      runtimeExtracting: '正在解压 Electron…',
      runtimeFailed: '桌面宠物需要 Electron，这次没有下载成功。',
      runtimeUnsupported: '悬浮宠物目前只在 macOS 上的 DSH Desktop 里运行。',
      runtimeRetry: '重试',
      runtimeSourcePlaceholder: '可选：Electron 压缩包的下载地址',
      runtimeDrop: '离线安装：把 {file} 放到 {dir} 后再点重试。',
      runtimeBadSource: '地址需要以 http:// 或 https:// 开头。',
    };

    /** Read a JSON payload from a same-origin route. */
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`request failed: ${response.status}`);
      return response.json();
    }

    /** Post a JSON body; `{ ok, data }` on success, `{ ok: false, error }` otherwise. */
    async function postJson(url, body) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      } catch {
        return { ok: false, error: { code: 'network' } };
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.ok) return { ok: true, data: data ?? {} };
      return { ok: false, error: data?.error ?? { code: 'http' } };
    }

    /** Fill `{name}`-style holes of a dictionary entry. */
    function fill(text, values) {
      return text.replace(/\{(\w+)\}/g, (hole, key) => String(values[key] ?? hole));
    }

    /** Which dictionary entry words each failure the host reports. */
    const ERROR_KEYS = {
      'invalid-source': 'errSource',
      'not-found': 'errNotFound',
      unreachable: 'errUnreachable',
      'no-unzip': 'errUnreachable',
      'invalid-pet': 'errInvalidPet',
      'too-large': 'errInvalidPet',
      insecure: 'errInvalidPet',
      exists: 'errInvalidPet',
      last: 'removeLast',
      bundled: 'removeBundled',
      'invalid-id': 'errGone',
      'not-installed': 'errGone',
      'invalid-order': 'errGeneric',
      network: 'errNetwork',
    };

    /** A failure from the host, in the reader's language. */
    function errorText(t, error) {
      const text = t(ERROR_KEYS[error?.code] ?? 'errGeneric');
      // A pet that cannot be read says why, in the host's own words.
      return error?.code === 'invalid-pet' && error.message ? text + ' (' + error.message + ')' : text;
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
      '.dshpet_stage{box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:' + (MAX_SIZE + 26) + 'px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dshpet_canvas{image-rendering:pixelated;display:block}',
      '.dshpet_row{display:flex;align-items:center;gap:12px}',
      '.dshpet_range{flex:1;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_value{min-width:64px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dshpet_actions{display:flex;align-items:center;gap:10px}',
      '.dshpet_item{position:relative;display:flex;flex-direction:column}',
      '.dshpet_item>.dshpet_card{flex:1}',
      '.dshpet_item[draggable="true"]{cursor:grab}',
      '.dshpet_item[data-dragging="true"]{opacity:.45}',
      '.dshpet_item[data-drop="true"]>.dshpet_card{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_section{display:flex;flex-direction:column;gap:10px;margin-top:14px}',
      '.dshpet_section:first-child{margin-top:0}',
      '.dshpet_del{position:absolute;top:6px;right:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:16px;line-height:1;opacity:0;transition:opacity 120ms cubic-bezier(.23,1,.32,1),background 120ms cubic-bezier(.23,1,.32,1),color 120ms cubic-bezier(.23,1,.32,1)}',
      '.dshpet_item:hover .dshpet_del,.dshpet_del:focus-visible{opacity:1}',
      '.dshpet_del:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}',
      '.dshpet_del:disabled{cursor:not-allowed}',
      '.dshpet_del:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dshpet_confirm{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-3);text-align:center}',
      '.dshpet_confirmText{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dshpet_btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dshpet_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpet_btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dshpet_btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshpet_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:#fff}',
      '.dshpet_btnPrimary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);filter:brightness(1.08)}',
      '.dshpet_btnDanger{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:#fff}',
      '.dshpet_btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}',
      '.dshpet_buttons{display:flex;gap:8px}',
      '.dshpet_input{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}',
      '.dshpet_input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshpet_shortcut{flex:none;width:148px}',
      '.dshpet_inputArmed{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_listen{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary);white-space:nowrap}',
      '.dshpet_link{font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_ok{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dshpet_install{display:flex;flex-direction:column;gap:10px}',
      '.dshpet_check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshpet_switch{margin-top:2px;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshpet_note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshpet_error{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
      '.dshpet_bar{height:6px;border-radius:99px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}',
      '.dshpet_barFill{height:100%;background:var(--dsw-alias-state-business-primary)}',
      '.dshpet_break{word-break:break-all}',
    ].join('');

    /** Install the page's stylesheet once. */
    function useStyles() {
      useEffect(() => {
        const id = 'dsh-codex-pets/styles.css';
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-codex-pets';
        tag.dataset.pluginCss = id;
        tag.textContent = css;
        document.head.appendChild(tag);
      }, []);
    }

    /**
     * Load the pet gallery from the host.
     *
     * `reload` fetches it again after pets were installed or deleted; the
     * grid keeps showing the old list meanwhile, so it never blinks.
     */
    function useGallery() {
      const [state, setState] = useState({ pets: [], loading: true, failed: false });
      const [round, setRound] = useState(0);
      useEffect(() => {
        let cancelled = false;
        fetchJson(API.pets)
          .then((payload) => {
            if (cancelled) return;
            const pets = Array.isArray(payload?.pets) ? payload.pets : [];
            setState({ pets, loading: false, failed: false });
          })
          .catch(() => {
            if (!cancelled) setState((before) => ({ pets: before.pets, loading: false, failed: before.pets.length === 0 }));
          });
        return () => {
          cancelled = true;
        };
      }, [round]);
      const reload = useCallback(() => setRound((n) => n + 1), []);
      return { ...state, reload };
    }

    /**
     * Load one pet's still preview as an object URL.
     *
     * Pets made for Codex ship an atlas and nothing else, so `wanted` is false
     * for them and the card draws its own thumbnail from the atlas instead.
     */
    function usePreviewUrl(petId, wanted) {
      const [state, setState] = useState({ url: null, failed: false });
      useEffect(() => {
        if (!petId || !wanted) {
          setState({ url: null, failed: !wanted });
          return undefined;
        }
        let cancelled = false;
        let created = null;
        setState({ url: null, failed: false });
        fetchObjectUrl(API.preview + '?id=' + encodeURIComponent(petId))
          .then((objectUrl) => {
            created = objectUrl;
            if (cancelled) URL.revokeObjectURL(objectUrl);
            else setState({ url: objectUrl, failed: false });
          })
          .catch(() => {
            if (!cancelled) setState({ url: null, failed: true });
          });
        return () => {
          cancelled = true;
          if (created !== null) URL.revokeObjectURL(created);
        };
      }, [petId, wanted]);
      return state;
    }

    /**
     * Play a pet's idle animation on a canvas.
     *
     * The atlas is fetched once per pet. The canvas itself never changes
     * size -- assigning to a canvas's width or height wipes it, and the
     * blank would show until the next animation frame -- so it is as large as
     * the biggest pet and the pet is drawn smaller inside it. The drawn size
     * is eased towards `size` on every frame, which is what makes the preview
     * follow the slider smoothly instead of stepping.
     */
    function useSpriteCanvas(pet, size) {
      const canvasRef = useRef(null);
      const sizeRef = useRef(size);
      sizeRef.current = size;
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
        // The edge the pet is drawn at right now, on its way to sizeRef.
        let shown = sizeRef.current;
        let drawnEdge = -1;

        const dpr = window.devicePixelRatio || 1;
        const backing = Math.round(MAX_SIZE * dpr);
        if (canvas.width !== backing || canvas.height !== backing) {
          canvas.width = backing;
          canvas.height = backing;
        }

        const draw = () => {
          const context = canvas.getContext('2d');
          if (!context) return;
          context.imageSmoothingEnabled = false;
          context.clearRect(0, 0, backing, backing);
          drawnEdge = shown;
          if (image === null) return;
          const edge = shown * dpr;
          const scale = edge / Math.max(cell.width, cell.height);
          const drawWidth = cell.width * scale;
          const drawHeight = cell.height * scale;
          context.drawImage(
            image,
            frame < 0 ? 0 : frame * cell.width,
            spec.row * cell.height,
            cell.width,
            cell.height,
            (backing - drawWidth) / 2,
            (backing - drawHeight) / 2,
            drawWidth,
            drawHeight,
          );
        };

        const tick = (now) => {
          if (cancelled) return;
          raf = requestAnimationFrame(tick);
          if (last === 0) last = now;
          const delta = Math.min(50, now - last);
          elapsed = (elapsed + (now - last)) % total;
          last = now;

          // Exponential easing, 50ms time constant: quick to follow the
          // thumb, no overshoot, and a target that moves mid-glide just
          // changes where the pet is heading.
          const gap = sizeRef.current - shown;
          shown = Math.abs(gap) < 0.25 ? sizeRef.current : shown + gap * (1 - Math.exp(-delta / 50));

          let accumulated = 0;
          let index = 0;
          for (let i = 0; i < durations.length; i += 1) {
            accumulated += durations[i];
            if (elapsed < accumulated) {
              index = i;
              break;
            }
          }
          if (index !== frame || shown !== drawnEdge) {
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

    /**
     * A thumbnail cut out of the atlas: the first frame of the idle row.
     *
     * This is how a pet without a preview image of its own is shown.
     */
    function AtlasThumb(props) {
      const { pet } = props;
      const canvasRef = useRef(null);
      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const cell = pet.cell || { width: 192, height: 208 };
        const row = pet.animations?.[pet.idle || 'idle']?.row ?? 0;
        let cancelled = false;
        let objectUrl = null;
        fetchObjectUrl(API.sprite + '?id=' + encodeURIComponent(pet.id))
          .then((url) => {
            if (cancelled) {
              URL.revokeObjectURL(url);
              return;
            }
            objectUrl = url;
            const image = new Image();
            image.onload = () => {
              const context = canvas.getContext('2d');
              if (cancelled || !context) return;
              const dpr = window.devicePixelRatio || 1;
              const edge = Math.round(THUMB_SIZE * dpr);
              canvas.width = edge;
              canvas.height = edge;
              context.imageSmoothingEnabled = false;
              const scale = edge / Math.max(cell.width, cell.height);
              const width = cell.width * scale;
              const height = cell.height * scale;
              context.drawImage(image, 0, row * cell.height, cell.width, cell.height, (edge - width) / 2, (edge - height) / 2, width, height);
            };
            image.src = url;
          })
          .catch(() => {});
        return () => {
          cancelled = true;
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        };
      }, [pet.id]);
      return h('canvas', {
        ref: canvasRef,
        className: 'dshpet_thumb',
        'aria-label': pet.name,
        style: { width: THUMB_SIZE + 'px', height: THUMB_SIZE + 'px' },
      });
    }

    /** One gallery card: the pet's still preview and its name. */
    function PetCard(props) {
      const { pet, selected, onSelect } = props;
      const { url, failed } = usePreviewUrl(pet.id, pet.hasPreview !== false);
      return h(
        'button',
        {
          type: 'button',
          className: 'dshpet_card',
          'data-selected': selected ? 'true' : 'false',
          'aria-pressed': selected ? 'true' : 'false',
          onClick: () => onSelect(pet.id),
        },
        url !== null
          ? h('img', { className: 'dshpet_thumb', src: url, alt: pet.name, loading: 'lazy' })
          : failed
            ? h(AtlasThumb, { pet })
            : h('div', { className: 'dshpet_thumbFallback' }),
        h('span', { className: 'dshpet_name' }, pet.name),
      );
    }

    /**
     * A card with its delete button.
     *
     * The button is a sibling of the card, not a child: a button inside a
     * button is not valid. Deleting asks first, in place -- the card turns
     * into the question -- and the answer to "cancel" is the default focus.
     */
    function PetItem(props) {
      const {
        pet, selected, confirming, canDelete, canDrag, busy, dragging, dropTarget,
        onSelect, onAsk, onCancel, onConfirm, onDragStart, onDragOver, onDrop, onDragEnd,
      } = props;
      const t = translate;
      const cancelRef = useRef(null);
      useEffect(() => {
        if (confirming && cancelRef.current) cancelRef.current.focus();
      }, [confirming]);
      const why = pet.bundled ? t('removeBundled') : t('removeLast');
      return h(
        'div',
        {
          className: 'dshpet_item',
          'data-pet': pet.id,
          'data-dragging': dragging ? 'true' : 'false',
          'data-drop': dropTarget ? 'true' : 'false',
          draggable: canDrag && !confirming ? 'true' : undefined,
          onDragStart: canDrag ? (event) => onDragStart(event, pet.id) : undefined,
          onDragOver: canDrag ? (event) => onDragOver(event, pet.id) : undefined,
          onDrop: canDrag ? (event) => onDrop(event, pet.id) : undefined,
          onDragEnd: canDrag ? onDragEnd : undefined,
        },
        h(PetCard, { pet, selected, onSelect }),
        pet.bundled
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dshpet_del',
                'aria-label': fill(t('removeTitle'), { name: pet.name }),
                title: canDelete ? fill(t('removeTitle'), { name: pet.name }) : why,
                disabled: !canDelete || busy,
                onClick: () => onAsk(pet.id),
              },
              '\u00d7',
            ),
        confirming
          ? h(
              'div',
              {
                className: 'dshpet_confirm',
                role: 'alertdialog',
                'aria-label': fill(t('confirmText'), { name: pet.name }),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') onCancel();
                },
              },
              h('div', { className: 'dshpet_confirmText' }, fill(t('confirmText'), { name: pet.name })),
              h(
                'div',
                { className: 'dshpet_buttons' },
                h('button', { type: 'button', className: 'dshpet_btn', ref: cancelRef, onClick: onCancel }, t('confirmNo')),
                h(
                  'button',
                  { type: 'button', className: 'dshpet_btn dshpet_btnDanger', disabled: busy, onClick: () => onConfirm(pet.id) },
                  t('confirmYes'),
                ),
              ),
            )
          : null,
      );
    }

    /**
     * Installing: a pet from codex-pets.net by its ID or page link, or every
     * pet Codex already put on this machine.
     */
    function InstallPanel(props) {
      const { writable, onInstalled, onImported, report, version } = props;
      const t = translate;
      const [source, setSource] = useState('');
      const [working, setWorking] = useState(null);
      const [local, setLocal] = useState(null);

      // What Codex has on this machine; asked again whenever pets changed.
      useEffect(() => {
        let cancelled = false;
        fetchJson(API.codexPets)
          .then((payload) => {
            if (!cancelled) setLocal(Array.isArray(payload?.pets) ? payload.pets : []);
          })
          .catch(() => {
            if (!cancelled) setLocal(null);
          });
        return () => {
          cancelled = true;
        };
      }, [version]);

      const install = async () => {
        const text = source.trim();
        if (text === '' || working !== null) return;
        setWorking('install');
        report(null);
        const result = await postJson(API.install, { source: text });
        setWorking(null);
        if (!result.ok) {
          report({ kind: 'error', text: errorText(t, result.error) });
          return;
        }
        setSource('');
        const { pet, already } = result.data;
        report({ kind: 'ok', text: fill(t(already ? 'installedAlready' : 'installed'), { name: pet?.name ?? pet?.id ?? '' }) });
        onInstalled(pet?.id);
      };

      const importAll = async () => {
        if (working !== null) return;
        setWorking('import');
        report(null);
        const result = await postJson(API.importCodex, {});
        setWorking(null);
        if (!result.ok) {
          report({ kind: 'error', text: errorText(t, result.error) });
          return;
        }
        const installed = result.data.installed?.length ?? 0;
        const skipped = result.data.skipped?.length ?? 0;
        const failedCount = result.data.failed?.length ?? 0;
        const parts = [installed > 0 ? fill(t('importDone'), { n: installed }) : t('importNothing')];
        if (skipped > 0) parts.push(fill(t('importSkipped'), { n: skipped }));
        if (failedCount > 0) parts.push(fill(t('importFailed'), { n: failedCount }));
        report({ kind: failedCount > 0 && installed === 0 ? 'error' : 'ok', text: parts.join(' ') });
        onImported();
      };

      const ready = local === null ? 0 : local.filter((entry) => entry.status === 'ready').length;
      const importText = local === null
        ? null
        : local.length === 0
          ? t('importEmpty')
          : ready > 0
            ? fill(t('importFound'), { n: ready })
            : t('importNone');

      return h(
        'div',
        { className: 'dshpet_install' },
        h(
          'div',
          null,
          h('div', { className: 'dshpet_label' }, t('install')),
          h('div', { className: 'dshpet_note' }, t('installHint')),
        ),
        h(
          'form',
          {
            className: 'dshpet_row',
            onSubmit: (event) => {
              event.preventDefault();
              install();
            },
          },
          h('input', {
            className: 'dshpet_input',
            type: 'text',
            value: source,
            placeholder: t('installPlaceholder'),
            'aria-label': t('install'),
            spellCheck: false,
            autoComplete: 'off',
            disabled: !writable || working !== null,
            onChange: (event) => setSource(event.target.value),
          }),
          h(
            'button',
            {
              type: 'submit',
              className: 'dshpet_btn dshpet_btnPrimary',
              disabled: !writable || working !== null || source.trim() === '',
            },
            working === 'install' ? t('installing') : t('installButton'),
          ),
        ),
        h('a', { className: 'dshpet_link', href: 'https://codex-pets.net/', target: '_blank', rel: 'noreferrer noopener' }, t('browse') + ' \u2197'),
        importText === null
          ? null
          : h(
              'div',
              { className: 'dshpet_row' },
              h(
                'div',
                { style: { flex: 1 } },
                h('div', { className: 'dshpet_label' }, t('importTitle')),
                h('div', { className: 'dshpet_note' }, importText),
              ),
              h(
                'button',
                { type: 'button', className: 'dshpet_btn', disabled: !writable || working !== null || ready === 0, onClick: importAll },
                working === 'import' ? t('importing') : t('importButton') + (ready > 0 ? ' (' + ready + ')' : ''),
              ),
            ),
      );
    }

    const SHORTCUT_SYMBOL = { Command: '⌘', Option: '⌥', Control: '⌃', Shift: '⇧' };

    /** `Command+Option+N` as the symbols the field shows. Same rules as lib/shortcut.js. */
    function formatShortcut(value) {
      if (typeof value !== 'string' || value.trim() === '') return '';
      return value.split('+').map((part) => SHORTCUT_SYMBOL[part] || part).join('');
    }

    /** One keydown, as the chord to store. '' clears it; undefined leaves the current chord. */
    function shortcutFromKeyboard(event) {
      if (event == null) return undefined;
      if (event.key === 'Backspace' || event.key === 'Delete') return '';
      const code = typeof event.code === 'string' ? event.code : '';
      let key = '';
      if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
      else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
      else if (code === 'Space') key = 'Space';
      else if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) key = code;
      else return undefined;
      const names = [];
      if (event.metaKey === true) names.push('Command');
      if (event.altKey === true) names.push('Option');
      if (event.ctrlKey === true) names.push('Control');
      if (event.shiftKey === true) names.push('Shift');
      if (names.length < 2) return undefined;
      return names.concat(key).join('+');
    }

    /** Where fetching Electron stands. The pet window cannot open without it. */
    function RuntimeBlock() {
      const t = translate;
      const [runtime, setRuntime] = useState(null);
      const [source, setSource] = useState('');
      const [busy, setBusy] = useState(false);
      const [localError, setLocalError] = useState('');
      const seeded = useRef(false);

      useEffect(() => {
        let gone = false;
        let timer = 0;
        const load = async () => {
          try {
            const data = await fetchJson(API.runtime);
            if (gone) return;
            setRuntime(data);
            const live = data.status === 'downloading' || data.status === 'extracting';
            const pending = data.status === 'idle' || data.status === 'failed';
            timer = setTimeout(load, live ? 700 : pending ? 2000 : 15000);
          } catch {
            if (!gone) setRuntime({ status: 'unreachable' });
            timer = setTimeout(load, 5000);
          }
        };
        load();
        return () => {
          gone = true;
          clearTimeout(timer);
        };
      }, []);

      useEffect(() => {
        if (seeded.current || typeof runtime?.custom !== 'string' || runtime.custom === '') return;
        seeded.current = true;
        setSource(runtime.custom);
      }, [runtime]);

      const retry = async () => {
        setBusy(true);
        setLocalError('');
        const body = { source: source.trim() };
        const result = await postJson(API.runtime, body);
        setBusy(false);
        if (!result.ok) {
          setLocalError(result.error?.code === 'invalid-source' ? t('runtimeBadSource') : errorText(t, result.error));
          return;
        }
        setRuntime(result.data);
      };

      if (runtime === null || runtime.status === 'idle') return null;
      if (runtime.status === 'ready') {
        return h('div', { className: 'dshpet_note' }, fill(t('runtimeReady'), { version: runtime.version || '' }));
      }
      if (runtime.status === 'unsupported') {
        return h('div', { className: 'dshpet_note' }, t('runtimeUnsupported'));
      }
      if (runtime.status === 'unreachable') {
        return h('div', { className: 'dshpet_error' }, t('errNetwork'));
      }

      const pct = runtime.total > 0 ? Math.min(100, Math.round((runtime.received / runtime.total) * 100)) : null;
      const attempts = Array.isArray(runtime.attempts) ? runtime.attempts.slice(-4) : [];
      return h(
        'div',
        null,
        runtime.status === 'downloading'
          ? h('div', { className: 'dshpet_note' }, pct === null ? t('runtimeDownloadingUnknown') : fill(t('runtimeDownloading'), { pct: pct + '%' }))
          : null,
        runtime.status === 'downloading' && pct !== null
          ? h('div', { className: 'dshpet_bar' }, h('div', { className: 'dshpet_barFill', style: { width: pct + '%' } }))
          : null,
        runtime.status === 'extracting' ? h('div', { className: 'dshpet_note' }, t('runtimeExtracting')) : null,
        runtime.status === 'failed'
          ? h(
              'div',
              null,
              h('div', { className: 'dshpet_error' }, t('runtimeFailed')),
              attempts.map((item, index) => h('div', { className: 'dshpet_note dshpet_break', key: index }, (item.source || '') + ' — ' + (item.error || ''))),
              runtime.file && runtime.dropDir
                ? h('div', { className: 'dshpet_note dshpet_break' }, fill(t('runtimeDrop'), { file: runtime.file, dir: runtime.dropDir }))
                : null,
              h(
                'div',
                { className: 'dshpet_row', style: { marginTop: '8px' } },
                h('input', {
                  className: 'dshpet_input',
                  type: 'text',
                  value: source,
                  placeholder: t('runtimeSourcePlaceholder'),
                  onChange: (event) => setSource(event.target.value),
                }),
                h('button', { className: 'dshpet_btn', type: 'button', disabled: busy, onClick: retry }, t('runtimeRetry')),
              ),
              localError ? h('div', { className: 'dshpet_error' }, localError) : null,
            )
          : null,
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
      const shortcut = typeof value.shortcut === 'string' ? value.shortcut : 'Command+Option+N';
      const [shortcutDraft, setShortcutDraft] = useState(shortcut);
      const [shortcutArmed, setShortcutArmed] = useState(false);
      // The slider's own value while it is being dragged. The host's answer
      // trails the finger, so showing it would drag the thumb backwards.
      const [draftSize, setDraftSize] = useState(null);
      const pendingSize = useRef(null);
      const flushing = useRef(false);
      const written = useRef({ pet: null, size: null });
      // Which card is asking "delete?", what is being deleted, what happened.
      const [confirmId, setConfirmId] = useState(null);
      const [removing, setRemoving] = useState(false);
      const [notice, setNotice] = useState(null);
      // Bumped whenever pets were installed or deleted.
      const [changes, setChanges] = useState(0);
      const [dragId, setDragId] = useState(null);
      const [dropId, setDropId] = useState(null);
      const [userOrder, setUserOrder] = useState(null);

      useEffect(() => {
        setShortcutDraft(shortcut);
      }, [shortcut]);

      // The host owns the values; a draft only survives a drag in progress.
      const pet = typeof value.pet === 'string' ? value.pet : (gallery.pets[0]?.id ?? '');
      const size = typeof value.size === 'number' ? value.size : DEFAULT_SIZE;
      const shownSize = draftSize ?? size;
      const visibleOn = value.visible !== false;
      const sessionsOn = value.sessions === true;
      const sessionMotionOn = value.sessionMotion === true;
      const rawLimit = Math.round(Number(value.sessionLimit));
      const sessionLimit = Number.isFinite(rawLimit) ? Math.min(10, Math.max(1, rawLimit)) : 5;

      const selectedPet = gallery.pets.find((entry) => entry.id === pet) ?? null;
      const canvasRef = useSpriteCanvas(selectedPet, shownSize);

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
        if (typeof patch.visible === 'boolean' && patch.visible !== written.current.visible) {
          const done = await form.set('visible', patch.visible);
          if (done) written.current.visible = patch.visible;
          ok = done && ok;
        }
        if (typeof patch.sessions === 'boolean' && patch.sessions !== written.current.sessions) {
          const done = await form.set('sessions', patch.sessions);
          if (done) written.current.sessions = patch.sessions;
          ok = done && ok;
        }
        if (typeof patch.sessionLimit === 'number' && patch.sessionLimit !== written.current.sessionLimit) {
          const done = await form.set('sessionLimit', patch.sessionLimit);
          if (done) written.current.sessionLimit = patch.sessionLimit;
          ok = done && ok;
        }
        if (typeof patch.sessionMotion === 'boolean' && patch.sessionMotion !== written.current.sessionMotion) {
          const done = await form.set('sessionMotion', patch.sessionMotion);
          if (done) written.current.sessionMotion = patch.sessionMotion;
          ok = done && ok;
        }
        if (typeof patch.shortcut === 'string' && patch.shortcut !== written.current.shortcut) {
          const done = await form.set('shortcut', patch.shortcut);
          if (done) written.current.shortcut = patch.shortcut;
          ok = done && ok;
        }
        setFailed(!ok);
      };

      // Picking a pet applies it at once.
      const pick = (id) => {
        setConfirmId(null);
        apply({ pet: id });
      };

      const changed = () => {
        setChanges((n) => n + 1);
        gallery.reload();
      };

      // Host order for user pets, overridden locally while a drag is in flight.
      const bundledPets = gallery.pets.filter((entry) => entry.bundled);
      const hostUserPets = gallery.pets.filter((entry) => !entry.bundled);
      const userPets = userOrder === null
        ? hostUserPets
        : userOrder.map((id) => hostUserPets.find((entry) => entry.id === id)).filter(Boolean)
          .concat(hostUserPets.filter((entry) => !userOrder.includes(entry.id)));

      useEffect(() => {
        setUserOrder(null);
      }, [gallery.pets]);

      const reorder = async (fromId, toId) => {
        if (fromId === toId || !writable) return;
        const ids = userPets.map((entry) => entry.id);
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(toId);
        if (from < 0 || to < 0) return;
        const next = ids.slice();
        next.splice(from, 1);
        next.splice(to, 0, fromId);
        setUserOrder(next);
        const result = await postJson(API.reorder, { ids: next });
        if (!result.ok) {
          setUserOrder(null);
          setNotice({ kind: 'error', text: errorText(t, result.error) });
          return;
        }
        gallery.reload();
      };

      const remove = async (id) => {
        const name = gallery.pets.find((entry) => entry.id === id)?.name ?? id;
        setRemoving(true);
        const result = await postJson(API.remove, { id });
        setRemoving(false);
        setConfirmId(null);
        const next = result.ok ? result.data?.next : null;
        if (result.ok && typeof next === 'string' && next !== '') {
          // The pet on the desktop was the one deleted: move the helper to the
          // replacement the host picked, then say where it went.
          apply({ pet: next });
          const nextName = gallery.pets.find((entry) => entry.id === next)?.name ?? next;
          setNotice({ kind: 'ok', text: fill(t('removedSwitched'), { name, next: nextName }) });
        } else if (result.ok) {
          setNotice({ kind: 'ok', text: fill(t('removed'), { name }) });
        } else {
          setNotice({ kind: 'error', text: errorText(t, result.error) });
        }
        changed();
      };

      // A freshly installed pet is what the user wants to see next.
      const installed = (id) => {
        changed();
        if (typeof id === 'string' && id !== '') apply({ pet: id });
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
        h(RuntimeBlock),
        h(
          'div',
          null,
          h('label', { className: 'dshpet_check' },
            h('input', {
              className: 'dshpet_switch',
              type: 'checkbox',
              checked: visibleOn,
              disabled: !writable,
              onChange: (event) => apply({ visible: event.target.checked }),
            }),
            h('span', null, t('visible')),
          ),
          h('div', { className: 'dshpet_note' }, t('visibleHint')),
        ),
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
              style: { width: MAX_SIZE + 'px', height: MAX_SIZE + 'px' },
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
          h('div', { className: 'dshpet_label' }, t('shortcut')),
          h(
            'div',
            { className: 'dshpet_row' },
            h('input', {
              className: 'dshpet_input dshpet_shortcut' + (shortcutArmed ? ' dshpet_inputArmed' : ''),
              type: 'text',
              readOnly: true,
              value: formatShortcut(shortcutDraft),
              disabled: !writable,
              placeholder: t('shortcutCapture'),
              onFocus: () => setShortcutArmed(true),
              onBlur: () => setShortcutArmed(false),
              onKeyDown: (event) => {
                event.preventDefault();
                event.stopPropagation();
                const next = shortcutFromKeyboard(event);
                if (next === undefined) return;
                setShortcutDraft(next);
                apply({ shortcut: next });
              },
            }),
            shortcutArmed ? h('span', { className: 'dshpet_listen' }, t('shortcutListening')) : null,
          ),
          h('div', { className: 'dshpet_note' }, t('shortcutHint')),
        ),
        h(
          'div',
          null,
          h('label', { className: 'dshpet_check' },
            h('input', {
              className: 'dshpet_switch',
              type: 'checkbox',
              checked: sessionsOn,
              disabled: !writable,
              onChange: (event) => apply({ sessions: event.target.checked }),
            }),
            h('span', null, t('sessions')),
          ),
          h('div', { className: 'dshpet_note' }, t('sessionsHint')),
          sessionsOn
            ? h(
                'div',
                { className: 'dshpet_row', style: { marginTop: '8px' } },
                h('span', { className: 'dshpet_note', style: { minWidth: '64px' } }, t('sessionLimit')),
                h('input', {
                  className: 'dshpet_range',
                  type: 'range',
                  min: '1',
                  max: '10',
                  step: '1',
                  value: String(sessionLimit),
                  disabled: !writable,
                  'aria-label': t('sessionLimit'),
                  onChange: (event) => apply({ sessionLimit: Number(event.target.value) }),
                }),
                h('span', { className: 'dshpet_value' }, String(sessionLimit)),
              )
            : null,
          h('label', { className: 'dshpet_check', style: { marginTop: '10px' } },
            h('input', {
              className: 'dshpet_switch',
              type: 'checkbox',
              checked: sessionMotionOn,
              disabled: !writable,
              onChange: (event) => apply({ sessionMotion: event.target.checked }),
            }),
            h('span', null, t('sessionMotion')),
          ),
          h('div', { className: 'dshpet_note' }, t('sessionMotionHint')),
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
                  null,
                  bundledPets.length > 0
                    ? h(
                        'div',
                        { className: 'dshpet_section' },
                        h('div', { className: 'dshpet_note' }, t('galleryBundled')),
                        h(
                          'div',
                          { className: 'dshpet_grid' },
                          bundledPets.map((entry) =>
                            h(PetItem, {
                              key: entry.id,
                              pet: entry,
                              selected: entry.id === pet,
                              confirming: false,
                              canDelete: false,
                              canDrag: false,
                              busy: removing,
                              dragging: false,
                              dropTarget: false,
                              onSelect: pick,
                              onAsk: setConfirmId,
                              onCancel: () => setConfirmId(null),
                              onConfirm: remove,
                            }),
                          ),
                        ),
                      )
                    : null,
                  userPets.length > 0
                    ? h(
                        'div',
                        { className: 'dshpet_section' },
                        h('div', { className: 'dshpet_note' }, t('galleryUser')),
                        h('div', { className: 'dshpet_note' }, t('galleryUserHint')),
                        h(
                          'div',
                          { className: 'dshpet_grid' },
                          userPets.map((entry) =>
                            h(PetItem, {
                              key: entry.id,
                              pet: entry,
                              selected: entry.id === pet,
                              confirming: confirmId === entry.id,
                              canDelete: writable && gallery.pets.length > 1,
                              canDrag: writable && userPets.length > 1,
                              busy: removing,
                              dragging: dragId === entry.id,
                              dropTarget: dropId === entry.id && dragId !== entry.id,
                              onSelect: pick,
                              onAsk: setConfirmId,
                              onCancel: () => setConfirmId(null),
                              onConfirm: remove,
                              onDragStart: (event, id) => {
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', id);
                                setDragId(id);
                              },
                              onDragOver: (event, id) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                if (dropId !== id) setDropId(id);
                              },
                              onDrop: (event, id) => {
                                event.preventDefault();
                                const from = event.dataTransfer.getData('text/plain') || dragId;
                                setDragId(null);
                                setDropId(null);
                                reorder(from, id);
                              },
                              onDragEnd: () => {
                                setDragId(null);
                                setDropId(null);
                              },
                            }),
                          ),
                        ),
                      )
                    : null,
                ),
          notice
            ? h('div', { className: notice.kind === 'error' ? 'dshpet_error' : 'dshpet_ok', role: 'status', style: { marginTop: '10px' } }, notice.text)
            : null,
        ),
        h(InstallPanel, { writable, version: changes, report: setNotice, onInstalled: installed, onImported: changed }),
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-codex-pets: dictionaries');

      const form = ctx.configForms.get('dsh-codex-pets');
      formRef.current = form;

      // A click on the pet's session list arrives here, even when this page
      // is not the one on screen: the host holds the request open until a
      // row is clicked, and opening the session is the workspace service.
      let uiWorkspace = null;
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['uiWorkspace'], (child) => {
            uiWorkspace = child.uiWorkspace ?? child.get?.('uiWorkspace') ?? null;
          });
        } catch { /* the service is looked up again at the moment of the click */ }
      }
      const openSession = (id) => {
        let ui = uiWorkspace;
        if (ui == null) {
          try {
            ui = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
          } catch {
            ui = null;
          }
        }
        if (ui != null && typeof ui.openSession === 'function') ui.openSession(id);
      };

      // The sidebar owns the settings dialog; invoke its command rather than
      // reaching into the DOM. The command opens whichever section was active
      // last, so pick this plugin's section from the navigation once it shows.
      let shortcuts = null;
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['shortcuts'], (child) => {
            shortcuts = child.shortcuts ?? child.get?.('shortcuts') ?? null;
          });
        } catch { /* looked up again when the menu item is chosen */ }
      }
      const openSettings = () => {
        const wanted = new Set([t('nav'), '宠物', 'Pet', '桌面宠物', 'Desktop pet']);
        const started = Date.now();
        let invoked = false;
        const pick = () => {
          const shell = document.querySelector('[data-shortcut-modal="settings"]');
          if (shell === null) {
            if (!invoked) {
              try {
                // invoke is on the registry, not the service the plugin receives.
                const registry = shortcuts?.registry;
                if (registry != null && typeof registry.invoke === 'function') {
                  registry.invoke('settings.open', { target: document.body, region: 'page', modal: null });
                  invoked = true;
                }
              } catch { /* try again on the next tick, while the service starts */ }
            }
          } else {
            const buttons = [...shell.querySelectorAll('nav button')];
            const labels = buttons.map((item) => (item.querySelector('[class*="navLabel"]')?.textContent ?? item.textContent ?? '').replace(/\s+/g, ' ').trim());
            const index = labels.findIndex((text) => wanted.has(text));
            if (index >= 0) {
              if (buttons[index].getAttribute('aria-current') !== 'true') buttons[index].click();
              return;
            }
            if (Date.now() - started > 1600) return;
          }
          if (Date.now() - started < 2000) setTimeout(pick, 50);
        };
        pick();
      };
      ctx.effect(() => {
        let stopped = false;
        let since = 0;
        const loop = async () => {
          while (!stopped) {
            try {
              const payload = await fetchJson(API.focus + '?since=' + String(since));
              if (stopped) return;
              if (typeof payload?.seq === 'number' && payload.seq > since) since = payload.seq;
              if (payload?.settings === true) openSettings();
              else if (typeof payload?.id === 'string' && payload.id !== '') openSession(payload.id);
            } catch {
              if (stopped) return;
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        };
        loop();
        return () => {
          stopped = true;
        };
      }, 'dsh-codex-pets: session focus');

      ctx.effect(
        () =>
          ctx.configForms.whileServed(['dsh-codex-pets'], () =>
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
        'dsh-codex-pets: settings section',
      );

      // The Plugins page lists every installed plugin; the pet's own page
      // carries the same picker, so it is reachable from both surfaces.
      ctx.slots.inject('plugins.item', () =>
        ctx.slots.register(
          {
            name: 'plugins.item',
            id: 'dsh-codex-pets',
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
