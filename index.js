/**
 * Facts Memory Tracker (FMT) — SillyTavern Extension
 * v1.0.0
 *
 * Автоматически извлекает важные факты из чата и хранит их компактно,
 * чтобы инжектировать в промпт вместо тяжёлой истории.
 *
 * Категории: 👤 Персонажи & Отношения | 📅 События & Последствия | 🔒 Секреты
 */

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const MODULE_KEY  = 'facts_memory_tracker';
  const PROMPT_TAG  = 'FMT_FACTS_MEMORY';
  const FAB_POS_KEY = 'fmt_fab_pos_v1';
  const FAB_MARGIN  = 8;

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

  const EXT_PROMPT_TYPES = Object.freeze({
    IN_PROMPT:     0,
    IN_CHAT:       1,
    BEFORE_PROMPT: 2,
  });

  const defaultSettings = Object.freeze({
    enabled:          true,
    showWidget:       true,
    autoScan:         true,
    autoScanEvery:    20,
    scanDepth:        40,
    injectImportance: 'medium',
    position:         EXT_PROMPT_TYPES.IN_PROMPT,
    depth:            0,
    apiEndpoint:      '',
    apiKey:           '',
    apiModel:         'gpt-4o-mini',
    collapsed:        false,
    fabScale:         0.8,   // масштаб FAB (0.5 – 1.4)
  });

  // Состояние свёрнутых категорий (не персистится — сбрасывается при открытии)
  const collapsedCats = {};

  let lastFabDragTs  = 0;
  let scanInProgress = false;
  let msgSinceLastScan = 0;   // счётчик сообщений с последнего авто-скана

  // ─── ST context helpers ───────────────────────────────────────────────────────

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
      chatMetadata[key] = { facts: [], lastScannedMsgIndex: 0 };
      await saveMetadata();
    }
    return chatMetadata[key];
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

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

  // Нормализация для дедупликации
  function normText(s) {
    return s.toLowerCase()
      .replace(/[^\wа-яёa-z0-9\s]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
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

  // ─── Chat history ─────────────────────────────────────────────────────────────

  function getMessages(from = 0, count = 40) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return { text: '', lastIdx: 0 };
    const slice = count > 0 ? chat.slice(Math.max(0, from), from + count) : chat.slice(from);
    const text = slice.map(m => {
      const who = m.is_user ? '{{user}}' : (m.name || '{{char}}');
      return `${who}: ${(m.mes || '').trim()}`;
    }).join('\n\n');
    return { text, lastIdx: from + slice.length };
  }

  function getCharacterCard() {
    const c = ctx();
    try {
      const char = c.characters?.[c.characterId];
      if (!char) return '';
      return [
        char.name        ? `Имя: ${char.name}`           : '',
        char.description ? `Описание: ${char.description}` : '',
        char.personality ? `Личность: ${char.personality}`  : '',
        char.scenario    ? `Сценарий: ${char.scenario}`     : '',
      ].filter(Boolean).join('\n\n');
    } catch { return ''; }
  }

  // ─── API layer ────────────────────────────────────────────────────────────────

  function getBaseUrl() {
    const s = getSettings();
    return (s.apiEndpoint || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/v1$/, '');
  }

  async function fetchModels() {
    const base   = getBaseUrl();
    const apiKey = (getSettings().apiKey || '').trim();
    if (!base || !apiKey) throw new Error('Укажи Endpoint и API Key');
    const resp = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.data || data.models || [])
      .map(m => (typeof m === 'string' ? m : m.id))
      .filter(Boolean).sort();
  }

  async function aiGenerate(userPrompt, systemPrompt) {
    const s    = getSettings();
    const base = getBaseUrl();

    if (base && s.apiKey) {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify({
          model:       s.apiModel || 'gpt-4o-mini',
          max_tokens:  1024,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
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
    if (typeof c.generateRaw === 'function') {
      return await c.generateRaw(userPrompt, null, false, false, systemPrompt, true);
    }
    throw new Error('Не задан API и нет generateRaw в SillyTavern');
  }

  // ─── Extraction prompt ────────────────────────────────────────────────────────

  /*
   * СТРУКТУРА ПРОМПТА ЭКСТРАКЦИИ:
   *
   * SYSTEM:
   *   — Роль: аналитик RP-диалогов, задача — факты, а не пересказ
   *   — Что извлекать: конкретные факты, имена, отношения, события, тайны
   *   — Что НЕ извлекать: общие описания, экшн без последствий, флёр
   *   — Формат: JSON-массив [{category, text, importance}], или []
   *   — Текст факта: ≤15 слов, третье лицо, без воды
   *   — Список существующих фактов — не дублировать
   *
   * USER:
   *   — Карточка персонажа (опц.)
   *   — Существующие факты по категориям (для дедупа)
   *   — Новые сообщения для анализа
   */

  function buildExtractionPrompt(chatText, existingFacts, charCard) {
    const existingBlock = existingFacts.length
      ? `\nСУЩЕСТВУЮЩИЕ ФАКТЫ — НЕ ДУБЛИРОВАТЬ (даже другими словами):\n${existingFacts.map(f => `- [${f.category}] ${f.text}`).join('\n')}\n`
      : '';

    const cardBlock = charCard
      ? `\nКАРТОЧКА ПЕРСОНАЖА:\n${charCard}\n`
      : '';

    const system = `Ты — аналитик RP-диалогов. Твоя задача: извлечь ТОЛЬКО важные факты из переписки.

ЧТО ЯВЛЯЕТСЯ ФАКТОМ:
- Имена, роли, профессии, физические черты персонажей
- Отношения между персонажами (друзья/враги/влюблённые/родственники)
- Конкретные события с последствиями (встреча, конфликт, договор, предательство)
- Информация которую один персонаж узнаёт о другом
- Скрытые мотивы, секреты, тайные знания, компромат
- Важные решения и их последствия

ЧТО НЕ ЯВЛЯЕТСЯ ФАКТОМ:
- Описания атмосферы/обстановки без сюжетного значения
- Действия без последствий (пошли куда-то, сделали что-то обычное)
- Эмоции без конкретики («было грустно», «стало лучше»)
- Дублирование уже известного

КАТЕГОРИИ:
- characters — персонажи, их черты, отношения, прошлое
- events     — произошедшие события, решения, последствия
- secrets    — скрытая информация, тайны, компромат, нераскрытые мотивы

ВАЖНОСТЬ:
- high   — ключевой для понимания сюжета, меняет отношения/расстановку
- medium — полезный контекст, помогает RP
- low    — второстепенный, упоминается мимоходом

ПРАВИЛА:
- Текст факта: до 15 слов, третье лицо, конкретно
- Верни ТОЛЬКО валидный JSON-массив, без преамбулы, без markdown
- Если новых фактов нет — верни []

Формат: [{"category":"characters|events|secrets","text":"факт","importance":"high|medium|low"}]${existingBlock}`;

    const user = `${cardBlock}
━━━ НОВЫЕ СООБЩЕНИЯ ДЛЯ АНАЛИЗА ━━━
${chatText}

Извлеки все новые важные факты. Верни JSON-массив.`;

    return { system, user };
  }

  // ─── Core: scan and extract ───────────────────────────────────────────────────

  async function extractFacts(fromIdx, toIdx) {
    const state      = await getChatState();
    const settings   = getSettings();
    const count      = toIdx - fromIdx;
    const { text }   = getMessages(fromIdx, count);

    if (!text.trim()) return 0;

    const charCard = getCharacterCard();
    const { system, user } = buildExtractionPrompt(text, state.facts, charCard);

    const raw = await aiGenerate(user, system);
    if (!raw) return 0;

    const clean = raw.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return 0;

    // Fuzzy dedup — порог 40%
    const SIM_THRESHOLD = 0.40;
    const pool = state.facts.map(f => f.text);

    let added = 0;
    for (const item of parsed) {
      if (!item.text || !item.category || !(item.category in CATEGORIES)) continue;
      if (!item.importance || !(item.importance in IMPORTANCE)) item.importance = 'medium';

      const isDup = pool.some(ex => similarity(ex, item.text) >= SIM_THRESHOLD);
      if (isDup) continue;

      state.facts.unshift({
        id:         makeId(),
        category:   item.category,
        text:       item.text.trim(),
        importance: item.importance,
        msgIdx:     toIdx,
        ts:         Date.now(),
      });
      pool.push(item.text);
      added++;
    }

    state.lastScannedMsgIndex = toIdx;
    await ctx().saveMetadata();
    return added;
  }

  async function runScan(mode = 'manual') {
    if (scanInProgress) { toastr.warning('[FMT] Сканирование уже идёт…'); return; }

    const settings = getSettings();
    const { chat }  = ctx();
    if (!Array.isArray(chat) || !chat.length) {
      toastr.warning('[FMT] История чата пуста');
      return;
    }

    scanInProgress = true;
    const $btn = mode === 'manual' ? $('#fmt_scan_btn, #fmt_scan_settings_btn') : null;
    $btn?.prop('disabled', true).text('⏳ Анализ…');

    try {
      const state   = await getChatState();
      let fromIdx   = mode === 'auto' ? state.lastScannedMsgIndex : Math.max(0, chat.length - settings.scanDepth);
      let toIdx     = chat.length;

      if (fromIdx >= toIdx) {
        if (mode === 'manual') toastr.info('Новых сообщений для анализа нет', 'FMT');
        return;
      }

      const added = await extractFacts(fromIdx, toIdx);

      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();

      if (mode === 'manual') {
        if (added === 0)
          toastr.info('🔍 Новых фактов не найдено', 'FMT', { timeOut: 4000 });
        else
          toastr.success(`✅ Извлечено новых фактов: <b>${added}</b>`, 'FMT', { timeOut: 5000, escapeHtml: false });
      }
    } catch (e) {
      console.error('[FMT] scan failed', e);
      toastr.error(`[FMT] Ошибка: ${e.message}`);
    } finally {
      scanInProgress = false;
      $btn?.prop('disabled', false).text('🔍 Сканировать чат');
    }
  }

  // ─── Prompt injection ─────────────────────────────────────────────────────────

  function buildInjectedBlock(state, settings) {
    const threshold = settings.injectImportance || 'medium';
    const importanceOrder = { high: 2, medium: 1, low: 0 };
    const minScore = importanceOrder[threshold] ?? 1;

    const filtered = state.facts.filter(f => !f.disabled && (importanceOrder[f.importance] ?? 0) >= minScore);
    if (!filtered.length) return '';

    const grouped = {};
    for (const cat of Object.keys(CATEGORIES)) grouped[cat] = [];
    for (const f of filtered) {
      if (grouped[f.category]) grouped[f.category].push(f.text);
    }

    const lines = Object.entries(CATEGORIES)
      .map(([key, meta]) => {
        const items = grouped[key];
        if (!items.length) return null;
        return `${meta.icon} ${meta.short}: ${items.join(' | ')}`;
      })
      .filter(Boolean);

    if (!lines.length) return '';

    return `[ПАМЯТЬ ФАКТОВ]
Ключевые факты о мире, персонажах и событиях этого RP:
${lines.join('\n')}
[/ПАМЯТЬ ФАКТОВ]`;
  }

  async function updateInjectedPrompt() {
    const s = getSettings();
    const { setExtensionPrompt } = ctx();
    if (!s.enabled) {
      setExtensionPrompt(PROMPT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      return;
    }
    const state = await getChatState();
    const block = buildInjectedBlock(state, s);
    setExtensionPrompt(PROMPT_TAG, block, s.position, s.depth, true);
  }

  // ─── FAB ─────────────────────────────────────────────────────────────────────

  function vpW() { return window.visualViewport?.width  || window.innerWidth;  }
  function vpH() { return window.visualViewport?.height || window.innerHeight; }

  function getFabSize() {
    const el = document.getElementById('fmt_fab');
    if (el?.offsetWidth > 0) return { W: el.offsetWidth, H: el.offsetHeight };
    const w = vpW();
    if (w <= 480)  return { W: 60, H: 58 };
    if (w <= 1024) return { W: 66, H: 62 };
    return { W: 64, H: 58 };
  }

  function clampFabPos(left, top) {
    const { W, H } = getFabSize();
    return {
      left: clamp(left, FAB_MARGIN, Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN)),
      top:  clamp(top,  FAB_MARGIN, Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN)),
    };
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
    const c = clampFabPos(left, top);
    const rx = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const ry = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x: clamp01((c.left - FAB_MARGIN) / rx),
        y: clamp01((c.top  - FAB_MARGIN) / ry),
        left: c.left, top: c.top,
      }));
    } catch {}
  }

  function setFabDefault() {
    const el = document.getElementById('fmt_fab');
    if (!el) return;
    const { W, H } = getFabSize();
    const left = clamp(vpW() - W - FAB_MARGIN - 80, FAB_MARGIN, vpW() - W - FAB_MARGIN); // чуть левее SRT
    const top  = clamp(Math.round((vpH() - H) / 2) + 70, FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
    saveFabPosPx(left, top);
  }

  function applyFabScale() {
    const el = document.getElementById('fmt_fab_btn');
    if (!el) return;
    const scale = getSettings().fabScale ?? 0.8;
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = 'center center';
    // Подгоняем wrapper под реальный визуальный размер
    const fab = document.getElementById('fmt_fab');
    if (fab) fab.style.setProperty('--fab-scale', scale);
  }


  function ensureFab() {
    if ($('#fmt_fab').length) return;
    $('body').append(`
      <div id="fmt_fab">
        <button type="button" id="fmt_fab_btn" title="Открыть трекер фактов">
          <div>🧠</div>
          <div class="fmt-mini">
            <span id="fmt_fab_count">0</span> фактов
          </div>
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
      fab.style.left = p.left + 'px';
      fab.style.top  = p.top  + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = (ev) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup',   onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) { saveFabPosPx(parseInt(fab.style.left) || 0, parseInt(fab.style.top) || 0); lastFabDragTs = Date.now(); }
      moved = false;
      fab.classList.remove('fmt-dragging');
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const { W, H } = getFabSize();
      const curL = parseInt(fab.style.left) || (vpW() - W - FAB_MARGIN - 80);
      const curT = parseInt(fab.style.top)  || Math.round((vpH() - H) / 2);
      const p = clampFabPos(curL, curT);
      fab.style.left = p.left + 'px';
      fab.style.top  = p.top  + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY;
      sl = p.left; st = p.top;
      moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup',   onEnd,  { passive: true });
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
    const state = await getChatState();
    $('#fmt_fab_count').text(state.facts.length);
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
        </header>

        <div class="fmt-filters" id="fmt_filters">
          <button class="fmt-filter-btn active" data-cat="all">Все</button>
          <button class="fmt-filter-btn" data-cat="characters">👤</button>
          <button class="fmt-filter-btn" data-cat="events">📅</button>
          <button class="fmt-filter-btn" data-cat="secrets">🔒</button>
          <button class="fmt-filter-btn fmt-imp-btn" data-imp="high">🔴</button>
          <button class="fmt-filter-btn fmt-imp-btn" data-imp="medium">🟡</button>
          <button class="fmt-filter-btn fmt-imp-btn" data-imp="low">⚪</button>
        </div>

        <div class="content" id="fmt_content"></div>

        <div class="footer">
          <button type="button" id="fmt_scan_btn">🔍 Сканировать чат</button>
          <button type="button" id="fmt_show_prompt_btn">Промпт</button>
          <button type="button" id="fmt_clear_btn">🗑️ Очистить всё</button>
          <button type="button" id="fmt_close2" style="pointer-events:auto">Закрыть</button>
        </div>
      </aside>
    `);

    document.getElementById('fmt_close').addEventListener('click',  () => openDrawer(false), true);
    document.getElementById('fmt_close2').addEventListener('click', () => openDrawer(false), true);

    $(document)
      .off('click.fmt_actions')
      .on('click.fmt_actions', '#fmt_scan_btn',       () => runScan('manual'))
      .on('click.fmt_actions', '#fmt_show_prompt_btn',() => showPromptPreview())
      .on('click.fmt_actions', '#fmt_clear_btn',      () => clearAllFacts());

    // Фильтры
    $(document).on('click.fmt_filter', '.fmt-filter-btn', function () {
      const btn  = $(this);
      const cat  = btn.data('cat');
      const imp  = btn.data('imp');

      if (cat !== undefined) {
        $('.fmt-filter-btn[data-cat]').removeClass('active');
        btn.addClass('active');
      }
      if (imp !== undefined) {
        btn.toggleClass('active');
      }

      applyFilters();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('fmt_drawer')?.classList.contains('fmt-open'))
        openDrawer(false);
    });
  }

  function activeFilters() {
    const catEl = document.querySelector('.fmt-filter-btn[data-cat].active');
    const cat   = catEl ? catEl.getAttribute('data-cat') : 'all';
    const imp   = [];
    document.querySelectorAll('.fmt-filter-btn[data-imp].active').forEach(el => imp.push(el.getAttribute('data-imp')));
    return { cat, imp };
  }

  function applyFilters() {
    const { cat, imp } = activeFilters();
    document.querySelectorAll('.fmt-fact-row').forEach(el => {
      const elCat = el.getAttribute('data-cat');
      const elImp = el.getAttribute('data-imp');
      const catOk = cat === 'all' || elCat === cat;
      const impOk = imp.length === 0 || imp.includes(elImp);
      el.classList.toggle('fmt-row-hidden', !(catOk && impOk));
    });
    // Показываем/скрываем секции категорий
    document.querySelectorAll('.fmt-cat-section').forEach(sec => {
      const secCat = sec.getAttribute('data-cat');
      const catOk  = cat === 'all' || secCat === cat;
      const hasVisible = sec.querySelectorAll('.fmt-fact-row:not(.fmt-row-hidden)').length > 0;
      sec.classList.toggle('fmt-row-hidden', !catOk || !hasVisible);
    });
  }

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

  function renderFactRow(fact) {
    const catMeta  = CATEGORIES[fact.category] || CATEGORIES.events;
    const impMeta  = IMPORTANCE[fact.importance] || IMPORTANCE.medium;
    const ts       = new Date(fact.ts || 0).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const disabled = !!fact.disabled;
    return `
      <div class="fmt-fact-row${disabled ? ' fmt-fact-disabled' : ''}"
           data-id="${fact.id}" data-cat="${fact.category}" data-imp="${fact.importance}">
        <span class="fmt-cat-icon" title="${escapeHtml(catMeta.label)}">${catMeta.icon}</span>
        <span class="fmt-imp-dot" title="${escapeHtml(impMeta.label)}" style="background:${impMeta.color}"></span>
        <span class="fmt-fact-text">${escapeHtml(fact.text)}</span>
        <span class="fmt-fact-date">${ts}</span>
        <button class="fmt-toggle-btn" data-id="${fact.id}" title="${disabled ? 'Включить факт' : 'Отключить факт (не инжектировать)'}">${disabled ? '▶' : '⏸'}</button>
        <button class="fmt-delete-btn" data-id="${fact.id}" title="Удалить">✕</button>
      </div>`;
  }

  async function renderDrawer() {
    ensureDrawer();
    const state    = await getChatState();
    const settings = getSettings();
    const charName = getActiveCharName();
    const total    = state.facts.length;
    const active   = state.facts.filter(f => !f.disabled).length;

    $('#fmt_subtitle').text(`${charName} · ${total} фактов (${active} активных) · авто-скан каждые ${settings.autoScanEvery} сообщ.`);

    const grouped = {};
    for (const cat of Object.keys(CATEGORIES)) grouped[cat] = [];
    for (const f of state.facts) { if (grouped[f.category]) grouped[f.category].push(f); }

    let html = `
      <div class="fmt-add-block">
        <input type="text" id="fmt_add_text" placeholder="Добавить факт вручную…" maxlength="120">
        <select id="fmt_add_cat">
          ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
        </select>
        <select id="fmt_add_imp">
          ${Object.entries(IMPORTANCE).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
        </select>
        <button id="fmt_add_btn">+ Добавить</button>
      </div>`;

    if (total === 0) {
      html += `<div class="fmt-empty">Фактов нет. Нажмите <b>🔍 Сканировать чат</b> — AI сам извлечёт важное из истории переписки.</div>`;
    } else {
      for (const [cat, meta] of Object.entries(CATEGORIES)) {
        const items = grouped[cat];
        if (!items.length) continue;
        const isCollapsed = !!collapsedCats[cat];
        const disabledInCat = items.filter(f => f.disabled).length;
        html += `
          <div class="fmt-cat-section" data-cat="${cat}">
            <div class="fmt-cat-header" data-collapse-cat="${cat}">
              <span class="fmt-cat-chevron">${isCollapsed ? '▸' : '▾'}</span>
              ${meta.icon} ${meta.label}
              <span class="fmt-cat-count">${items.length}${disabledInCat ? ` <span class="fmt-cat-dis">${disabledInCat} откл.</span>` : ''}</span>
            </div>
            <div class="fmt-cat-body${isCollapsed ? ' fmt-cat-collapsed' : ''}">
              ${items.map(f => renderFactRow(f)).join('')}
            </div>
          </div>`;
      }
    }

    $('#fmt_content').html(html);

    $('#fmt_add_btn').on('click', addFactManual);
    $('#fmt_add_text').on('keydown', e => { if (e.key === 'Enter') addFactManual(); });

    // Collapse/expand category
    $(document).off('click.fmt_collapse').on('click.fmt_collapse', '.fmt-cat-header', function () {
      const cat   = $(this).attr('data-collapse-cat');
      if (!cat) return;
      collapsedCats[cat] = !collapsedCats[cat];
      const body  = $(this).next('.fmt-cat-body');
      const chev  = $(this).find('.fmt-cat-chevron');
      body.toggleClass('fmt-cat-collapsed', collapsedCats[cat]);
      chev.text(collapsedCats[cat] ? '▸' : '▾');
    });

    // Toggle disable
    $(document).off('click.fmt_toggle').on('click.fmt_toggle', '.fmt-toggle-btn', async function (e) {
      e.stopPropagation();
      await toggleDisableFact($(this).attr('data-id'));
    });

    // Delete
    $(document).off('click.fmt_delete').on('click.fmt_delete', '.fmt-delete-btn', async function (e) {
      e.stopPropagation();
      await deleteFact($(this).attr('data-id'));
    });

    applyFilters();
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────────

  async function addFactManual() {
    const text     = String($('#fmt_add_text').val() ?? '').trim();
    const category = String($('#fmt_add_cat').val() ?? 'events');
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

  async function deleteFact(id) {
    const state = await getChatState();
    const idx = state.facts.findIndex(f => f.id === id);
    if (idx >= 0) state.facts.splice(idx, 1);
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
  }

  async function toggleDisableFact(id) {
    const state = await getChatState();
    const fact  = state.facts.find(f => f.id === id);
    if (!fact) return;
    fact.disabled = !fact.disabled;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    // Обновляем только строку без полного ре-рендера
    const row = document.querySelector(`.fmt-fact-row[data-id="${id}"]`);
    if (row) {
      row.classList.toggle('fmt-fact-disabled', fact.disabled);
      const btn = row.querySelector('.fmt-toggle-btn');
      if (btn) { btn.textContent = fact.disabled ? '▶' : '⏸'; btn.title = fact.disabled ? 'Включить факт' : 'Отключить факт'; }
    }
    await renderWidget();
  }


  async function clearAllFacts() {
    const { Popup } = ctx();
    const ok = await Popup.show.confirm('Очистить все факты?', 'Это действие нельзя отменить.');
    if (!ok) return;
    const state = await getChatState();
    state.facts = [];
    state.lastScannedMsgIndex = 0;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
    toastr.success('Все факты удалены');
  }

  // ─── Settings panel ───────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#fmt_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[FMT] settings container not found'); return; }

    const s = getSettings();
    $(target).append(`
      <div class="fmt-settings-block" id="fmt_settings_block">
        <div class="fmt-settings-title">
          <span>🧠 Трекер памяти фактов</span>
          <button type="button" id="fmt_collapse_btn">${s.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="fmt-settings-body" ${s.collapsed ? 'style="display:none"' : ''}>

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
            <label>Инжектировать факты с важностью ≥</label>
            <select id="fmt_inject_imp">
              <option value="low"    ${s.injectImportance === 'low'    ? 'selected' : ''}>⚪ Все (low+)</option>
              <option value="medium" ${s.injectImportance === 'medium' ? 'selected' : ''}>🟡 Medium+ (рекоменд.)</option>
              <option value="high"   ${s.injectImportance === 'high'   ? 'selected' : ''}>🔴 Только High</option>
            </select>
          </div>

          <div class="fmt-api-section">
            <div class="fmt-api-title">⚙️ API для сканирования</div>
            <div class="fmt-api-hint">Оставь пустым — используется встроенный ST. Иначе укажи свой прокси/ключ.</div>

            <label class="fmt-api-label">Endpoint</label>
            <div class="fmt-srow">
              <input type="text" id="fmt_api_endpoint" class="fmt-api-field" placeholder="https://api.openai.com/v1" value="${escapeHtml(s.apiEndpoint || '')}">
            </div>

            <label class="fmt-api-label">API Key</label>
            <div class="fmt-srow" style="gap:6px">
              <input type="password" id="fmt_api_key" class="fmt-api-field" placeholder="sk-..." value="${s.apiKey || ''}">
              <button type="button" id="fmt_api_key_toggle" class="menu_button" style="padding:5px 10px">👁</button>
            </div>

            <label class="fmt-api-label">Модель</label>
            <div class="fmt-srow" style="gap:6px">
              <select id="fmt_api_model" class="fmt-api-select" style="flex:1">
                ${s.apiModel
                  ? `<option value="${escapeHtml(s.apiModel)}" selected>${escapeHtml(s.apiModel)}</option>`
                  : '<option value="">-- нажми 🔄 --</option>'}
              </select>
              <button type="button" id="fmt_refresh_models" class="menu_button" style="padding:5px 10px" title="Загрузить модели">🔄</button>
            </div>
          </div>

          <div class="fmt-srow fmt-btn-row">
            <button class="menu_button" id="fmt_open_drawer_btn">Открыть трекер</button>
            <button class="menu_button" id="fmt_scan_settings_btn">🔍 Сканировать чат</button>
            <button class="menu_button" id="fmt_reset_pos_btn">Сбросить позицию</button>
          </div>

          <div class="fmt-hint">
            <b>Как работает:</b><br>
            🔍 <b>Сканировать</b> — AI анализирует историю и извлекает факты (без дублей).<br>
            ⚡ <b>Авто-скан</b> — срабатывает каждые N сообщений чата автоматически.<br>
            💾 <b>Инъекция</b> — только нужные факты попадают в промпт вместо тяжёлой истории.<br>
            📂 Данные хранятся отдельно для каждого чата.
          </div>
        </div>
      </div>
    `);

    // Collapse
    $('#fmt_collapse_btn').on('click', () => {
      const now = !s.collapsed;
      s.collapsed = now;
      $('#fmt_settings_body').toggle(!now);
      // Используем реальный DOM-элемент body настроек
      $('#fmt_settings_block .fmt-settings-body').toggle(!now);
      $('#fmt_collapse_btn').text(now ? '▸' : '▾');
      ctx().saveSettingsDebounced();
    });

    // Checkboxes
    $('#fmt_enabled').on('input',    async ev => { s.enabled    = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });
    $('#fmt_show_widget').on('input',async ev => { s.showWidget = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await renderWidget(); });
    $('#fmt_fab_scale').on('input', ev => {
      const v = parseFloat($(ev.currentTarget).val());
      s.fabScale = v;
      $('#fmt_fab_scale_val').text(Math.round(v * 100) + '%');
      ctx().saveSettingsDebounced();
      applyFabScale();
    });
    $('#fmt_auto_scan').on('input',       ev => { s.autoScan   = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });

    // Sliders
    $('#fmt_auto_every').on('input', ev => { const v = +$(ev.currentTarget).val(); s.autoScanEvery = v; $('#fmt_auto_every_val').text(v); ctx().saveSettingsDebounced(); });
    $('#fmt_scan_depth').on('input', ev => { const v = +$(ev.currentTarget).val(); s.scanDepth = v;     $('#fmt_scan_depth_val').text(v); ctx().saveSettingsDebounced(); });

    // Select
    $('#fmt_inject_imp').on('change', async ev => { s.injectImportance = $(ev.currentTarget).val(); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });

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
        models.forEach(id => {
          $sel.append(new Option(id, id, id === current, id === current));
        });
        toastr.success(`Загружено: ${models.length} моделей`);
      } catch (e) {
        toastr.error(`[FMT] ${e.message}`);
      } finally {
        $btn.prop('disabled', false).text('🔄');
      }
    });

    // Buttons (delegation)
    $(document)
      .off('click.fmt_settings')
      .on('click.fmt_settings', '#fmt_open_drawer_btn',  () => openDrawer(true))
      .on('click.fmt_settings', '#fmt_scan_settings_btn',() => runScan('manual'))
      .on('click.fmt_settings', '#fmt_reset_pos_btn',    () => {
        try { localStorage.removeItem(FAB_POS_KEY); } catch {}
        setFabDefault();
        toastr.success('Позиция сброшена');
      });
  }

  // ─── Prompt preview ───────────────────────────────────────────────────────────

  async function showPromptPreview() {
    const state    = await getChatState();
    const settings = getSettings();
    const block    = buildInjectedBlock(state, settings) || '[Факты не найдены или все скрыты фильтром важности]';
    await ctx().Popup.show.text(
      'FMT — Инжектируемый промпт',
      `<pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow:auto;font-family:Consolas,monospace">${escapeHtml(block)}</pre>`
    );
  }

  // ─── Event wiring ─────────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab();
      applyFabPosition();
      ensureDrawer();
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

    // После каждого сообщения — счётчик и возможный авто-скан
    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
      await renderWidget();
      const s = getSettings();
      if (!s.autoScan) return;
      msgSinceLastScan++;
      if (msgSinceLastScan >= s.autoScanEvery) {
        msgSinceLastScan = 0;
        await runScan('auto');
      }
    });

    eventSource.on(event_types.MESSAGE_SENT, async () => {
      await renderWidget();
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireChatEvents();
      console.log('[FMT] v1.0.0 — Facts Memory Tracker loaded');
    } catch (e) {
      console.error('[FMT] init failed', e);
    }
  });

})();
