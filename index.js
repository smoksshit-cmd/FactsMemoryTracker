/**
 * Memory Extractor — SillyTavern Extension
 * Извлекает важные факты из ролевого чата и инжектирует в контекст
 * Архитектура: FAB-виджет + выдвижная панель + настройки в сайдбаре
 */

(() => {
  'use strict';

  const MODULE_KEY  = 'memory_extractor';
  const PROMPT_TAG  = 'ME_MEMORY_BLOCK';
  const FAB_POS_KEY = 'me_fab_pos_v1';
  const FAB_MARGIN  = 8;

  let lastFabDragTs  = 0;
  let isExtracting   = false;
  let msgCounter     = 0;

  const EXT_PROMPT_TYPES = Object.freeze({
    NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2,
  });

  const CATS = Object.freeze({
    characters : { label: 'Персонажи и отношения', icon: '👤', color: '#7eb8f7' },
    events     : { label: 'События и последствия',  icon: '⚡', color: '#f7c97e' },
    secrets    : { label: 'Секреты и скрытая инфа', icon: '🔒', color: '#c97ef7' },
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled        : true,
    showWidget     : true,
    collapsed      : false,
    api_mode       : 'st',      // 'st' | 'custom'
    api_url        : '',
    api_key        : '',
    api_model      : 'gpt-4o-mini',
    trigger_mode   : 'auto',   // 'auto' | 'manual'
    trigger_every  : 10,
    scan_last      : 20,
    inject_position: EXT_PROMPT_TYPES.IN_PROMPT,
    active_cats    : ['characters', 'events', 'secrets'],
    total_scans    : 0,
  });

  /* ══════════════════════════════════════════════════════
     ХЕЛПЕРЫ
  ══════════════════════════════════════════════════════ */

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = DEFAULT_SETTINGS[k];
    return extensionSettings[MODULE_KEY];
  }

  function getChatKey() {
    const c = ctx();
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null)
                 || c.chatId || 'unknown';
    const charId = c.characterId ?? c.groupId ?? 'unknown';
    return `me_facts__${charId}__${chatId}`;
  }

  async function getFacts() {
    const { chatMetadata, saveMetadata } = ctx();
    const key = getChatKey();
    if (!chatMetadata[key]) {
      chatMetadata[key] = { characters: [], events: [], secrets: [] };
      await saveMetadata();
    }
    return chatMetadata[key];
  }

  async function saveFacts(facts) {
    const { chatMetadata, saveMetadata } = ctx();
    chatMetadata[getChatKey()] = facts;
    await saveMetadata();
  }

  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  function totalFacts(facts) {
    return (facts?.characters?.length || 0)
         + (facts?.events?.length     || 0)
         + (facts?.secrets?.length    || 0);
  }

  function getRecentMessages(n = 20) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return '';
    return chat.slice(-n).map(m => {
      const who = m.is_user ? '{{user}}' : (m.name || '{{char}}');
      return `${who}: ${(m.mes || '').trim()}`;
    }).join('\n\n');
  }

  /* ══════════════════════════════════════════════════════
     ВСПЛЫВАШКА
  ══════════════════════════════════════════════════════ */

  function xtoast(type, msg) {
    try { toastr?.[type]?.(msg, 'Память', { timeOut: 3000, positionClass: 'toast-top-center' }); }
    catch {}
  }

  /* ══════════════════════════════════════════════════════
     ПРОМПТ-БЛОК
  ══════════════════════════════════════════════════════ */

  function buildPromptBlock(facts) {
    const s = getSettings();
    const chars   = (facts.characters || []).filter(f => s.active_cats.includes('characters'));
    const events  = (facts.events     || []).filter(f => s.active_cats.includes('events'));
    const secrets = (facts.secrets    || []).filter(f => s.active_cats.includes('secrets'));

    if (!chars.length && !events.length && !secrets.length) return '';

    const lines = ['[ПАМЯТЬ — важные факты из истории ролевой игры]'];

    if (chars.length) {
      lines.push('\nПЕРСОНАЖИ И ОТНОШЕНИЯ:');
      chars.forEach(f => {
        let line = `- ${f.name || '?'}`;
        if (f.rel_type) line = `- ${f.from} ↔ ${f.to} [${f.rel_type}]${f.notes ? ': ' + f.notes : ''}`;
        else {
          if (f.status)       line += ` | статус: ${f.status}`;
          if (f.location)     line += ` | локация: ${f.location}`;
          if (f.traits?.length) line += ` | ${f.traits.join(', ')}`;
        }
        lines.push(line);
      });
    }
    if (events.length) {
      lines.push('\nСОБЫТИЯ:');
      events.forEach(f => {
        let line = `- ${f.what || '?'}`;
        if (f.where)       line += ` (${f.where})`;
        if (f.consequence) line += ` → ${f.consequence}`;
        lines.push(line);
      });
    }
    if (secrets.length) {
      lines.push('\nСЕКРЕТЫ:');
      secrets.forEach(f => {
        let line = `- ${f.fact || '?'}`;
        if (f.known_by?.length)    line += ` | знает: ${f.known_by.join(', ')}`;
        if (f.hidden_from?.length) line += ` | скрыто от: ${f.hidden_from.join(', ')}`;
        lines.push(line);
      });
    }

    lines.push('[/ПАМЯТЬ]');
    return lines.join('\n');
  }

  async function updateInjectedPrompt() {
    const s = getSettings();
    const { setExtensionPrompt } = ctx();
    if (!s.enabled) {
      setExtensionPrompt(PROMPT_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true);
      return;
    }
    const facts = await getFacts();
    setExtensionPrompt(PROMPT_TAG, buildPromptBlock(facts), s.inject_position, 0, true);
  }

  /* ══════════════════════════════════════════════════════
     AI — ЗАПРОС К МОДЕЛИ
  ══════════════════════════════════════════════════════ */

  function getBaseUrl() {
    const s = getSettings();
    return (s.api_url || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/v1$/, '');
  }

  async function aiGenerate(prompt) {
    const s    = getSettings();
    const base = getBaseUrl();

    if (s.api_mode === 'custom' && base && s.api_key) {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${s.api_key}`,
        },
        body: JSON.stringify({
          model      : s.api_model || 'gpt-4o-mini',
          max_tokens : 2048,
          temperature: 0.1,
          messages   : [{ role: 'user', content: prompt }],
        }),
      });
      if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => '')}`);
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    }

    // ST встроенный
    const c = ctx();
    if (typeof c.generateRaw === 'function')
      return await c.generateRaw(prompt, null, false, false, '', true);
    throw new Error('Не задан свой API и нет встроенного generate в SillyTavern');
  }

  async function fetchModels() {
    const base   = getBaseUrl();
    const apiKey = (getSettings().api_key || '').trim();
    if (!base || !apiKey) throw new Error('Укажи URL и API-ключ');
    const resp = await fetch(`${base}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data.data || data.models || [])
      .map(m => (typeof m === 'string' ? m : m.id))
      .filter(Boolean).sort();
  }

  /* ══════════════════════════════════════════════════════
     ПРОМПТ ИЗВЛЕЧЕНИЯ
  ══════════════════════════════════════════════════════ */

  function buildExtractionPrompt(messages, existing) {
    const existingLines = [];
    if (existing.characters?.length) {
      existingLines.push('ПЕРСОНАЖИ:');
      existing.characters.forEach(f => existingLines.push(
        `  [${f.id}] ${f.name} | статус:${f.status||'?'} | локация:${f.location||'?'}${f.rel_type ? ` | ↔ ${f.from}/${f.to}: ${f.rel_type}` : ''}`
      ));
    }
    if (existing.events?.length) {
      existingLines.push('СОБЫТИЯ:');
      existing.events.forEach(f => existingLines.push(`  [${f.id}] ${f.what} → ${f.consequence||'?'}`));
    }
    if (existing.secrets?.length) {
      existingLines.push('СЕКРЕТЫ:');
      existing.secrets.forEach(f => existingLines.push(`  [${f.id}] ${f.fact} | знает: ${(f.known_by||[]).join(', ')}`));
    }
    const existingBlock = existingLines.length
      ? `\nУЖЕ ИЗВЕСТНЫЕ ФАКТЫ (не дублировать, даже другими словами):\n${existingLines.join('\n')}\n`
      : '';

    return `Ты — система извлечения фактов для ролевой игры. Анализируй диалог и извлекай ТОЛЬКО важные, конкретные факты.

ПРАВИЛА:
1. Только факты из текста — без домыслов
2. Если факт уже есть в памяти — пропусти (НЕ ДУБЛИРУЙ)
3. Если факт обновляет старый — добавь в updates с update_id старого факта
4. Пустые категории — пустые массивы []
5. Отвечай ТОЛЬКО валидным JSON — никакого текста вокруг, никаких markdown-блоков${existingBlock}

СООБЩЕНИЯ ДЛЯ АНАЛИЗА:
${messages}

ФОРМАТ ОТВЕТА:
{
  "characters": [
    { "id": "char_имя", "name": "Имя", "aliases": [], "traits": [], "status": "жив/мёртв/неизвестно", "location": "где", "type": "new" }
  ],
  "relations": [
    { "id": "rel_id", "from": "Персонаж А", "to": "Персонаж Б", "rel_type": "союзники/враги/и т.д.", "notes": "", "type": "new" }
  ],
  "events": [
    { "id": "ev_id", "what": "Что произошло", "who": [], "where": "место", "consequence": "последствие", "type": "new" }
  ],
  "secrets": [
    { "id": "sec_id", "fact": "Секрет", "known_by": [], "hidden_from": [], "type": "new" }
  ],
  "updates": [
    { "update_id": "id_факта", "cat": "characters/events/secrets", "field": "поле", "new_value": "новое значение" }
  ]
}`;
  }

  /* ══════════════════════════════════════════════════════
     ПАРСИНГ И МЁРЖ
  ══════════════════════════════════════════════════════ */

  function parseJSON(raw) {
    if (!raw) return null;
    try {
      const clean = raw.replace(/```json|```/gi, '').trim();
      const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
      if (s < 0 || e < 0) return null;
      return JSON.parse(clean.slice(s, e + 1));
    } catch (err) {
      console.warn('[ME] JSON parse error:', err);
      return null;
    }
  }

  function normStr(s) {
    return String(s).toLowerCase().replace(/[^\wа-яёa-z0-9\s]/gi, '').replace(/\s+/g,' ').trim();
  }

  function similarity(a, b) {
    const na = normStr(a), nb = normStr(b);
    if (na.includes(nb) || nb.includes(na)) return 1;
    const wa = new Set(na.split(' ').filter(w => w.length >= 4));
    const wb = new Set(nb.split(' ').filter(w => w.length >= 4));
    if (!wa.size && !wb.size) return na === nb ? 1 : 0;
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / Math.max(wa.size, wb.size);
  }

  function mergeFacts(existing, parsed) {
    const merged = {
      characters : [...(existing.characters || [])],
      events     : [...(existing.events     || [])],
      secrets    : [...(existing.secrets    || [])],
    };

    // Применяем обновления
    if (parsed.updates?.length) {
      for (const upd of parsed.updates) {
        const arr = merged[upd.cat];
        if (!arr) continue;
        const item = arr.find(i => i.id === upd.update_id);
        if (item) item[upd.field] = upd.new_value;
      }
    }

    const SIM = 0.45;
    const pool = [
      ...merged.characters.map(f => f.text || f.name || ''),
      ...merged.events.map(f => f.what || ''),
      ...merged.secrets.map(f => f.fact || ''),
    ];

    function isDup(text) {
      return pool.some(ex => similarity(ex, text) >= SIM);
    }

    function addIfNew(cat, item, textKey) {
      if (!item) return false;
      if (!item.id) item.id = cat.slice(0, 3) + '_' + Math.random().toString(36).slice(2, 7);
      const text = item[textKey] || item.name || '';
      if (!text || isDup(text)) return false;
      merged[cat].unshift(item);
      pool.push(text);
      return true;
    }

    let newCount = 0;
    (parsed.characters || []).forEach(f => { if (addIfNew('characters', f, 'name'))     newCount++; });
    (parsed.relations  || []).forEach(f => {
      const merged_item = { ...f, name: `${f.from} ↔ ${f.to}` };
      if (addIfNew('characters', merged_item, 'name')) newCount++;
    });
    (parsed.events  || []).forEach(f => { if (addIfNew('events',  f, 'what')) newCount++; });
    (parsed.secrets || []).forEach(f => { if (addIfNew('secrets', f, 'fact')) newCount++; });

    return { merged, newCount };
  }

  /* ══════════════════════════════════════════════════════
     ОСНОВНОЕ — СКАНИРОВАНИЕ
  ══════════════════════════════════════════════════════ */

  async function runExtraction() {
    if (isExtracting) { xtoast('warning', 'Сканирование уже идёт…'); return; }
    if (!getSettings().enabled) { xtoast('warning', 'Расширение отключено'); return; }

    const { chat } = ctx();
    if (!Array.isArray(chat) || chat.length < 2) { xtoast('warning', 'Чат слишком короткий'); return; }

    isExtracting = true;
    const $btn = $('#me_scan_btn, #me_scan_drawer_btn');
    $btn.prop('disabled', true).text('⏳ Анализ…');
    updateStatus('⏳ Извлечение фактов…', 'info');

    try {
      const existing = await getFacts();
      const messages = getRecentMessages(getSettings().scan_last);
      const prompt   = buildExtractionPrompt(messages, existing);
      const raw      = await aiGenerate(prompt);
      const parsed   = parseJSON(raw);

      if (!parsed) {
        updateStatus('⚠️ Не удалось разобрать ответ модели', 'warn');
        xtoast('warning', 'Не удалось разобрать ответ модели');
        return;
      }

      const { merged, newCount } = mergeFacts(existing, parsed);
      merged._total_scans = (existing._total_scans || 0) + 1;
      getSettings().total_scans = merged._total_scans;
      ctx().saveSettingsDebounced();

      await saveFacts(merged);
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#me_drawer').hasClass('me-open')) await renderDrawerContent();

      updateStatus(`✅ Готово! Новых фактов: ${newCount}`, 'success');
      xtoast('success', `Извлечено новых фактов: ${newCount}`);

    } catch (err) {
      console.error('[ME] extraction error:', err);
      updateStatus(`❌ Ошибка: ${err.message}`, 'error');
      xtoast('error', 'Ошибка: ' + err.message);
    } finally {
      isExtracting = false;
      $btn.prop('disabled', false).text('🔍 Сканировать чат');
    }
  }

  function updateStatus(msg, type) {
    const colors = { info:'#94a3b8', success:'#34d399', warn:'#fbbf24', error:'#f87171' };
    $('#me_status_line').css('color', colors[type] || colors.info).text(msg);
  }

  /* ══════════════════════════════════════════════════════
     FAB — перетаскиваемый виджет
     Архитектура: точная копия подхода из SRT
  ══════════════════════════════════════════════════════ */

  function vpW() { return window.visualViewport?.width  || window.innerWidth;  }
  function vpH() { return window.visualViewport?.height || window.innerHeight; }

  function getFabSize() {
    const el = document.getElementById('me_fab');
    if (el && el.offsetWidth > 0) return { W: el.offsetWidth, H: el.offsetHeight };
    return { W: 58, H: 58 };
  }

  function clampFabPos(left, top) {
    const { W, H } = getFabSize();
    return {
      left: clamp(left, FAB_MARGIN, Math.max(FAB_MARGIN, vpW() - W - FAB_MARGIN)),
      top : clamp(top,  FAB_MARGIN, Math.max(FAB_MARGIN, vpH() - H - FAB_MARGIN)),
    };
  }

  function saveFabPos(left, top) {
    const { W, H } = getFabSize();
    const clamped = clampFabPos(left, top);
    const rangeX  = Math.max(1, vpW() - W - FAB_MARGIN * 2);
    const rangeY  = Math.max(1, vpH() - H - FAB_MARGIN * 2);
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        x: clamp01((clamped.left - FAB_MARGIN) / rangeX),
        y: clamp01((clamped.top  - FAB_MARGIN) / rangeY),
        left: clamped.left, top: clamped.top,
      }));
    } catch {}
  }

  function applyFabPos() {
    const el = document.getElementById('me_fab');
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
      } else { left = pos.left || 0; top = pos.top || 0; }
      const c = clampFabPos(left, top);
      el.style.left = c.left + 'px';
      el.style.top  = c.top  + 'px';
    } catch { setFabDefault(); }
  }

  function setFabDefault() {
    const el = document.getElementById('me_fab');
    if (!el) return;
    const { W, H } = getFabSize();
    const left = clamp(vpW() - W - FAB_MARGIN, FAB_MARGIN, vpW() - W - FAB_MARGIN);
    const top  = clamp(Math.round((vpH() - H) / 2), FAB_MARGIN, vpH() - H - FAB_MARGIN);
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';
    el.style.right = el.style.bottom = 'auto';
    saveFabPos(left, top);
  }

  function ensureFab() {
    if (document.getElementById('me_fab')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="me_fab">
        <button type="button" id="me_fab_btn" title="Открыть память">
          <div class="me-fab-icon">🧠</div>
          <div class="me-fab-counts">
            <span id="me_fab_count">0</span> фактов
          </div>
        </button>
        <button type="button" id="me_fab_hide" title="Скрыть виджет">✕</button>
      </div>
    `);

    document.getElementById('me_fab_btn').addEventListener('click', ev => {
      if (Date.now() - lastFabDragTs < 350) { ev.preventDefault(); ev.stopPropagation(); return; }
      openDrawer(true);
    });

    document.getElementById('me_fab_hide').addEventListener('click', async () => {
      getSettings().showWidget = false;
      ctx().saveSettingsDebounced();
      document.getElementById('me_fab').style.display = 'none';
      xtoast('info', 'Виджет скрыт — включите в настройках расширения');
    });

    initFabDrag();
    applyFabPos();

    let resizeTimer = null;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyFabPos, 200); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(applyFabPos, 350); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  }

  function initFabDrag() {
    const fab    = document.getElementById('me_fab');
    const handle = document.getElementById('me_fab_btn');
    if (!fab || !handle || fab.dataset.dragInit) return;
    fab.dataset.dragInit = '1';

    let sx, sy, sl, st, moved = false;

    const onMove = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; fab.classList.add('me-dragging'); }
      if (!moved) return;
      const c = clampFabPos(sl + dx, st + dy);
      fab.style.left = c.left + 'px';
      fab.style.top  = c.top  + 'px';
      fab.style.right = fab.style.bottom = 'auto';
      ev.preventDefault(); ev.stopPropagation();
    };

    const onEnd = ev => {
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      document.removeEventListener('pointermove', onMove, { passive: false });
      document.removeEventListener('pointerup',   onEnd);
      document.removeEventListener('pointercancel', onEnd);
      if (moved) { saveFabPos(parseInt(fab.style.left)||0, parseInt(fab.style.top)||0); lastFabDragTs = Date.now(); }
      moved = false;
      fab.classList.remove('me-dragging');
    };

    handle.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const c = clampFabPos(parseInt(fab.style.left)||0, parseInt(fab.style.top)||0);
      fab.style.left = c.left + 'px'; fab.style.top = c.top + 'px';
      fab.style.right = fab.style.bottom = 'auto'; fab.style.transform = 'none';
      sx = ev.clientX; sy = ev.clientY; sl = c.left; st = c.top;
      moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch {}
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup',   onEnd);
      document.addEventListener('pointercancel', onEnd);
      ev.preventDefault(); ev.stopPropagation();
    }, { passive: false });
  }

  async function renderWidget() {
    const s = getSettings();
    ensureFab();
    applyFabPos();
    const fab = document.getElementById('me_fab');
    if (!fab) return;
    fab.style.display = (s.showWidget && s.enabled) ? '' : 'none';
    const facts = await getFacts();
    const n = totalFacts(facts);
    document.getElementById('me_fab_count').textContent = n;
  }

  /* ══════════════════════════════════════════════════════
     DRAWER — выдвижная панель
  ══════════════════════════════════════════════════════ */

  function ensureDrawer() {
    if (document.getElementById('me_drawer')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <aside id="me_drawer" aria-hidden="true">
        <header>
          <div class="me-head-top">
            <div class="me-head-title">🧠 ПАМЯТЬ</div>
            <button type="button" id="me_drawer_close" title="Закрыть">✕</button>
          </div>
          <div class="me-head-sub" id="me_drawer_sub"></div>
        </header>
        <div class="me-drawer-body" id="me_drawer_body"></div>
        <footer class="me-drawer-foot">
          <button type="button" id="me_scan_drawer_btn">🔍 Сканировать чат</button>
          <button type="button" id="me_clear_drawer_btn">🗑 Очистить память</button>
          <button type="button" id="me_close_drawer_btn2">Закрыть</button>
        </footer>
      </aside>
    `);

    document.getElementById('me_drawer_close').addEventListener('click',  () => openDrawer(false), true);
    document.getElementById('me_close_drawer_btn2').addEventListener('click', () => openDrawer(false), true);
    document.getElementById('me_scan_drawer_btn').addEventListener('click', () => runExtraction());
    document.getElementById('me_clear_drawer_btn').addEventListener('click', async () => {
      if (confirm('Очистить всю память для этого чата?')) {
        await saveFacts({ characters: [], events: [], secrets: [] });
        await updateInjectedPrompt();
        await renderWidget();
        await renderDrawerContent();
        xtoast('info', 'Память очищена');
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('me_drawer')?.classList.contains('me-open'))
        openDrawer(false);
    });
  }

  function openDrawer(open) {
    ensureDrawer();
    const drawer = document.getElementById('me_drawer');
    if (!drawer) return;

    if (open) {
      if (!document.getElementById('me_overlay')) {
        const ov = document.createElement('div');
        ov.id = 'me_overlay';
        document.body.insertBefore(ov, drawer);
        ov.addEventListener('click', () => openDrawer(false), true);
        ov.addEventListener('touchstart', e => { e.preventDefault(); openDrawer(false); }, { passive: false, capture: true });
      }
      document.getElementById('me_overlay').style.display = 'block';
      drawer.classList.add('me-open');
      drawer.setAttribute('aria-hidden', 'false');
      renderDrawerContent();
    } else {
      drawer.classList.remove('me-open');
      drawer.setAttribute('aria-hidden', 'true');
      const ov = document.getElementById('me_overlay');
      if (ov) ov.style.display = 'none';
    }
  }

  let drawerCat = 'all', drawerQuery = '';

  async function renderDrawerContent() {
    const facts = await getFacts();
    const total = totalFacts(facts);
    document.getElementById('me_drawer_sub').textContent = `Всего фактов: ${total}`;

    const tabHtml = [
      { id: 'all', label: 'Все', icon: '🗂' },
      ...Object.entries(CATS).map(([id, v]) => ({ id, label: v.label, icon: v.icon })),
    ].map(t => `<button class="me-tab${drawerCat === t.id ? ' me-active' : ''}" data-cat="${t.id}">${t.icon} ${t.label}</button>`).join('');

    const html = `
      <div class="me-drawer-filters">${tabHtml}</div>
      <div class="me-drawer-search">
        <input id="me_drawer_search" type="text" placeholder="🔍 Поиск по фактам…" value="${esc(drawerQuery)}">
      </div>
      <div class="me-facts-list" id="me_facts_list"></div>
      <div class="me-add-block">
        <div class="me-add-title">➕ Добавить факт вручную</div>
        <select id="me_add_cat">
          ${Object.entries(CATS).map(([id, v]) => `<option value="${id}">${v.icon} ${v.label}</option>`).join('')}
        </select>
        <input type="text" id="me_add_text" placeholder="Текст факта…">
        <button id="me_add_btn">Добавить</button>
      </div>`;

    document.getElementById('me_drawer_body').innerHTML = html;

    // Рендер фактов
    renderFactsList(facts);

    // Табы
    document.querySelectorAll('.me-tab').forEach(btn =>
      btn.addEventListener('click', function () {
        drawerCat = this.dataset.cat;
        document.querySelectorAll('.me-tab').forEach(b => b.classList.remove('me-active'));
        this.classList.add('me-active');
        renderFactsList(facts);
      })
    );

    // Поиск
    document.getElementById('me_drawer_search').addEventListener('input', function () {
      drawerQuery = this.value;
      renderFactsList(facts);
    });

    // Добавить вручную
    document.getElementById('me_add_btn').addEventListener('click', async () => {
      const cat  = document.getElementById('me_add_cat').value;
      const text = document.getElementById('me_add_text').value.trim();
      if (!text) return xtoast('warning', 'Введите текст факта');
      const fact = { id: makeId() };
      if (cat === 'characters') { fact.name = text; fact.type = 'new'; }
      else if (cat === 'events') { fact.what = text; fact.type = 'new'; }
      else { fact.fact = text; fact.type = 'new'; }
      const current = await getFacts();
      current[cat].unshift(fact);
      await saveFacts(current);
      await updateInjectedPrompt();
      await renderWidget();
      document.getElementById('me_add_text').value = '';
      renderFactsList(current);
      xtoast('success', 'Факт добавлен');
    });
  }

  function renderFactsList(facts) {
    const container = document.getElementById('me_facts_list');
    if (!container) return;
    const q = drawerQuery.toLowerCase();

    const catsToShow = drawerCat === 'all' ? Object.keys(CATS) : [drawerCat];
    let html = '', anyFact = false;

    for (const catId of catsToShow) {
      const cat   = CATS[catId];
      const items = (facts[catId] || []).filter(f =>
        !q || JSON.stringify(f).toLowerCase().includes(q)
      );
      if (!items.length) continue;
      anyFact = true;

      html += `<div class="me-cat-block">
<div class="me-cat-head" style="border-left-color:${cat.color}">
  ${cat.icon} ${cat.label} <span class="me-cnt">${items.length}</span>
</div>`;

      items.forEach((f, idx) => {
        const name = f.name || f.what || f.fact || '?';
        const rows = [];
        if (catId === 'characters') {
          if (f.rel_type) rows.push(`<span class="me-pill">↔</span> ${esc(f.from)} — ${esc(f.rel_type)} — ${esc(f.to)}`);
          if (f.status)   rows.push(`<span class="me-pill">статус</span> ${esc(f.status)}`);
          if (f.location) rows.push(`<span class="me-pill">локация</span> ${esc(f.location)}`);
          if (f.traits?.length) rows.push(`<span class="me-pill">черты</span> ${esc(f.traits.join(', '))}`);
        } else if (catId === 'events') {
          if (f.where)        rows.push(`<span class="me-pill">место</span> ${esc(f.where)}`);
          if (f.consequence)  rows.push(`<span class="me-pill">итог</span> ${esc(f.consequence)}`);
          if (f.who?.length)  rows.push(`<span class="me-pill">кто</span> ${esc(f.who.join(', '))}`);
        } else if (catId === 'secrets') {
          if (f.known_by?.length)    rows.push(`<span class="me-pill">знает</span> ${esc(f.known_by.join(', '))}`);
          if (f.hidden_from?.length) rows.push(`<span class="me-pill">скрыто от</span> ${esc(f.hidden_from.join(', '))}`);
        }

        html += `<div class="me-fact-card">
  <div class="me-fact-inner">
    <div class="me-fact-name">${esc(name)}</div>
    ${rows.map(r => `<div class="me-fact-row">${r}</div>`).join('')}
  </div>
  <button class="me-del-btn" data-cat="${catId}" data-idx="${idx}" title="Удалить">✕</button>
</div>`;
      });

      html += `</div>`;
    }

    if (!anyFact) {
      html = `<div class="me-empty">
  <div class="me-empty-ico">${q ? '🔍' : '🧠'}</div>
  <div>${q ? 'Ничего не найдено' : 'Факты ещё не извлечены.<br>Нажмите «Сканировать чат».'}</div>
</div>`;
    }

    container.innerHTML = html;

    // Удаление
    container.querySelectorAll('.me-del-btn').forEach(btn =>
      btn.addEventListener('click', async function () {
        const cat = this.dataset.cat;
        const idx = parseInt(this.dataset.idx);
        const current = await getFacts();
        if (!current[cat]) return;
        current[cat].splice(idx, 1);
        await saveFacts(current);
        await updateInjectedPrompt();
        await renderWidget();
        renderFactsList(current);
      })
    );
  }

  /* ══════════════════════════════════════════════════════
     ПАНЕЛЬ НАСТРОЕК ST
  ══════════════════════════════════════════════════════ */

  async function mountSettingsUI() {
    if (document.getElementById('me_settings_block')) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[ME] settings container not found'); return; }

    const s = getSettings();
    $(target).append(`
      <div class="me-settings-block" id="me_settings_block">
        <div class="me-settings-title">
          <span>🧠 Memory Extractor — Извлечение памяти</span>
          <button type="button" id="me_collapse_btn">▾</button>
        </div>
        <div class="me-settings-body" id="me_settings_body">

          <div class="me-s-section">Основное</div>
          <div class="me-s-row">
            <label class="checkbox_label">
              <input type="checkbox" id="me_s_enabled" ${s.enabled ? 'checked' : ''}>
              <span>Включить расширение</span>
            </label>
          </div>
          <div class="me-s-row">
            <label class="checkbox_label">
              <input type="checkbox" id="me_s_widget" ${s.showWidget ? 'checked' : ''}>
              <span>Показывать плавающий виджет 🧠</span>
            </label>
          </div>

          <div class="me-s-section">Источник API</div>
          <div class="me-s-row">
            <label class="me-radio-lbl"><input type="radio" name="me_api_mode" value="st" ${s.api_mode === 'st' ? 'checked' : ''}> Текущее ST подключение</label>
          </div>
          <div class="me-s-row">
            <label class="me-radio-lbl"><input type="radio" name="me_api_mode" value="custom" ${s.api_mode === 'custom' ? 'checked' : ''}> Свой API / Прокси</label>
          </div>
          <div id="me_s_custom_block" style="${s.api_mode !== 'custom' ? 'display:none' : ''}">
            <div class="me-s-row">
              <span class="me-s-lbl">Endpoint:</span>
              <input type="text" id="me_s_api_url" class="me-s-input" placeholder="https://api.openai.com/v1" value="${esc(s.api_url || '')}">
            </div>
            <div class="me-s-row">
              <span class="me-s-lbl">API-ключ:</span>
              <input type="password" id="me_s_api_key" class="me-s-input" placeholder="sk-..." value="${esc(s.api_key || '')}">
              <button type="button" id="me_s_key_toggle" class="menu_button" style="padding:5px 10px;flex-shrink:0">👁</button>
            </div>
            <div class="me-s-row">
              <span class="me-s-lbl">Модель:</span>
              <select id="me_s_model" class="me-s-select" style="flex:1">
                ${s.api_model ? `<option value="${esc(s.api_model)}" selected>${esc(s.api_model)}</option>` : '<option value="">-- нажми 🔄 --</option>'}
              </select>
              <button type="button" id="me_s_refresh_models" class="menu_button" title="Загрузить список моделей" style="padding:5px 10px;flex-shrink:0">🔄</button>
            </div>
          </div>

          <div class="me-s-section">Триггер сканирования</div>
          <div class="me-s-row">
            <label class="me-radio-lbl"><input type="radio" name="me_trigger" value="auto"   ${s.trigger_mode === 'auto'   ? 'checked' : ''}> Автоматически каждые N сообщений</label>
          </div>
          <div class="me-s-row">
            <label class="me-radio-lbl"><input type="radio" name="me_trigger" value="manual" ${s.trigger_mode === 'manual' ? 'checked' : ''}> Только вручную</label>
          </div>
          <div class="me-s-row" id="me_s_auto_row" style="${s.trigger_mode !== 'auto' ? 'display:none' : ''}">
            <span class="me-s-lbl">Каждые:</span>
            <input type="number" id="me_s_trigger_every" class="me-s-num" min="1" max="200" value="${s.trigger_every}">
            <span>сообщений</span>
          </div>
          <div class="me-s-row">
            <span class="me-s-lbl">Сканировать:</span>
            <input type="number" id="me_s_scan_last" class="me-s-num" min="5" max="200" value="${s.scan_last}">
            <span>последних сообщений</span>
          </div>

          <div class="me-s-section">Инжект в контекст</div>
          <div class="me-s-row">
            <span class="me-s-lbl">Позиция:</span>
            <select id="me_s_inject_pos" class="me-s-select" style="flex:1">
              <option value="0" ${s.inject_position === 0 ? 'selected' : ''}>В промпт</option>
              <option value="1" ${s.inject_position === 1 ? 'selected' : ''}>В чат</option>
              <option value="2" ${s.inject_position === 2 ? 'selected' : ''}>Перед промптом</option>
            </select>
          </div>

          <div class="me-s-section">Действия</div>
          <div class="me-s-row" style="flex-wrap:wrap;gap:6px">
            <button class="menu_button" id="me_scan_btn">🔍 Сканировать чат</button>
            <button class="menu_button" id="me_open_drawer_btn">📋 Открыть трекер</button>
            <button class="menu_button" id="me_s_reset_pos_btn">📍 Сбросить позицию виджета</button>
          </div>
          <div id="me_status_line" style="font-size:11px;margin-top:4px;min-height:16px;color:#94a3b8"></div>

          <div class="me-s-section">Статистика</div>
          <div class="me-s-hint" id="me_s_stats">${await buildStatsText()}</div>

        </div>
      </div>
    `);

    if (s.collapsed) {
      $('#me_settings_body').hide();
      $('#me_collapse_btn').text('▸');
    }

    // Сворачивание
    $('#me_collapse_btn').on('click', () => {
      const now = !$('#me_settings_body').is(':visible');
      if (now) $('#me_settings_body').show(); else $('#me_settings_body').hide();
      $('#me_collapse_btn').text(now ? '▾' : '▸');
      getSettings().collapsed = !now;
      ctx().saveSettingsDebounced();
    });

    // Основные переключатели
    $('#me_s_enabled').on('change', async function () {
      getSettings().enabled = this.checked;
      ctx().saveSettingsDebounced();
      await updateInjectedPrompt();
      await renderWidget();
    });

    $('#me_s_widget').on('change', async function () {
      getSettings().showWidget = this.checked;
      ctx().saveSettingsDebounced();
      await renderWidget();
    });

    // API mode
    $('input[name="me_api_mode"]').on('change', function () {
      getSettings().api_mode = this.value;
      ctx().saveSettingsDebounced();
      $('#me_s_custom_block').css('display', this.value === 'custom' ? '' : 'none');
    });

    $('#me_s_api_url').on('input', function () { getSettings().api_url = this.value.trim(); ctx().saveSettingsDebounced(); });
    $('#me_s_api_key').on('input', function () { getSettings().api_key = this.value.trim(); ctx().saveSettingsDebounced(); });
    $('#me_s_key_toggle').on('click', () => {
      const inp = document.getElementById('me_s_api_key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#me_s_model').on('change', function () { getSettings().api_model = this.value; ctx().saveSettingsDebounced(); });

    $('#me_s_refresh_models').on('click', async function () {
      $(this).prop('disabled', true).text('⏳');
      try {
        const models = await fetchModels();
        const cur    = getSettings().api_model || '';
        $('#me_s_model').html('<option value="">-- выбери модель --</option>');
        models.forEach(id => {
          const opt = new Option(id, id, false, id === cur);
          $('#me_s_model').append(opt);
        });
        xtoast('success', `Загружено моделей: ${models.length}`);
      } catch (e) {
        xtoast('error', 'Ошибка загрузки моделей: ' + e.message);
      } finally {
        $(this).prop('disabled', false).text('🔄');
      }
    });

    // Триггер
    $('input[name="me_trigger"]').on('change', function () {
      getSettings().trigger_mode = this.value;
      ctx().saveSettingsDebounced();
      $('#me_s_auto_row').css('display', this.value === 'auto' ? '' : 'none');
    });

    $('#me_s_trigger_every').on('input', function () { getSettings().trigger_every = parseInt(this.value) || 10; ctx().saveSettingsDebounced(); });
    $('#me_s_scan_last').on('input',     function () { getSettings().scan_last     = parseInt(this.value) || 20; ctx().saveSettingsDebounced(); });
    $('#me_s_inject_pos').on('change',   async function () {
      getSettings().inject_position = parseInt(this.value);
      ctx().saveSettingsDebounced();
      await updateInjectedPrompt();
    });

    // Кнопки действий
    $('#me_scan_btn').on('click',         () => runExtraction());
    $('#me_open_drawer_btn').on('click',  () => openDrawer(true));
    $('#me_s_reset_pos_btn').on('click',  () => {
      try { localStorage.removeItem(FAB_POS_KEY); } catch {}
      setFabDefault();
      xtoast('success', 'Позиция виджета сброшена');
    });
  }

  async function buildStatsText() {
    const facts = await getFacts();
    const s = getSettings();
    return `Сканирований: ${s.total_scans || 0} · Персонажей: ${(facts.characters||[]).length} · Событий: ${(facts.events||[]).length} · Секретов: ${(facts.secrets||[]).length}`;
  }

  /* ══════════════════════════════════════════════════════
     СОБЫТИЯ ЧАТА
  ══════════════════════════════════════════════════════ */

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureFab(); applyFabPos(); ensureDrawer();
      await mountSettingsUI();
      await updateInjectedPrompt();
      await renderWidget();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      msgCounter = 0;
      await updateInjectedPrompt();
      await renderWidget();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
      const s = getSettings();
      if (!s.enabled || s.trigger_mode !== 'auto') return;
      msgCounter++;
      if (msgCounter >= s.trigger_every) {
        msgCounter = 0;
        await runExtraction();
      }
    });
  }

  /* ══════════════════════════════════════════════════════
     ЗАПУСК
  ══════════════════════════════════════════════════════ */

  jQuery(() => {
    try { wireChatEvents(); console.log('[ME] Memory Extractor загружен ✓'); }
    catch (e) { console.error('[ME] Ошибка инициализации:', e); }
  });

})();
