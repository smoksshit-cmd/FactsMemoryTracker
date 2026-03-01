/**
 * Facts Memory Tracker (FMT) — SillyTavern Extension
 * v1.2.0
 *
 * Новое в v1.2:
 *  - Inline-редактирование текста, категории, важности
 *  - Лимит токенов в инъекции + кастомный шаблон промпта
 *  - Авто-маркер [FACT: текст | категория] в ответах модели
 *  - Экспорт / Импорт JSON + кнопка «Скопировать»
 *  - Поиск по тексту факта
 *  - Сортировка (дата / важность / категория)
 *  - Счётчик токенов инжектируемого блока
 *  - История сканирований
 */

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const MODULE_KEY  = 'facts_memory_tracker';
  const PROMPT_TAG  = 'FMT_FACTS_MEMORY';
  const FAB_POS_KEY = 'fmt_fab_pos_v1';
  const FAB_MARGIN  = 8;

  const FACT_MARKER_RE = /\[FACT:\s*([^\]|]+?)(?:\|\s*(characters|events|secrets))?\s*\]/gi;

  const CATEGORIES = Object.freeze({
    characters: { label: 'Персонажи & Отношения', icon: '👤', short: 'ПЕРСОНАЖИ' },
    events:     { label: 'События & Последствия',  icon: '📅', short: 'СОБЫТИЯ'   },
    secrets:    { label: 'Секреты & Скрытое',       icon: '🔒', short: 'СЕКРЕТЫ'   },
  });

  const IMPORTANCE = Object.freeze({
    high:   { label: '🔴 Высокая', color: '#e55' },
    medium: { label: '🟡 Средняя', color: '#ca3' },
    low:    { label: '⚪ Низкая',  color: '#888' },
  });

  const SORT_MODES = Object.freeze({
    date:       'По дате',
    importance: 'По важности',
    category:   'По категории',
  });

  const EXT_PROMPT_TYPES = Object.freeze({ IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });

  const DEFAULT_PROMPT_TEMPLATE =
    `[ПАМЯТЬ ФАКТОВ]\nКлючевые факты о мире, персонажах и событиях этого RP:\n{{facts}}\n[/ПАМЯТЬ ФАКТОВ]`;

  const defaultSettings = Object.freeze({
    enabled:          true,
    showWidget:       true,
    autoScan:         true,
    autoScanEvery:    20,
    scanDepth:        40,
    injectImportance: 'medium',
    maxInjectFacts:   30,
    promptTemplate:   DEFAULT_PROMPT_TEMPLATE,
    position:         EXT_PROMPT_TYPES.IN_PROMPT,
    depth:            0,
    apiEndpoint:      '',
    apiKey:           '',
    apiModel:         'gpt-4o-mini',
    collapsed:        false,
    fabScale:         0.8,
    autoMarker:       true,
    sortMode:         'date',
  });

  // Runtime
  let lastFabDragTs    = 0;
  let scanInProgress   = false;
  let msgSinceLastScan = 0;
  const collapsedCats  = {};
  let searchQuery      = '';
  let currentSortMode  = 'date';

  // ─── ST context ───────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    return extensionSettings[MODULE_KEY];
  }

  // ─── Per-chat storage ─────────────────────────────────────────────────────────

  function chatKey() {
    const c = ctx();
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null) || c.chatId || 'unknown';
    const charId = c.characterId ?? c.groupId ?? 'unknown';
    return `fmt_v1__${charId}__${chatId}`;
  }

  async function getChatState() {
    const { chatMetadata, saveMetadata } = ctx();
    const key = chatKey();
    if (!chatMetadata[key]) {
      chatMetadata[key] = { facts: [], lastScannedMsgIndex: 0, scanLog: [] };
      await saveMetadata();
    }
    if (!chatMetadata[key].scanLog) chatMetadata[key].scanLog = [];
    return chatMetadata[key];
  }

  // ─── Utils ────────────────────────────────────────────────────────────────────

  function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function escHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function estimateTokens(text) { return Math.ceil((text || '').length / 4); }

  function getActiveCharName() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name)
        return c.characters[c.characterId].name;
      if (c.groupId !== undefined)
        return c.groups?.find?.(g => g.id === c.groupId)?.name ?? '{{char}}';
    } catch {}
    return '{{char}}';
  }

  function normText(s) {
    return s.toLowerCase().replace(/[^\wа-яёa-z0-9\s]/gi, '').replace(/\s+/g, ' ').trim();
  }

  function similarity(a, b) {
    const na = normText(a), nb = normText(b);
    if (na.includes(nb) || nb.includes(na)) return 1;
    const wa = new Set(na.split(' ').filter(w => w.length >= 3));
    const wb = new Set(nb.split(' ').filter(w => w.length >= 3));
    if (!wa.size && !wb.size) return na === nb ? 1 : 0;
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / Math.max(wa.size, wb.size);
  }

  // ─── Chat helpers ─────────────────────────────────────────────────────────────

  function getMessages(from, count) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return { text: '', lastIdx: 0 };
    const slice = chat.slice(Math.max(0, from), from + count);
    const text  = slice.map(m =>
      `${m.is_user ? '{{user}}' : (m.name || '{{char}}')}: ${(m.mes || '').trim()}`
    ).join('\n\n');
    return { text, lastIdx: from + slice.length };
  }

  function getCharacterCard() {
    const c = ctx();
    try {
      const char = c.characters?.[c.characterId];
      if (!char) return '';
      return [
        char.name        ? `Имя: ${char.name}`             : '',
        char.description ? `Описание: ${char.description}` : '',
        char.personality ? `Личность: ${char.personality}` : '',
        char.scenario    ? `Сценарий: ${char.scenario}`    : '',
      ].filter(Boolean).join('\n\n');
    } catch { return ''; }
  }

  // ─── API layer ────────────────────────────────────────────────────────────────

  function getBaseUrl() {
    return (getSettings().apiEndpoint || '').trim()
      .replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  }

  async function fetchModels() {
    const base   = getBaseUrl();
    const apiKey = (getSettings().apiKey || '').trim();
    if (!base || !apiKey) throw new Error('Укажи Endpoint и API Key');
    const resp = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.data || data.models || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean).sort();
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const s    = getSettings();
    const base = getBaseUrl();
    if (base && s.apiKey) {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({
          model: s.apiModel || 'gpt-4o-mini', max_tokens: 1024, temperature: 0.1,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        }),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`API ${resp.status}: ${err.slice(0, 200)}`);
      }
      const data = await resp.json();
      return data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
    }
    const c = ctx();
    if (typeof c.generateRaw === 'function')
      return await c.generateRaw(userPrompt, null, false, false, systemPrompt, true);
    throw new Error('Не задан API и нет generateRaw в SillyTavern');
  }

  // ─── Extraction ───────────────────────────────────────────────────────────────

  function buildSystemPrompt(existingFacts) {
    const existing = existingFacts.length
      ? `\nСУЩЕСТВУЮЩИЕ ФАКТЫ — НЕ ДУБЛИРОВАТЬ:\n${existingFacts.map(f => `- [${f.category}] ${f.text}`).join('\n')}\n`
      : '';
    return `Ты — аналитик RP-диалогов. Извлекай важные факты из переписки.

ЧТО ЯВЛЯЕТСЯ ФАКТОМ: имена/роли/черты персонажей, отношения, события с последствиями, скрытые мотивы, секреты, компромат, решения.
ЧТО НЕ ЯВЛЯЕТСЯ: атмосфера без сюжетного значения, действия без последствий, общие эмоции.

КАТЕГОРИИ: characters (персонажи, отношения, прошлое) | events (события, решения, последствия) | secrets (тайны, мотивы, компромат)
ВАЖНОСТЬ: high (ключевой факт) | medium (полезный контекст) | low (второстепенный)
Текст факта: до 15 слов, третье лицо.
Верни ТОЛЬКО валидный JSON-массив без преамбулы и markdown:
[{"category":"characters|events|secrets","text":"факт","importance":"high|medium|low"}]
Если нет новых фактов — верни [].${existing}`;
  }

  async function extractFacts(fromIdx, toIdx) {
    const state = await getChatState();
    const { text } = getMessages(fromIdx, toIdx - fromIdx);
    if (!text.trim()) return 0;

    const charCard = getCharacterCard();
    const system   = buildSystemPrompt(state.facts);
    const user     = `${charCard ? `КАРТОЧКА ПЕРСОНАЖА:\n${charCard}\n\n` : ''}━━━ СООБЩЕНИЯ ━━━\n${text}\n\nИзвлеки новые факты. Верни JSON-массив.`;

    const raw   = await aiGenerate(user, system);
    if (!raw) return 0;
    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return 0;

    const SIM_THRESHOLD = 0.40;
    const pool = state.facts.map(f => f.text);
    let added  = 0;

    for (const item of parsed) {
      if (!item.text || !item.category || !(item.category in CATEGORIES)) continue;
      if (!item.importance || !(item.importance in IMPORTANCE)) item.importance = 'medium';
      if (pool.some(ex => similarity(ex, item.text) >= SIM_THRESHOLD)) continue;
      state.facts.unshift({
        id: makeId(), category: item.category, text: item.text.trim(),
        importance: item.importance, msgIdx: toIdx, ts: Date.now(),
      });
      pool.push(item.text);
      added++;
    }
    state.lastScannedMsgIndex = toIdx;
    return added;
  }

  // ─── Auto-marker ──────────────────────────────────────────────────────────────

  async function detectFactMarkers(messageText) {
    const s = getSettings();
    if (!s.autoMarker || !messageText) return;
    const matches = [...messageText.matchAll(FACT_MARKER_RE)];
    if (!matches.length) return;

    const state = await getChatState();
    const pool  = state.facts.map(f => f.text);
    const SIM   = 0.40;
    let changed = false;

    for (const m of matches) {
      const text = m[1].trim();
      const cat  = (m[2] in CATEGORIES) ? m[2] : 'events';
      if (!text || pool.some(ex => similarity(ex, text) >= SIM)) continue;
      state.facts.unshift({ id: makeId(), category: cat, text, importance: 'medium', msgIdx: 0, ts: Date.now() });
      pool.push(text);
      changed = true;
      toastr.info(`🧠 Новый факт: «${text}»`, 'FMT Авто-маркер', { timeOut: 4000 });
    }

    if (changed) {
      await ctx().saveMetadata();
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();
    }
  }

  // ─── Scan ─────────────────────────────────────────────────────────────────────

  async function runScan(mode = 'manual') {
    if (scanInProgress) { toastr.warning('[FMT] Сканирование уже идёт…'); return; }
    const settings = getSettings();
    const { chat }  = ctx();
    if (!Array.isArray(chat) || !chat.length) { toastr.warning('[FMT] История чата пуста'); return; }

    scanInProgress = true;
    const $btn = $('#fmt_scan_btn, #fmt_scan_settings_btn');
    $btn.prop('disabled', true).text('⏳ Анализ…');

    try {
      const state   = await getChatState();
      const fromIdx = mode === 'auto'
        ? state.lastScannedMsgIndex
        : Math.max(0, chat.length - settings.scanDepth);
      const toIdx   = chat.length;

      if (fromIdx >= toIdx) {
        if (mode === 'manual') toastr.info('Новых сообщений для анализа нет', 'FMT');
        return;
      }

      const added = await extractFacts(fromIdx, toIdx);
      state.scanLog.unshift({ ts: Date.now(), added, from: fromIdx, to: toIdx, mode });
      if (state.scanLog.length > 20) state.scanLog.length = 20;

      await ctx().saveMetadata();
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();

      if (mode === 'manual') {
        if (added === 0) toastr.info('🔍 Новых фактов не найдено', 'FMT', { timeOut: 4000 });
        else toastr.success(`✅ Извлечено: <b>${added}</b> фактов`, 'FMT', { timeOut: 5000, escapeHtml: false });
      }
    } catch (e) {
      console.error('[FMT] scan failed', e);
      toastr.error(`[FMT] Ошибка: ${e.message}`);
    } finally {
      scanInProgress = false;
      $btn.prop('disabled', false).text('🔍 Сканировать');
    }
  }

  // ─── Injection ────────────────────────────────────────────────────────────────

  function buildInjectedBlock(state, settings) {
    const impOrder = { high: 2, medium: 1, low: 0 };
    const minScore = impOrder[settings.injectImportance || 'medium'] ?? 1;
    const maxFacts = settings.maxInjectFacts || 30;

    let filtered = state.facts.filter(f => !f.disabled && (impOrder[f.importance] ?? 0) >= minScore);
    filtered.sort((a, b) => (impOrder[b.importance] - impOrder[a.importance]) || (b.ts||0) - (a.ts||0));
    filtered = filtered.slice(0, maxFacts);
    if (!filtered.length) return '';

    const grouped = {};
    for (const cat of Object.keys(CATEGORIES)) grouped[cat] = [];
    for (const f of filtered) { if (grouped[f.category]) grouped[f.category].push(f.text); }

    const lines = Object.entries(CATEGORIES)
      .map(([key, meta]) => grouped[key].length ? `${meta.icon} ${meta.short}: ${grouped[key].join(' | ')}` : null)
      .filter(Boolean);

    if (!lines.length) return '';
    const tpl = settings.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    return tpl.replace('{{facts}}', lines.join('\n'));
  }

  async function updateInjectedPrompt() {
    const s = getSettings();
    const { setExtensionPrompt } = ctx();
    if (!s.enabled) { setExtensionPrompt(PROMPT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); return; }
    const state = await getChatState();
    setExtensionPrompt(PROMPT_TAG, buildInjectedBlock(state, s), s.position, s.depth, true);
  }

  // ─── FAB ─────────────────────────────────────────────────────────────────────

  function vpW() { return window.visualViewport?.width  || window.innerWidth; }
  function vpH() { return window.visualViewport?.height || window.innerHeight; }

  function getFabSize() {
    const scale = getSettings().fabScale ?? 0.8;
    return { W: Math.round(52 * scale) + 22, H: Math.round(48 * scale) + 6 };
  }

  function clampFabPos(left, top) {
    const { W, H } = getFabSize();
    return {
      left: clamp(left, FAB_MARGIN, Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN)),
      top:  clamp(top,  FAB_MARGIN, Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN)),
    };
  }

  function applyFabScale() {
    const btn = document.getElementById('fmt_fab_btn');
    if (!btn) return;
    const scale = getSettings().fabScale ?? 0.8;
    btn.style.transform      = `scale(${scale})`;
    btn.style.transformOrigin = 'top left';
    const fab = document.getElementById('fmt_fab');
    if (fab) {
      fab.style.width  = Math.round(52 * scale) + 'px';
      fab.style.height = Math.round(48 * scale) + 'px';
    }
  }

  function applyFabPosition() {
    const el = document.getElementById('fmt_fab');
    if (!el) return;
    el.style.transform = 'none';
    el.style.right = el.style.bottom = 'auto';
    const { W, H } = getFabSize();
    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) { setFabDefault(); return; }
      const pos = JSON.parse(raw);
      let left, top;
      if (typeof pos.x === 'number') {
        left = Math.round(pos.x * (vpW() - W - FAB_MARGIN * 2)) + FAB_MARGIN;
        top  = Math.round(pos.y * (vpH() - H - FAB_MARGIN * 2)) + FAB_MARGIN;
      } else if (typeof pos.left === 'number') {
        left = pos.left; top = pos.top;
      } else { setFabDefault(); return; }
      const c = clampFabPos(left, top);
      el.style.left = c.left + 'px';
      el.style.top  = c.top  + 'px';
    } catch { setFabDefault(); }
  }

  function saveFabPosPx(left, top) {
    const { W, H } = getFabSize();
    const c  = clampFabPos(left, top);
    const rx = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const ry = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x: clamp01((c.left - FAB_MARGIN) / rx), y: clamp01((c.top - FAB_MARGIN) / ry),
        left: c.left, top: c.top,
      }));
    } catch {}
  }

  function setFabDefault() {
    const el = document.getElementById('fmt_fab');
    if (!el) return;
    const { W, H } = getFabSize();
    const left = clamp(vpW() - W - FAB_MARGIN - 90, FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const top  = clamp(Math.round((vpH() - H) / 2) + 70, FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    saveFabPosPx(left, top);
  }

  function ensureFab() {
    if ($('#fmt_fab').length) return;
    $('body').append(`
      <div id="fmt_fab">
        <button type="button" id="fmt_fab_btn" title="Открыть трекер фактов">
          <div>🧠</div>
          <div class="fmt-mini"><span id="fmt_fab_count">0</span> фактов</div>
        </button>
        <button type="button" id="fmt_fab_hide" title="Скрыть виджет">✕</button>
      </div>
    `);
    $('#fmt_fab_btn').on('click', ev => {
      if (Date.now() - lastFabDragTs < 350) { ev.preventDefault(); return; }
      openDrawer(true);
    });
    $('#fmt_fab_hide').on('click', async () => {
      getSettings().showWidget = false;
      ctx().saveSettingsDebounced();
      await renderWidget();
      toastr.info('Виджет скрыт (включить в настройках расширения)');
    });
    initFabDrag();
    applyFabPosition();
    applyFabScale();
  }

  function initFabDrag() {
    const fab    = document.getElementById('fmt_fab');
    const handle = document.getElementById('fmt_fab_btn');
    if (!fab || !handle || fab.dataset.dragInit === '1') return;
    fab.dataset.dragInit = '1';

    let sx, sy, sl, st, moved = false;
    const THRESH = 6;

    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > THRESH) { moved = true; fab.classList.add('fmt-dragging'); }
      if (!moved) return;
      const p = clampFabPos(sl + dx, st + dy);
      fab.style.left = p.left + 'px'; fab.style.top = p.top + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = (ev) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) {
        saveFabPosPx(parseInt(fab.style.left) || 0, parseInt(fab.style.top) || 0);
        lastFabDragTs = Date.now();
      }
      moved = false; fab.classList.remove('fmt-dragging');
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const { W, H } = getFabSize();
      const curL = parseInt(fab.style.left) || (vpW() - W - FAB_MARGIN - 90);
      const curT = parseInt(fab.style.top)  || Math.round((vpH() - H) / 2);
      const p = clampFabPos(curL, curT);
      fab.style.left = p.left + 'px'; fab.style.top = p.top + 'px';
      fab.style.right = fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY; sl = p.left; st = p.top; moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onEnd, { passive: true });
      document.addEventListener('pointercancel', onEnd, { passive: true });
      ev.preventDefault();
    }, { passive: false });

    let resizeTimer = null;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyFabPosition, 200); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyFabPosition, 350); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  }

  async function renderWidget() {
    ensureFab();
    applyFabPosition();
    applyFabScale();
    const s = getSettings();
    if (!s.showWidget) { $('#fmt_fab').hide(); return; }
    const state  = await getChatState();
    const active = state.facts.filter(f => !f.disabled).length;
    $('#fmt_fab_count').text(active);
    $('#fmt_fab').show();
  }

  // ─── Drawer ───────────────────────────────────────────────────────────────────

  function ensureDrawer() {
    if ($('#fmt_drawer').length) return;
    $('body').append(`
      <aside id="fmt_drawer" aria-hidden="true">
        <header>
          <div class="topline">
            <div class="title">🧠 ПАМЯТЬ ФАКТОВ</div>
            <button type="button" id="fmt_close" style="pointer-events:auto">✕</button>
          </div>
          <div class="sub" id="fmt_subtitle"></div>
          <div class="fmt-token-bar" id="fmt_token_bar"></div>
        </header>

        <div class="fmt-toolbar">
          <input type="text" id="fmt_search" placeholder="🔍 Поиск по тексту…" autocomplete="off">
          <select id="fmt_sort_select">
            ${Object.entries(SORT_MODES).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </div>

        <div class="fmt-filters">
          <button class="fmt-filter-btn active" data-cat="all">Все</button>
          <button class="fmt-filter-btn" data-cat="characters">👤</button>
          <button class="fmt-filter-btn" data-cat="events">📅</button>
          <button class="fmt-filter-btn" data-cat="secrets">🔒</button>
          <span class="fmt-filter-sep">|</span>
          <button class="fmt-filter-btn" data-imp="high">🔴</button>
          <button class="fmt-filter-btn" data-imp="medium">🟡</button>
          <button class="fmt-filter-btn" data-imp="low">⚪</button>
        </div>

        <div class="content" id="fmt_content"></div>

        <div class="footer">
          <button type="button" id="fmt_scan_btn">🔍 Сканировать</button>
          <button type="button" id="fmt_export_btn">📤 Экспорт</button>
          <button type="button" id="fmt_import_btn">📥 Импорт</button>
          <button type="button" id="fmt_show_prompt_btn">Промпт</button>
          <button type="button" id="fmt_scanlog_btn">📋 Лог</button>
          <button type="button" id="fmt_clear_btn" title="Очистить все факты">🗑️</button>
          <button type="button" id="fmt_close2" style="pointer-events:auto">Закрыть</button>
        </div>
      </aside>
    `);

    document.getElementById('fmt_close').addEventListener('click',  () => openDrawer(false), true);
    document.getElementById('fmt_close2').addEventListener('click', () => openDrawer(false), true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('fmt_drawer')?.classList.contains('fmt-open'))
        openDrawer(false);
    });

    $(document)
      .off('click.fmt_actions')
      .on('click.fmt_actions', '#fmt_scan_btn',        () => runScan('manual'))
      .on('click.fmt_actions', '#fmt_show_prompt_btn', () => showPromptPreview())
      .on('click.fmt_actions', '#fmt_clear_btn',       () => clearAllFacts())
      .on('click.fmt_actions', '#fmt_export_btn',      () => exportJson())
      .on('click.fmt_actions', '#fmt_import_btn',      () => importJson())
      .on('click.fmt_actions', '#fmt_scanlog_btn',     () => showScanLog());

    // Filters — native getAttribute avoids jQuery .data() cache bug
    $(document).off('click.fmt_filter').on('click.fmt_filter', '.fmt-filter-btn', function () {
      const cat = this.getAttribute('data-cat');
      const imp = this.getAttribute('data-imp');
      if (cat !== null) {
        document.querySelectorAll('.fmt-filter-btn[data-cat]').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
      }
      if (imp !== null) this.classList.toggle('active');
      applyFiltersAndSearch();
    });

    $(document).off('input.fmt_search').on('input.fmt_search', '#fmt_search', function () {
      searchQuery = this.value.toLowerCase().trim();
      applyFiltersAndSearch();
    });

    $(document).off('change.fmt_sort').on('change.fmt_sort', '#fmt_sort_select', async function () {
      currentSortMode = this.value;
      getSettings().sortMode = currentSortMode;
      ctx().saveSettingsDebounced();
      await renderDrawer();
    });
  }

  // ─── Filters & search ─────────────────────────────────────────────────────────

  function applyFiltersAndSearch() {
    const catEl = document.querySelector('.fmt-filter-btn[data-cat].active');
    const cat   = catEl ? catEl.getAttribute('data-cat') : 'all';
    const imp   = [];
    document.querySelectorAll('.fmt-filter-btn[data-imp].active').forEach(el => imp.push(el.getAttribute('data-imp')));
    const q = searchQuery;

    document.querySelectorAll('.fmt-fact-row').forEach(el => {
      const elCat  = el.getAttribute('data-cat');
      const elImp  = el.getAttribute('data-imp');
      const elText = (el.getAttribute('data-text') || '').toLowerCase();
      const catOk  = cat === 'all' || elCat === cat;
      const impOk  = imp.length === 0 || imp.includes(elImp);
      const srchOk = !q || elText.includes(q);
      el.classList.toggle('fmt-row-hidden', !(catOk && impOk && srchOk));
    });

    document.querySelectorAll('.fmt-cat-section').forEach(sec => {
      const secCat = sec.getAttribute('data-cat');
      const catOk  = cat === 'all' || secCat === cat;
      const hasVis = sec.querySelectorAll('.fmt-fact-row:not(.fmt-row-hidden)').length > 0;
      sec.classList.toggle('fmt-row-hidden', !catOk || !hasVis);
    });
  }

  // ─── Open/close ───────────────────────────────────────────────────────────────

  function openDrawer(open) {
    ensureDrawer();
    const drawer = document.getElementById('fmt_drawer');
    if (!drawer) return;
    if (open) {
      if (!document.getElementById('fmt_overlay')) {
        const ov = document.createElement('div');
        ov.id = 'fmt_overlay';
        document.body.insertBefore(ov, drawer);
        ov.addEventListener('click', () => openDrawer(false), true);
      }
      document.getElementById('fmt_overlay').style.display = 'block';
      drawer.classList.add('fmt-open');
      drawer.setAttribute('aria-hidden', 'false');
      renderDrawer();
    } else {
      drawer.classList.remove('fmt-open');
      drawer.setAttribute('aria-hidden', 'true');
      const ov = document.getElementById('fmt_overlay');
      if (ov) ov.style.display = 'none';
    }
  }

  // ─── Sorting ──────────────────────────────────────────────────────────────────

  function sortFacts(facts) {
    const impOrder = { high: 2, medium: 1, low: 0 };
    const catOrder = { characters: 0, events: 1, secrets: 2 };
    const mode = currentSortMode || 'date';
    const copy = [...facts];
    if (mode === 'importance')
      copy.sort((a, b) => (impOrder[b.importance] - impOrder[a.importance]) || (b.ts||0) - (a.ts||0));
    else if (mode === 'category')
      copy.sort((a, b) => (catOrder[a.category]||0) - (catOrder[b.category]||0) || (b.ts||0) - (a.ts||0));
    else
      copy.sort((a, b) => (b.ts||0) - (a.ts||0));
    return copy;
  }

  // ─── Render row ───────────────────────────────────────────────────────────────

  function renderFactRow(fact) {
    const catMeta = CATEGORIES[fact.category] || CATEGORIES.events;
    const impMeta = IMPORTANCE[fact.importance] || IMPORTANCE.medium;
    const ts      = new Date(fact.ts || 0).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const dis     = !!fact.disabled;

    const catOpts = Object.entries(CATEGORIES)
      .map(([k,v]) => `<option value="${k}" ${k===fact.category?'selected':''}>${v.icon}</option>`).join('');
    const impOpts = Object.entries(IMPORTANCE)
      .map(([k,v]) => `<option value="${k}" ${k===fact.importance?'selected':''}>${v.label}</option>`).join('');

    return `
      <div class="fmt-fact-row${dis ? ' fmt-fact-disabled' : ''}"
           data-id="${fact.id}" data-cat="${fact.category}" data-imp="${fact.importance}"
           data-text="${escHtml(fact.text.toLowerCase())}">
        <select class="fmt-inline-cat" data-id="${fact.id}" title="Изменить категорию">${catOpts}</select>
        <span class="fmt-imp-dot" style="background:${impMeta.color}" title="${escHtml(impMeta.label)}"></span>
        <span class="fmt-fact-text" data-id="${fact.id}" title="Кликни для редактирования">${escHtml(fact.text)}</span>
        <span class="fmt-fact-date">${ts}</span>
        <select class="fmt-inline-imp" data-id="${fact.id}" title="Изменить важность">${impOpts}</select>
        <button class="fmt-toggle-btn" data-id="${fact.id}" title="${dis ? 'Включить' : 'Отключить'}">${dis ? '▶' : '⏸'}</button>
        <button class="fmt-delete-btn" data-id="${fact.id}" title="Удалить">✕</button>
      </div>`;
  }

  // ─── Render drawer ────────────────────────────────────────────────────────────

  async function renderDrawer() {
    ensureDrawer();
    const state    = await getChatState();
    const settings = getSettings();
    const charName = getActiveCharName();
    const total    = state.facts.length;
    const active   = state.facts.filter(f => !f.disabled).length;

    $('#fmt_subtitle').text(`${charName} · ${total} фактов · ${active} активных`);

    // Token counter
    const block  = buildInjectedBlock(state, settings);
    const tokens = estimateTokens(block);
    const maxF   = settings.maxInjectFacts || 30;
    $('#fmt_token_bar').html(
      block
        ? `<span class="fmt-tok-label">Инъекция: ~<b>${tokens}</b> токенов · ${active}/${maxF} фактов</span>`
        : `<span class="fmt-tok-label fmt-tok-empty">Инъекция пуста — нет активных фактов выше порога</span>`
    );

    // Sync sort
    currentSortMode = settings.sortMode || 'date';
    const $sortSel = $('#fmt_sort_select');
    if ($sortSel.length) $sortSel.val(currentSortMode);

    // Sort & group
    const sorted  = sortFacts(state.facts);
    const grouped = {};
    for (const cat of Object.keys(CATEGORIES)) grouped[cat] = [];
    for (const f of sorted) { if (grouped[f.category]) grouped[f.category].push(f); }

    let html = `
      <div class="fmt-add-block">
        <input type="text" id="fmt_add_text" placeholder="Добавить факт вручную…" maxlength="120">
        <select id="fmt_add_cat">
          ${Object.entries(CATEGORIES).map(([k,v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
        </select>
        <select id="fmt_add_imp">
          ${Object.entries(IMPORTANCE).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
        <button id="fmt_add_btn">+ Добавить</button>
      </div>`;

    if (total === 0) {
      html += `<div class="fmt-empty">Фактов нет. Нажмите <b>🔍 Сканировать</b> — AI извлечёт важное из истории.</div>`;
    } else {
      for (const [cat, meta] of Object.entries(CATEGORIES)) {
        const items = grouped[cat];
        if (!items.length) continue;
        const isColl  = !!collapsedCats[cat];
        const disabledN = items.filter(f => f.disabled).length;
        html += `
          <div class="fmt-cat-section" data-cat="${cat}">
            <div class="fmt-cat-header" data-collapse-cat="${cat}">
              <span class="fmt-cat-chevron">${isColl ? '▸' : '▾'}</span>
              ${meta.icon} ${meta.label}
              <span class="fmt-cat-count">${items.length}${disabledN ? ` <span class="fmt-cat-dis">${disabledN} откл.</span>` : ''}</span>
            </div>
            <div class="fmt-cat-body${isColl ? ' fmt-cat-collapsed' : ''}">
              ${items.map(f => renderFactRow(f)).join('')}
            </div>
          </div>`;
      }
    }

    $('#fmt_content').html(html);

    $('#fmt_add_btn').on('click', addFactManual);
    $('#fmt_add_text').on('keydown', e => { if (e.key === 'Enter') addFactManual(); });

    // Collapse
    $(document).off('click.fmt_collapse').on('click.fmt_collapse', '.fmt-cat-header', function () {
      const cat = this.getAttribute('data-collapse-cat');
      if (!cat) return;
      collapsedCats[cat] = !collapsedCats[cat];
      $(this).next('.fmt-cat-body').toggleClass('fmt-cat-collapsed', collapsedCats[cat]);
      $(this).find('.fmt-cat-chevron').text(collapsedCats[cat] ? '▸' : '▾');
    });

    // Inline text edit
    $(document).off('click.fmt_edit').on('click.fmt_edit', '.fmt-fact-text', function () {
      const id  = this.getAttribute('data-id');
      const cur = this.textContent;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = cur; inp.className = 'fmt-edit-input'; inp.maxLength = 120;
      $(this).replaceWith(inp);
      inp.focus(); inp.select();
      const save = async () => {
        const newText = inp.value.trim();
        if (newText && newText !== cur) await updateFactField(id, 'text', newText);
        else await renderDrawer();
      };
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = cur; inp.blur(); }
      });
    });

    // Inline selects
    $(document).off('change.fmt_inlinecat').on('change.fmt_inlinecat', '.fmt-inline-cat', async function () {
      await updateFactField(this.getAttribute('data-id'), 'category', this.value);
    });
    $(document).off('change.fmt_inlineimp').on('change.fmt_inlineimp', '.fmt-inline-imp', async function () {
      await updateFactField(this.getAttribute('data-id'), 'importance', this.value);
    });

    // Toggle
    $(document).off('click.fmt_toggle').on('click.fmt_toggle', '.fmt-toggle-btn', async function (e) {
      e.stopPropagation();
      await toggleDisableFact(this.getAttribute('data-id'));
    });

    // Delete
    $(document).off('click.fmt_delete').on('click.fmt_delete', '.fmt-delete-btn', async function (e) {
      e.stopPropagation();
      await deleteFact(this.getAttribute('data-id'));
    });

    applyFiltersAndSearch();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────────

  async function addFactManual() {
    const text       = String($('#fmt_add_text').val() ?? '').trim();
    const category   = String($('#fmt_add_cat').val() ?? 'events');
    const importance = String($('#fmt_add_imp').val() ?? 'medium');
    if (!text) { toastr.warning('Введите текст факта'); return; }
    const state = await getChatState();
    state.facts.unshift({ id: makeId(), category, text, importance, msgIdx: 0, ts: Date.now() });
    $('#fmt_add_text').val('');
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
  }

  async function updateFactField(id, field, value) {
    const state = await getChatState();
    const fact  = state.facts.find(f => f.id === id);
    if (!fact) return;
    fact[field] = value;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function toggleDisableFact(id) {
    const state = await getChatState();
    const fact  = state.facts.find(f => f.id === id);
    if (!fact) return;
    fact.disabled = !fact.disabled;
    // Patch DOM in-place
    const row = document.querySelector(`.fmt-fact-row[data-id="${id}"]`);
    if (row) {
      row.classList.toggle('fmt-fact-disabled', fact.disabled);
      const btn = row.querySelector('.fmt-toggle-btn');
      if (btn) { btn.textContent = fact.disabled ? '▶' : '⏸'; btn.title = fact.disabled ? 'Включить' : 'Отключить'; }
    }
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderWidget();
    // Refresh token bar only
    const block  = buildInjectedBlock(state, getSettings());
    const tokens = estimateTokens(block);
    const maxF   = getSettings().maxInjectFacts || 30;
    const active = state.facts.filter(f => !f.disabled).length;
    $('#fmt_token_bar').html(
      block
        ? `<span class="fmt-tok-label">Инъекция: ~<b>${tokens}</b> токенов · ${active}/${maxF} фактов</span>`
        : `<span class="fmt-tok-label fmt-tok-empty">Инъекция пуста</span>`
    );
  }

  async function deleteFact(id) {
    const state = await getChatState();
    const idx   = state.facts.findIndex(f => f.id === id);
    if (idx >= 0) state.facts.splice(idx, 1);
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
  }

  async function clearAllFacts() {
    const { Popup } = ctx();
    const ok = await Popup.show.confirm('Очистить все факты?', 'Действие нельзя отменить.');
    if (!ok) return;
    const state = await getChatState();
    state.facts = []; state.lastScannedMsgIndex = 0;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
    toastr.success('Все факты удалены');
  }

  // ─── Export / Import ──────────────────────────────────────────────────────────

  async function exportJson() {
    const state = await getChatState();
    const json  = JSON.stringify(state, null, 2);
    await ctx().Popup.show.text('FMT — Экспорт', `
      <div style="margin-bottom:8px">
        <button onclick="navigator.clipboard.writeText(document.getElementById('fmt_exp_ta').value).then(()=>toastr.success('Скопировано'))"
          class="menu_button" style="padding:5px 14px">📋 Скопировать</button>
      </div>
      <textarea id="fmt_exp_ta" style="width:100%;height:52vh;font-size:11px;font-family:Consolas,monospace;background:#0a1220;color:#c8deff;border:1px solid rgba(100,160,255,0.25);border-radius:8px;padding:8px;box-sizing:border-box" readonly>${escHtml(json)}</textarea>`);
  }

  async function importJson() {
    const { Popup, saveMetadata, chatMetadata } = ctx();
    const raw = await Popup.show.input('FMT — Импорт JSON', 'Вставьте JSON (экспорт из FMT):', '');
    if (!raw) return;
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object') throw new Error('Not an object');
      p.facts               = Array.isArray(p.facts)   ? p.facts   : [];
      p.lastScannedMsgIndex = p.lastScannedMsgIndex     || 0;
      p.scanLog             = Array.isArray(p.scanLog)  ? p.scanLog : [];
      chatMetadata[chatKey()] = p;
      await saveMetadata();
      await updateInjectedPrompt();
      await renderDrawer();
      await renderWidget();
      toastr.success(`Импортировано ${p.facts.length} фактов`);
    } catch (e) { toastr.error('[FMT] Неверный JSON: ' + e.message); }
  }

  // ─── Prompt preview ───────────────────────────────────────────────────────────

  async function showPromptPreview() {
    const state    = await getChatState();
    const settings = getSettings();
    const block    = buildInjectedBlock(state, settings) || '[Нет активных фактов выше порога]';
    const tokens   = estimateTokens(block);
    await ctx().Popup.show.text(
      `FMT — Промпт (~${tokens} токенов)`,
      `<pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow:auto;font-family:Consolas,monospace;background:#0a1220;color:#c8deff;padding:12px;border-radius:8px">${escHtml(block)}</pre>`
    );
  }

  // ─── Scan log ─────────────────────────────────────────────────────────────────

  async function showScanLog() {
    const state = await getChatState();
    const log   = state.scanLog || [];
    if (!log.length) { toastr.info('Лог сканирований пуст'); return; }
    const rows = log.map(e => {
      const d = new Date(e.ts).toLocaleString('ru-RU');
      return `<tr><td style="padding:4px 10px">${d}</td><td>${e.mode||'manual'}</td><td>${e.from}–${e.to}</td><td><b style="color:${e.added>0?'#70e8c0':'#888'}">${e.added}</b></td></tr>`;
    }).join('');
    await ctx().Popup.show.text('FMT — История сканирований', `
      <table style="width:100%;border-collapse:collapse;font-size:12px;color:#c8deff">
        <thead><tr style="color:#90b8f8;border-bottom:1px solid rgba(100,160,255,0.2)">
          <th style="padding:6px 10px;text-align:left">Время</th>
          <th>Режим</th><th>Сообщения</th><th>Добавлено</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  }

  // ─── Settings panel ───────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#fmt_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[FMT] settings container not found'); return; }

    const s = getSettings();
    currentSortMode = s.sortMode || 'date';

    $(target).append(`
      <div class="fmt-settings-block" id="fmt_settings_block">
        <div class="fmt-settings-title">
          <span>🧠 Трекер памяти фактов</span>
          <button type="button" id="fmt_collapse_btn">${s.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="fmt-settings-body"${s.collapsed ? ' style="display:none"' : ''}>

          <div class="fmt-srow">
            <label class="checkbox_label">
              <input type="checkbox" id="fmt_enabled" ${s.enabled ? 'checked' : ''}>
              <span>Инжектировать факты в промпт</span>
            </label>
          </div>
          <div class="fmt-srow">
            <label class="checkbox_label">
              <input type="checkbox" id="fmt_show_widget" ${s.showWidget ? 'checked' : ''}>
              <span>Показывать виджет 🧠</span>
            </label>
          </div>
          <div class="fmt-srow fmt-slider-row">
            <label>Размер виджета:</label>
            <input type="range" id="fmt_fab_scale" min="0.4" max="1.4" step="0.1" value="${s.fabScale ?? 0.8}">
            <span id="fmt_fab_scale_val">${Math.round((s.fabScale ?? 0.8) * 100)}%</span>
          </div>
          <div class="fmt-srow">
            <label class="checkbox_label">
              <input type="checkbox" id="fmt_auto_scan" ${s.autoScan ? 'checked' : ''}>
              <span>Авто-сканирование каждые N сообщений</span>
            </label>
          </div>
          <div class="fmt-srow">
            <label class="checkbox_label">
              <input type="checkbox" id="fmt_auto_marker" ${s.autoMarker ? 'checked' : ''}>
              <span>Авто-маркер <code>[FACT: текст | категория]</code></span>
            </label>
          </div>
          <div class="fmt-srow fmt-slider-row">
            <label>Авто-скан каждые:</label>
            <input type="range" id="fmt_auto_every" min="5" max="100" step="5" value="${s.autoScanEvery}">
            <span id="fmt_auto_every_val">${s.autoScanEvery}</span> сообщ.
          </div>
          <div class="fmt-srow fmt-slider-row">
            <label>Глубина скана:</label>
            <input type="range" id="fmt_scan_depth" min="10" max="200" step="10" value="${s.scanDepth}">
            <span id="fmt_scan_depth_val">${s.scanDepth}</span> сообщ.
          </div>
          <div class="fmt-srow">
            <label>Инжектировать ≥</label>
            <select id="fmt_inject_imp">
              <option value="low"    ${s.injectImportance==='low'    ?'selected':''}>⚪ Все</option>
              <option value="medium" ${s.injectImportance==='medium' ?'selected':''}>🟡 Medium+</option>
              <option value="high"   ${s.injectImportance==='high'   ?'selected':''}>🔴 Только High</option>
            </select>
          </div>
          <div class="fmt-srow fmt-slider-row">
            <label>Макс. фактов в инъекции:</label>
            <input type="range" id="fmt_max_facts" min="5" max="100" step="5" value="${s.maxInjectFacts || 30}">
            <span id="fmt_max_facts_val">${s.maxInjectFacts || 30}</span>
          </div>

          <div class="fmt-api-section">
            <div class="fmt-api-title">📝 Шаблон промпта</div>
            <div class="fmt-api-hint">Используй <code>{{facts}}</code> как плейсхолдер для строк фактов.</div>
            <textarea id="fmt_prompt_tpl" rows="4">${escHtml(s.promptTemplate || DEFAULT_PROMPT_TEMPLATE)}</textarea>
            <button class="menu_button" id="fmt_reset_tpl_btn" style="margin-top:4px;padding:4px 10px;font-size:11px">↩ Сбросить</button>
          </div>

          <div class="fmt-api-section">
            <div class="fmt-api-title">⚙️ API для сканирования</div>
            <div class="fmt-api-hint">Оставь пустым — используется встроенный ST generateRaw.</div>
            <label class="fmt-api-label">Endpoint</label>
            <div class="fmt-srow">
              <input type="text" id="fmt_api_endpoint" class="fmt-api-field" placeholder="https://api.openai.com/v1" value="${escHtml(s.apiEndpoint || '')}">
            </div>
            <label class="fmt-api-label">API Key</label>
            <div class="fmt-srow" style="gap:6px">
              <input type="password" id="fmt_api_key" class="fmt-api-field" placeholder="sk-..." value="${s.apiKey || ''}">
              <button type="button" id="fmt_api_key_toggle" class="menu_button" style="padding:5px 10px">👁</button>
            </div>
            <label class="fmt-api-label">Модель</label>
            <div class="fmt-srow" style="gap:6px">
              <select id="fmt_api_model" class="fmt-api-select" style="flex:1">
                ${s.apiModel ? `<option value="${escHtml(s.apiModel)}" selected>${escHtml(s.apiModel)}</option>` : '<option value="">-- нажми 🔄 --</option>'}
              </select>
              <button type="button" id="fmt_refresh_models" class="menu_button" style="padding:5px 10px" title="Загрузить модели">🔄</button>
            </div>
          </div>

          <div class="fmt-srow fmt-btn-row">
            <button class="menu_button" id="fmt_open_drawer_btn">Открыть трекер</button>
            <button class="menu_button" id="fmt_scan_settings_btn">🔍 Сканировать</button>
            <button class="menu_button" id="fmt_reset_pos_btn">Сбросить позицию</button>
          </div>

          <div class="fmt-hint">
            <b>Как работает:</b><br>
            🔍 <b>Сканировать</b> — AI анализирует историю, извлекает факты без дублей.<br>
            ⚡ <b>Авто-скан</b> — каждые N сообщений автоматически.<br>
            🏷️ <b>[FACT: текст | категория]</b> — маркер в ответе модели = мгновенное добавление.<br>
            ✏️ <b>Редактирование</b> — кликни на текст факта в трекере.<br>
            ⏸ <b>Отключить</b> — факт хранится, но не инжектируется.<br>
            💾 <b>Инъекция</b> — только нужные факты, экономия токенов.
          </div>
        </div>
      </div>
    `);

    // Collapse
    $('#fmt_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#fmt_settings_block .fmt-settings-body').toggle(!s.collapsed);
      $('#fmt_collapse_btn').text(s.collapsed ? '▸' : '▾');
      ctx().saveSettingsDebounced();
    });

    // Checkboxes
    $('#fmt_enabled').on('input',    async ev => { s.enabled    = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });
    $('#fmt_show_widget').on('input',async ev => { s.showWidget = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await renderWidget(); });
    $('#fmt_auto_scan').on('input',       ev => { s.autoScan   = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#fmt_auto_marker').on('input',     ev => { s.autoMarker = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });

    // FAB scale
    $('#fmt_fab_scale').on('input', ev => {
      const v = parseFloat($(ev.currentTarget).val());
      s.fabScale = v;
      $('#fmt_fab_scale_val').text(Math.round(v * 100) + '%');
      ctx().saveSettingsDebounced();
      applyFabScale();
      applyFabPosition();
    });

    // Sliders
    $('#fmt_auto_every').on('input', ev => { const v = +$(ev.currentTarget).val(); s.autoScanEvery  = v; $('#fmt_auto_every_val').text(v);  ctx().saveSettingsDebounced(); });
    $('#fmt_scan_depth').on('input', ev => { const v = +$(ev.currentTarget).val(); s.scanDepth      = v; $('#fmt_scan_depth_val').text(v);  ctx().saveSettingsDebounced(); });
    $('#fmt_max_facts').on('input',  ev => { const v = +$(ev.currentTarget).val(); s.maxInjectFacts = v; $('#fmt_max_facts_val').text(v);   ctx().saveSettingsDebounced(); });

    // Select
    $('#fmt_inject_imp').on('change', async ev => { s.injectImportance = $(ev.currentTarget).val(); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });

    // Template
    $('#fmt_prompt_tpl').on('input', () => { s.promptTemplate = $('#fmt_prompt_tpl').val(); ctx().saveSettingsDebounced(); });
    $('#fmt_reset_tpl_btn').on('click', async () => {
      s.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
      $('#fmt_prompt_tpl').val(DEFAULT_PROMPT_TEMPLATE);
      ctx().saveSettingsDebounced();
      await updateInjectedPrompt();
      toastr.success('Шаблон сброшен');
    });

    // API
    $('#fmt_api_endpoint').on('input', () => { s.apiEndpoint = $('#fmt_api_endpoint').val().trim(); ctx().saveSettingsDebounced(); });
    $('#fmt_api_key').on('input',      () => { s.apiKey      = $('#fmt_api_key').val().trim();      ctx().saveSettingsDebounced(); });
    $('#fmt_api_key_toggle').on('click', () => {
      const inp = document.getElementById('fmt_api_key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#fmt_api_model').on('change', () => { s.apiModel = $('#fmt_api_model').val(); ctx().saveSettingsDebounced(); });
    $('#fmt_refresh_models').on('click', async () => {
      const $btn = $('#fmt_refresh_models');
      $btn.prop('disabled', true).text('⏳');
      try {
        const models  = await fetchModels();
        const current = s.apiModel || '';
        const $sel    = $('#fmt_api_model');
        $sel.html('<option value="">-- выбери модель --</option>');
        models.forEach(id => $sel.append(new Option(id, id, id === current, id === current)));
        toastr.success(`Загружено: ${models.length} моделей`);
      } catch (e) { toastr.error(`[FMT] ${e.message}`); }
      finally { $btn.prop('disabled', false).text('🔄'); }
    });

    $(document)
      .off('click.fmt_settings')
      .on('click.fmt_settings', '#fmt_open_drawer_btn',  () => openDrawer(true))
      .on('click.fmt_settings', '#fmt_scan_settings_btn',() => runScan('manual'))
      .on('click.fmt_settings', '#fmt_reset_pos_btn', () => {
        try { localStorage.removeItem(FAB_POS_KEY); } catch {}
        setFabDefault(); toastr.success('Позиция сброшена');
      });
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab(); applyFabPosition(); applyFabScale(); ensureDrawer();
      await mountSettingsUi();
      await updateInjectedPrompt();
      await renderWidget();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      msgSinceLastScan = 0;
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async (idx) => {
      const { chat } = ctx();
      const msg = chat?.[idx];
      if (msg && !msg.is_user) await detectFactMarkers(msg.mes || '');
      await renderWidget();
      const s = getSettings();
      if (!s.autoScan) return;
      msgSinceLastScan++;
      if (msgSinceLastScan >= s.autoScanEvery) { msgSinceLastScan = 0; await runScan('auto'); }
    });

    eventSource.on(event_types.MESSAGE_SENT, async () => { await renderWidget(); });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try { wireChatEvents(); console.log('[FMT] v1.2.0 loaded'); }
    catch (e) { console.error('[FMT] init failed', e); }
  });

})();
