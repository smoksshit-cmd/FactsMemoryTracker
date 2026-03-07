/**
 * Facts Memory Tracker (FMT) — SillyTavern Extension
 * v1.3.4
 *
 * Changes in v1.3.4:
 *  - exportJson: file download button + copy, no await before Popup (same fix as SRT)
 *  - importJson: file picker button + textarea, same Popup timing fix
 *  - getMessages(): filters out hidden/system messages, lorebook injections,
 *    summarise entries — only real user↔char dialogue goes to the scan prompt
 */

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  const MODULE_KEY  = 'facts_memory_tracker';
  const PROMPT_TAG  = 'FMT_FACTS_MEMORY';
  const FAB_POS_KEY = 'fmt_fab_pos_v1';
  const FAB_MARGIN  = 8;

  const FACT_MARKER_RE      = /\[FACT:\s*([^\]|]+?)(?:\|\s*(characters|events|secrets|flashbacks))?\s*\]/gi;
  const FLASHBACK_MARKER_RE = /\[FLASHBACK:\s*([^\]]+?)\s*\]/gi;
  const FLASHBACK_TAG       = 'FMT_FLASHBACK_TRIGGER';

  const CATEGORIES = Object.freeze({
    characters: { label: 'Персонажи & Отношения', icon: '👤', short: 'ПЕРСОНАЖИ' },
    events:     { label: 'События & Последствия',  icon: '📅', short: 'СОБЫТИЯ'   },
    secrets:    { label: 'Секреты & Скрытое',       icon: '🔒', short: 'СЕКРЕТЫ'   },
    flashbacks: { label: 'Флешбэки & Прошлое',      icon: '🌀', short: 'ФЛЕШБЭКИ'  },
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
    fallbackEnabled:  true,
    flashEnabled:     true,
    flashChance:      0,
    flashCats:        ['flashbacks', 'secrets', 'characters'],
  });

  // Runtime
  let lastFabDragTs    = 0;
  let scanInProgress   = false;
  let msgSinceLastScan = 0;
  const collapsedCats  = {};
  let searchQuery      = '';
  let currentSortMode  = 'date';

  const flashQueue   = [];
  const flashHistory = [];
  const MAX_FLASH_HISTORY = 10;

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
    const chatId = (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null)
      || c.chatId || c.chat_id || 'unknown';
    const charId = c.characterId ?? c.groupId ?? 'unknown';
    return `fmt_v1__${charId}__${chatId}`;
  }

  function findExistingStateKey(chatMetadata) {
    const exact = chatKey();
    if (chatMetadata[exact]?.facts?.length) return exact;

    const c      = ctx();
    const charId = String(c.characterId ?? c.groupId ?? 'unknown');
    const prefix = `fmt_v1__${charId}__`;

    let bestKey  = null;
    let bestTime = 0;
    for (const k of Object.keys(chatMetadata)) {
      if (!k.startsWith(prefix)) continue;
      const state = chatMetadata[k];
      if (!Array.isArray(state?.facts) || !state.facts.length) continue;
      const lastTs = state.facts.reduce((mx, f) => Math.max(mx, f.ts || 0), 0);
      if (lastTs > bestTime) { bestTime = lastTs; bestKey = k; }
    }
    return bestKey;
  }

  function emptyState() {
    return { facts: [], lastScannedMsgIndex: 0, scanLog: [] };
  }

  async function getChatState(createIfMissing = false) {
    const { chatMetadata, saveMetadata } = ctx();

    const exact = chatKey();
    if (chatMetadata[exact]) {
      if (!chatMetadata[exact].scanLog) chatMetadata[exact].scanLog = [];
      return chatMetadata[exact];
    }

    const recovered = findExistingStateKey(chatMetadata);
    if (recovered) {
      chatMetadata[exact] = chatMetadata[recovered];
      if (!chatMetadata[exact].scanLog) chatMetadata[exact].scanLog = [];
      console.info(`[FMT] Факты восстановлены с ключа ${recovered} → ${exact}`);
      setTimeout(() => toastr.success(
        `🧠 FMT: факты восстановлены (${chatMetadata[exact].facts.length} шт.)`,
        'Восстановление данных',
        { timeOut: 5000 }
      ), 500);
      await saveMetadata();
      return chatMetadata[exact];
    }

    if (createIfMissing) {
      chatMetadata[exact] = emptyState();
      await saveMetadata();
    } else {
      return emptyState();
    }

    if (!chatMetadata[exact].scanLog) chatMetadata[exact].scanLog = [];
    return chatMetadata[exact];
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

  // ─── Download helper ──────────────────────────────────────────────────────────

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  // ─── Chat helpers ─────────────────────────────────────────────────────────────

  /**
   * Returns the last `count` REAL dialogue messages starting from `from`.
   *
   * Filtered OUT (never go to scan prompt):
   *  - is_system === true           → system / hidden messages inserted by ST
   *  - extra.type === 'summarize'   → built-in ST summarization entries
   *  - extra.isSmallSys             → small system injections
   *  - extra.isHidden               → hidden messages (e.g. deleted but kept)
   *  - extra.type === 'narrator'    → narrator / story-mode injections
   *  - mes starts with '<|' or '[inst' → raw instruction tokens leaking into chat
   *  - name contains '[' and ']'    → typical lorebook/WI injected pseudomessages
   *  - mes is empty / whitespace only
   */
  function isRealDialogueMessage(m) {
    if (!m) return false;
    // Skip system/hidden flags
    if (m.is_system)               return false;
    if (m.extra?.isSmallSys)       return false;
    if (m.extra?.isHidden)         return false;
    // Skip summarization and narrator entries
    const eType = m.extra?.type || '';
    if (eType === 'summarize')     return false;
    if (eType === 'narrator')      return false;
    if (eType === 'chat_background') return false;
    // Skip empty messages
    const mes = (m.mes || '').trim();
    if (!mes)                      return false;
    // Skip raw instruction tokens that sometimes leak
    if (mes.startsWith('<|') || mes.startsWith('[inst')) return false;
    // Skip lorebook/WI pseudomessages — their "name" field is typically wrapped in brackets
    const name = (m.name || '').trim();
    if (name.startsWith('[') && name.endsWith(']')) return false;
    return true;
  }

  function getMessages(from, count) {
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return { text: '', lastIdx: 0 };

    // Collect real dialogue messages in the requested range
    const slice = chat
      .slice(Math.max(0, from), from + count)
      .filter(isRealDialogueMessage);

    const text = slice.map(m =>
      `${m.is_user ? '{{user}}' : (m.name || '{{char}}')}: ${(m.mes || '').trim()}`
    ).join('\n\n');

    return { text, lastIdx: from + count };
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
      .replace(/\/+$/, '')
      .replace(/\/(chat\/completions|completions)$/, '')
      .replace(/\/v1$/, '');
  }

  async function fetchModels() {
    const base   = getBaseUrl();
    const apiKey = (getSettings().apiKey || '').trim();
    if (!base) throw new Error('Укажи Endpoint');

    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const candidates = [
      `${base}/v1/models`,
      `${base}/models`,
      `${base}/api/models`,
    ];

    for (const url of candidates) {
      try {
        const resp = await fetch(url, { headers });
        if (!resp.ok) continue;
        const data = await resp.json();
        const list = data.data || data.models || data.model_ids || data.available_models || [];
        const ids  = list.map(m => {
          if (typeof m === 'string') return m;
          return m.id || m.name || m.model_id || null;
        }).filter(Boolean).sort();
        if (ids.length) return ids;
      } catch {}
    }

    throw new Error('Список моделей недоступен. Введи модель вручную.');
  }

  async function testApiConnection() {
    const s    = getSettings();
    const base = getBaseUrl();
    if (!base) throw new Error('Endpoint не задан');

    const apiKey = (s.apiKey || '').trim();
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    const bodyBuilders = [
      (m) => ({ model: m, max_tokens: 5, temperature: 0,
        messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }] }),
      (m) => ({ model: m, max_tokens: 5, temperature: 0,
        messages: [{ role: 'user', content: 'hi' }] }),
    ];

    const endpoints = [
      `${base}/v1/chat/completions`,
      `${base}/chat/completions`,
      `${base}/v1/completions`,
    ];

    for (const url of endpoints) {
      for (const builder of bodyBuilders) {
        try {
          const resp = await fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify(builder(s.apiModel || 'gpt-4o-mini')),
          });
          if (resp.ok) {
            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content
              ?? data.choices?.[0]?.text
              ?? data.response
              ?? data.content;
            if (text !== undefined) return { url, builder };
          }
        } catch {}
      }
    }
    throw new Error('Ни один из эндпоинтов не ответил корректно');
  }

  let _workingApiConfig = null;

  async function aiGenerate(userPrompt, systemPrompt) {
    const s    = getSettings();
    const base = getBaseUrl();

    // ── Path 1: custom API (optional) ────────────────────────────────────────
    if (base) {
      const apiKey = (s.apiKey || '').trim();
      const headers = {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };

      if (_workingApiConfig?.base === base) {
        try {
          const result = await callApiWithConfig(_workingApiConfig, userPrompt, systemPrompt, headers);
          if (result?.trim()) return result;
        } catch {}
        _workingApiConfig = null;
      }

      const endpoints = [
        `${base}/v1/chat/completions`,
        `${base}/chat/completions`,
        `${base}/v1/completions`,
        `${base}/completions`,
      ];
      const bodyBuilders = [
        (m) => ({ model: m, max_tokens: 1024, temperature: 0.1,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
        (m) => ({ model: m, max_tokens: 1024, temperature: 0.1,
          messages: [{ role: 'user', content: `${systemPrompt}\n\n---\n\n${userPrompt}` }] }),
        (m) => ({ model: m, max_tokens: 1024, temperature: 0.1,
          prompt: `${systemPrompt}\n\n${userPrompt}` }),
      ];

      const model = s.apiModel || 'gpt-4o-mini';
      const errors = [];

      for (const url of endpoints) {
        for (const builder of bodyBuilders) {
          try {
            const resp = await fetch(url, {
              method: 'POST', headers, body: JSON.stringify(builder(model)),
            });
            if (!resp.ok) { errors.push(`HTTP ${resp.status} @ ${url}`); continue; }
            const data = await resp.json();
            const text = extractTextFromResponse(data);
            if (text?.trim()) {
              _workingApiConfig = { base, url, builder };
              return text;
            }
          } catch (e) {
            errors.push(`${e.message} @ ${url}`);
          }
        }
      }

      const errSummary = errors.slice(-2).join(' | ');
      if (s.fallbackEnabled === false) {
        throw new Error(`Кастовый API не ответил: ${errSummary}`);
      }
      console.warn(`[FMT] Кастовый API не ответил (${errSummary}) — используем ST`);
      toastr.warning('[FMT] Кастовый API недоступен — используется ST', '', { timeOut: 3000 });
    }

    // ── Path 2: ST generateRaw ────────────────────────────────────────────────
    const c = ctx();
    if (typeof c.generateRaw !== 'function') {
      throw new Error(
        'generateRaw недоступен в этой версии ST. ' +
        'Убедись что ST обновлён, или настрой кастовый API в разделе 🔌 API настроек FMT.'
      );
    }

    let result;
    try {
      result = await c.generateRaw(
        userPrompt,
        null,
        false,
        true,       // quietToChat = TRUE — ошибки не показываются в чате
        systemPrompt,
        true
      );
    } catch (e) {
      throw new Error(
        `Ошибка генерации через ST: ${e.message}. ` +
        'Проверь: 1) подключена ли модель в Chat Completion, 2) нет ли активного RP-чата который мешает.'
      );
    }

    if (!result?.trim()) {
      throw new Error(
        'Модель вернула пустой ответ. Возможные причины: ' +
        '1) модель не подключена в ST, ' +
        '2) контекст слишком большой — уменьши «Глубину» в настройках сканирования, ' +
        '3) модель не умеет возвращать чистый JSON — подключи кастовый API с GPT-4o или аналогом.'
      );
    }

    return result;
  }

  async function callApiWithConfig(cfg, userPrompt, systemPrompt, headers) {
    const s = getSettings();
    const resp = await fetch(cfg.url, {
      method: 'POST', headers,
      body: JSON.stringify(cfg.builder(s.apiModel || 'gpt-4o-mini')),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return extractTextFromResponse(data);
  }

  function extractTextFromResponse(data) {
    if (data.choices?.[0]?.message?.content !== undefined)
      return data.choices[0].message.content;
    if (data.choices?.[0]?.text !== undefined)
      return data.choices[0].text;
    if (typeof data.response === 'string') return data.response;
    if (typeof data.content  === 'string') return data.content;
    if (typeof data.text     === 'string') return data.text;
    if (data.message?.content !== undefined) return data.message.content;
    return null;
  }

  // ─── Extraction ───────────────────────────────────────────────────────────────

  function buildSystemPrompt(existingFacts) {
    const existing = existingFacts.length
      ? `\nСУЩЕСТВУЮЩИЕ ФАКТЫ — НЕ ДУБЛИРОВАТЬ:\n${existingFacts.map(f => `- [${f.category}] ${f.text}`).join('\n')}\n`
      : '';
    return `Ты — аналитик RP-диалогов. Извлекай важные факты из переписки.

ЧТО ЯВЛЯЕТСЯ ФАКТОМ: имена/роли/черты персонажей, отношения, события с последствиями, скрытые мотивы, секреты, компромат, решения.
ЧТО НЕ ЯВЛЯЕТСЯ: атмосфера без сюжетного значения, действия без последствий, общие эмоции.

КАТЕГОРИИ:
- characters — персонажи, отношения, внешность, черты характера, прошлое
- events     — произошедшие события, решения, последствия
- secrets    — тайны, скрытые мотивы, компромат
- flashbacks — воспоминания персонажа из прошлого: когда {{char}} вспоминает что-то, видит образы, упоминает давние события или травмы. Это ОТДЕЛЬНАЯ категория — не путай с events.

ВАЖНОСТЬ: high (ключевой) | medium (полезный контекст) | low (второстепенный)
Текст факта: до 15 слов, третье лицо.
Верни ТОЛЬКО валидный JSON-массив без преамбулы и markdown:
[{"category":"characters|events|secrets|flashbacks","text":"факт","importance":"high|medium|low"}]
Если нет новых фактов — верни [].${existing}`;
  }

  function parseFactsJson(raw) {
    if (!raw) return null;

    const clean = raw.replace(/```json|```/gi, '').trim();
    try {
      const p = JSON.parse(clean);
      if (Array.isArray(p)) return p;
    } catch {}

    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        const p = JSON.parse(match[0]);
        if (Array.isArray(p)) return p;
      } catch {}
    }

    const matchMulti = raw.match(/\[[\s\S]+\]/);
    if (matchMulti) {
      try {
        const p = JSON.parse(matchMulti[0]);
        if (Array.isArray(p)) return p;
      } catch {}
    }

    return null;
  }

  async function extractFacts(fromIdx, toIdx) {
    const state = await getChatState(true);
    const { text } = getMessages(fromIdx, toIdx - fromIdx);
    if (!text.trim()) return 0;

    const charCard = getCharacterCard();
    const system   = buildSystemPrompt(state.facts);
    const user     = `${charCard ? `КАРТОЧКА ПЕРСОНАЖА:\n${charCard}\n\n` : ''}━━━ СООБЩЕНИЯ ━━━\n${text}\n\nИзвлеки новые факты. Верни JSON-массив.`;

    const raw   = await aiGenerate(user, system);
    if (!raw) return 0;

    const parsed = parseFactsJson(raw);
    if (!parsed) {
      const preview = raw.slice(0, 200).replace(/\n/g, ' ');
      console.warn(`[FMT] Модель вернула не-JSON: «${preview}»`);
      throw new Error(
        `Модель вернула ответ не в формате JSON. Первые символы: «${raw.slice(0, 80)}». ` +
        'Попробуй другую модель или кастовый API с более умной моделью (GPT-4o, Claude и т.д.)'
      );
    }

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

    const state = await getChatState(true);
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

  async function detectFlashbackMarkers(messageText) {
    const s = getSettings();
    if (!s.autoMarker || !messageText) return;
    const matches = [...messageText.matchAll(FLASHBACK_MARKER_RE)];
    if (!matches.length) return;

    const state = await getChatState(true);
    const pool  = state.facts.map(f => f.text);
    const SIM   = 0.40;
    let changed = false;

    for (const m of matches) {
      const text = m[1].trim();
      if (!text || pool.some(ex => similarity(ex, text) >= SIM)) continue;
      state.facts.unshift({
        id: makeId(), category: 'flashbacks', text,
        importance: 'medium', msgIdx: 0, ts: Date.now(),
      });
      pool.push(text);
      changed = true;
      toastr.info(`🌀 Флешбэк: «${text}»`, 'FMT Флешбэк', { timeOut: 5000 });
    }

    if (changed) {
      await ctx().saveMetadata();
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();
    }
  }

  async function runScan(mode = 'manual') {
    if (scanInProgress) { toastr.warning('[FMT] Сканирование уже идёт…'); return; }

    const settings = getSettings();

    const c    = ctx();
    const chat = c.chat ?? c.getChat?.() ?? [];
    if (!Array.isArray(chat) || !chat.length) {
      toastr.warning('[FMT] История чата пуста или ещё не загружена. Попробуй через секунду.');
      return;
    }

    scanInProgress = true;
    const $btn = $('#fmt_scan_btn, #fmt_scan_settings_btn');
    $btn.prop('disabled', true).text('⏳ Анализ…');

    try {
      const state   = await getChatState(true);
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

  // ─── Range scan ───────────────────────────────────────────────────────────────

  async function runScanRange() {
    const c    = ctx();
    const chat = c.chat ?? c.getChat?.() ?? [];
    if (!Array.isArray(chat) || !chat.length) {
      toastr.warning('[FMT] История чата пуста или ещё не загружена.');
      return;
    }

    const total = chat.length;

    // No await — same Popup timing fix
    c.Popup.show.text('🎯 FMT — Сканировать диапазон',
      `<div style="font-size:13px;color:#c8deff">
        <div style="margin-bottom:12px;opacity:.75">
          Всего сообщений в чате: <b style="color:#90b8f8">${total}</b><br>
          <span style="font-size:11px;opacity:.7">Нумерация с 1. Скрытые сообщения и саммари пропускаются автоматически.</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.05em">От сообщения №</label>
            <input id="fmt_range_from" type="number" min="1" max="${total}" value="1"
              style="width:90px;padding:7px 10px;border-radius:8px;border:1px solid rgba(100,160,255,0.3);background:rgba(5,12,25,.9);color:#d8e8ff;font-size:14px;font-weight:700;text-align:center">
          </div>
          <div style="font-size:20px;opacity:.4;padding-top:18px">→</div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.05em">До сообщения №</label>
            <input id="fmt_range_to" type="number" min="1" max="${total}" value="${total}"
              style="width:90px;padding:7px 10px;border-radius:8px;border:1px solid rgba(100,160,255,0.3);background:rgba(5,12,25,.9);color:#d8e8ff;font-size:14px;font-weight:700;text-align:center">
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <label style="font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.05em">Сообщений</label>
            <div id="fmt_range_count"
              style="width:56px;padding:7px 10px;border-radius:8px;border:1px solid rgba(100,160,255,0.1);background:rgba(100,160,255,0.06);color:#90b8f8;font-size:14px;font-weight:700;text-align:center">
              ${total}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <button class="fmt-range-preset" data-preset="last50"
            style="padding:5px 10px;border-radius:6px;border:1px solid rgba(100,160,255,0.2);background:rgba(100,160,255,0.08);color:#90b8f8;cursor:pointer;font-size:11px">
            Последние 50
          </button>
          <button class="fmt-range-preset" data-preset="last100"
            style="padding:5px 10px;border-radius:6px;border:1px solid rgba(100,160,255,0.2);background:rgba(100,160,255,0.08);color:#90b8f8;cursor:pointer;font-size:11px">
            Последние 100
          </button>
          <button class="fmt-range-preset" data-preset="all"
            style="padding:5px 10px;border-radius:6px;border:1px solid rgba(100,160,255,0.2);background:rgba(100,160,255,0.08);color:#90b8f8;cursor:pointer;font-size:11px">
            Весь чат
          </button>
          <button class="fmt-range-preset" data-preset="first50"
            style="padding:5px 10px;border-radius:6px;border:1px solid rgba(100,160,255,0.2);background:rgba(100,160,255,0.08);color:#90b8f8;cursor:pointer;font-size:11px">
            Первые 50
          </button>
        </div>
        <button id="fmt_range_go"
          style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(80,200,140,0.5);background:rgba(60,180,120,0.15);color:#70e8c0;cursor:pointer;font-size:13px;font-weight:700;margin-top:2px">
          🔍 Сканировать диапазон
        </button>
        <div id="fmt_range_status" style="margin-top:8px;font-size:11px;min-height:14px;text-align:center"></div>
      </div>`
    );

    setTimeout(() => {
      const $from   = $('#fmt_range_from');
      const $to     = $('#fmt_range_to');
      const $count  = $('#fmt_range_count');
      const $status = $('#fmt_range_status');

      const updateCount = () => {
        const f = parseInt($from.val()) || 1;
        const t = parseInt($to.val())   || total;
        const n = Math.max(0, t - f + 1);
        $count.text(n);
        $count.css('color', n > 0 ? '#90b8f8' : '#ff7070');
      };

      $from.on('input', updateCount);
      $to.on('input',   updateCount);

      // Preset buttons
      document.querySelectorAll('.fmt-range-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          const preset = btn.getAttribute('data-preset');
          if (preset === 'last50')  { $from.val(Math.max(1, total - 49)); $to.val(total); }
          if (preset === 'last100') { $from.val(Math.max(1, total - 99)); $to.val(total); }
          if (preset === 'all')     { $from.val(1); $to.val(total); }
          if (preset === 'first50') { $from.val(1); $to.val(Math.min(total, 50)); }
          updateCount();
        });
      });

      document.getElementById('fmt_range_go')?.addEventListener('click', async () => {
        const fromNum = parseInt($from.val()) || 1;
        const toNum   = parseInt($to.val())   || total;

        if (fromNum > toNum) {
          $status.css('color', '#ff7070').text('❌ «От» не может быть больше «До»');
          return;
        }
        if (fromNum < 1 || toNum > total) {
          $status.css('color', '#ff7070').text(`❌ Допустимый диапазон: 1 – ${total}`);
          return;
        }

        const fromIdx = fromNum - 1; // convert 1-based UI → 0-based array
        const toIdx   = toNum;       // slice end is exclusive, so toNum is correct

        if (scanInProgress) { $status.css('color', '#ca3').text('⏳ Сканирование уже идёт…'); return; }

        const $goBtn = $('#fmt_range_go');
        $goBtn.prop('disabled', true).text('⏳ Анализ…');
        $status.css('color', 'rgba(180,200,240,.6)').text(`Сканирую сообщения ${fromNum}–${toNum}…`);
        scanInProgress = true;

        try {
          const added = await extractFacts(fromIdx, toIdx);
          const state = await getChatState(true);
          state.scanLog.unshift({ ts: Date.now(), added, from: fromIdx, to: toIdx, mode: 'range' });
          if (state.scanLog.length > 20) state.scanLog.length = 20;

          await c.saveMetadata();
          await updateInjectedPrompt();
          await renderWidget();
          if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();

          if (added === 0) {
            $status.css('color', '#888').text('Новых фактов не найдено в этом диапазоне');
          } else {
            $status.css('color', '#70e8c0').text(`✅ Извлечено: ${added} фактов`);
            toastr.success(`✅ Диапазон ${fromNum}–${toNum}: <b>${added}</b> фактов`, 'FMT', { timeOut: 5000, escapeHtml: false });
          }
        } catch (e) {
          $status.css('color', '#ff7070').text(`❌ ${e.message}`);
          toastr.error(`[FMT] ${e.message}`);
        } finally {
          scanInProgress = false;
          $goBtn.prop('disabled', false).text('🔍 Сканировать диапазон');
        }
      });
    }, 0);
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
    btn.style.transform       = `scale(${scale})`;
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
          <button class="fmt-filter-btn" data-cat="flashbacks">🌀</button>
          <span class="fmt-filter-sep">|</span>
          <button class="fmt-filter-btn" data-imp="high">🔴</button>
          <button class="fmt-filter-btn" data-imp="medium">🟡</button>
          <button class="fmt-filter-btn" data-imp="low">⚪</button>
        </div>

        <div class="content" id="fmt_content"></div>
        <div id="fmt_flash_panel" style="display:none"></div>

        <div class="footer">
          <button type="button" id="fmt_scan_btn">🔍 Сканировать</button>
          <button type="button" id="fmt_scan_range_btn" title="Выбрать диапазон сообщений для сканирования">🎯 Диапазон</button>
          <button type="button" id="fmt_flashback_btn" title="Случайный флешбек из фактов">⚡ Флешбек</button>
          <button type="button" id="fmt_export_btn">📤 Экспорт</button>
          <button type="button" id="fmt_import_btn">📥 Импорт</button>
          <button type="button" id="fmt_show_prompt_btn">Промпт</button>
          <button type="button" id="fmt_scanlog_btn">📋 Лог</button>
          <button type="button" id="fmt_recover_btn" title="Найти факты под другим ключом (если слетели)">🔄 Восстановить</button>
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
      .on('click.fmt_actions', '#fmt_scan_range_btn',  () => runScanRange())
      .on('click.fmt_actions', '#fmt_flashback_btn',   () => triggerFlashback())
      .on('click.fmt_actions', '#fmt_show_prompt_btn', () => showPromptPreview())
      .on('click.fmt_actions', '#fmt_recover_btn',     () => recoverFacts())
      .on('click.fmt_actions', '#fmt_clear_btn',       () => clearAllFacts())
      .on('click.fmt_actions', '#fmt_export_btn',      () => exportJson())
      .on('click.fmt_actions', '#fmt_import_btn',      () => importJson())
      .on('click.fmt_actions', '#fmt_scanlog_btn',     () => showScanLog());

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
      renderFlashQueueUI();
    } else {
      drawer.classList.remove('fmt-open');
      drawer.setAttribute('aria-hidden', 'true');
      const ov = document.getElementById('fmt_overlay');
      if (ov) ov.style.display = 'none';
    }
  }

  function sortFacts(facts) {
    const impOrder = { high: 2, medium: 1, low: 0 };
    const catOrder = { characters: 0, events: 1, secrets: 2, flashbacks: 3 };
    const mode = currentSortMode || 'date';
    const copy = [...facts];
    if (mode === 'importance')
      copy.sort((a, b) => (impOrder[b.importance] - impOrder[a.importance]) || (b.ts||0) - (a.ts||0));
    else if (mode === 'category')
      copy.sort((a, b) => ((catOrder[a.category] ?? 99) - (catOrder[b.category] ?? 99)) || (b.ts||0) - (a.ts||0));
    else
      copy.sort((a, b) => (b.ts||0) - (a.ts||0));
    return copy;
  }

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
        <button class="fmt-flash-btn" data-id="${fact.id}" title="Использовать этот факт как флешбек">⚡</button>
        <button class="fmt-toggle-btn" data-id="${fact.id}" title="${dis ? 'Включить' : 'Отключить'}">${dis ? '▶' : '⏸'}</button>
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

    $('#fmt_subtitle').text(`${charName} · ${total} фактов · ${active} активных`);

    const block  = buildInjectedBlock(state, settings);
    const tokens = estimateTokens(block);
    const maxF   = settings.maxInjectFacts || 30;
    $('#fmt_token_bar').html(
      block
        ? `<span class="fmt-tok-label">Инъекция: ~<b>${tokens}</b> токенов · ${active}/${maxF} фактов</span>`
        : `<span class="fmt-tok-label fmt-tok-empty">Инъекция пуста — нет активных фактов выше порога</span>`
    );

    currentSortMode = settings.sortMode || 'date';
    const $sortSel = $('#fmt_sort_select');
    if ($sortSel.length) $sortSel.val(currentSortMode);

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
        const isColl    = !!collapsedCats[cat];
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

    $(document).off('click.fmt_collapse').on('click.fmt_collapse', '.fmt-cat-header', function () {
      const cat = this.getAttribute('data-collapse-cat');
      if (!cat) return;
      collapsedCats[cat] = !collapsedCats[cat];
      $(this).next('.fmt-cat-body').toggleClass('fmt-cat-collapsed', collapsedCats[cat]);
      $(this).find('.fmt-cat-chevron').text(collapsedCats[cat] ? '▸' : '▾');
    });

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

    $(document).off('change.fmt_inlinecat').on('change.fmt_inlinecat', '.fmt-inline-cat', async function () {
      await updateFactField(this.getAttribute('data-id'), 'category', this.value);
    });
    $(document).off('change.fmt_inlineimp').on('change.fmt_inlineimp', '.fmt-inline-imp', async function () {
      await updateFactField(this.getAttribute('data-id'), 'importance', this.value);
    });

    $(document).off('click.fmt_flash_row').on('click.fmt_flash_row', '.fmt-flash-btn', async function (e) {
      e.stopPropagation();
      await triggerFlashback(this.getAttribute('data-id'));
    });

    $(document).off('click.fmt_toggle').on('click.fmt_toggle', '.fmt-toggle-btn', async function (e) {
      e.stopPropagation();
      await toggleDisableFact(this.getAttribute('data-id'));
    });

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
    const state = await getChatState(true);
    state.facts.unshift({ id: makeId(), category, text, importance, msgIdx: 0, ts: Date.now() });
    $('#fmt_add_text').val('');
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
  }

  async function updateFactField(id, field, value) {
    const state = await getChatState(true);
    const fact  = state.facts.find(f => f.id === id);
    if (!fact) return;
    fact[field] = value;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
  }

  async function toggleDisableFact(id) {
    const state = await getChatState(true);
    const fact  = state.facts.find(f => f.id === id);
    if (!fact) return;
    fact.disabled = !fact.disabled;
    const row = document.querySelector(`.fmt-fact-row[data-id="${id}"]`);
    if (row) {
      row.classList.toggle('fmt-fact-disabled', fact.disabled);
      const btn = row.querySelector('.fmt-toggle-btn');
      if (btn) { btn.textContent = fact.disabled ? '▶' : '⏸'; btn.title = fact.disabled ? 'Включить' : 'Отключить'; }
    }
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderWidget();
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
    const state = await getChatState(true);
    const idx   = state.facts.findIndex(f => f.id === id);
    if (idx >= 0) state.facts.splice(idx, 1);
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
  }

  async function recoverFacts() {
    const { chatMetadata, saveMetadata } = ctx();
    const exact  = chatKey();
    const c      = ctx();
    const charId = String(c.characterId ?? c.groupId ?? 'unknown');
    const prefix = `fmt_v1__${charId}__`;

    const candidates = Object.keys(chatMetadata)
      .filter(k => k.startsWith(prefix) && Array.isArray(chatMetadata[k]?.facts) && chatMetadata[k].facts.length)
      .sort((a, b) => {
        const ta = chatMetadata[a].facts.reduce((mx, f) => Math.max(mx, f.ts || 0), 0);
        const tb = chatMetadata[b].facts.reduce((mx, f) => Math.max(mx, f.ts || 0), 0);
        return tb - ta;
      });

    if (!candidates.length) {
      toastr.warning('[FMT] Сохранённых фактов для этого персонажа не найдено ни под одним ключом');
      return;
    }

    const bestKey   = candidates[0];
    const bestState = chatMetadata[bestKey];
    const n         = bestState.facts.length;

    if (bestKey === exact) {
      toastr.info(`[FMT] Данные уже актуальны (${n} фактов)`);
      return;
    }

    chatMetadata[exact] = bestState;
    await saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
    toastr.success(`✅ Восстановлено ${n} фактов!`, 'FMT', { timeOut: 5000 });
  }

  async function clearAllFacts() {
    const { Popup } = ctx();
    const ok = await Popup.show.confirm('Очистить все факты?', 'Действие нельзя отменить.');
    if (!ok) return;
    const state = await getChatState(true);
    state.facts = []; state.lastScannedMsgIndex = 0;
    await ctx().saveMetadata();
    await updateInjectedPrompt();
    await renderDrawer();
    await renderWidget();
    toastr.success('Все факты удалены');
  }

  // ─── Export ───────────────────────────────────────────────────────────────────
  // BUG FIX (same as SRT): removed `await` before Popup.show.text() —
  // the promise resolves when popup is CLOSED, so handlers must be attached
  // via setTimeout(0) after the popup renders, not after await.

  async function exportJson() {
    const state    = await getChatState();
    const charName = getActiveCharName();
    const ts       = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const filename = `fmt_${charName.replace(/[^a-zа-яёA-ZА-ЯЁ0-9]/gi, '_').slice(0, 30)}_${ts}.json`;
    const json     = JSON.stringify(state, null, 2);
    const total    = state.facts.length;

    // ← NO await: promise resolves on popup close, not open
    ctx().Popup.show.text('📤 FMT — Экспорт фактов',
      `<div style="font-family:Consolas,monospace;font-size:12px">
        <div style="margin-bottom:10px;opacity:.8">
          Персонаж: <b>${escHtml(charName)}</b> · Фактов всего: <b>${total}</b>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button id="fmt_export_download"
            style="padding:8px 14px;background:rgba(80,180,140,0.15);border:1px solid rgba(80,180,140,0.5);color:#70e8c0;border-radius:8px;cursor:pointer;font-size:13px">
            ⬇️ Скачать файл
          </button>
          <button id="fmt_export_copy"
            style="padding:8px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.2);color:#c8deff;border-radius:8px;cursor:pointer;font-size:13px">
            📋 Скопировать JSON
          </button>
        </div>
        <pre style="white-space:pre-wrap;max-height:50vh;overflow:auto;background:rgba(5,12,25,0.85);color:#c8deff;padding:10px;border-radius:8px;font-size:11px">${escHtml(json)}</pre>
      </div>`
    );

    // Give the browser one tick to render popup DOM before attaching handlers
    setTimeout(() => {
      document.getElementById('fmt_export_download')?.addEventListener('click', () => {
        downloadJson(filename, state);
        toastr.success(`Файл "${filename}" сохранён`);
      });
      document.getElementById('fmt_export_copy')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(json).then(
          () => toastr.success('JSON скопирован в буфер обмена'),
          () => toastr.error('Не удалось скопировать — выдели текст вручную')
        );
      });
    }, 0);
  }

  // ─── Import ───────────────────────────────────────────────────────────────────
  // Same fix: no await before Popup, handlers via setTimeout(0)

  async function importJson() {
    // ← NO await
    ctx().Popup.show.text('📥 FMT — Импорт фактов',
      `<div style="font-family:Consolas,monospace;font-size:12px">
        <div style="margin-bottom:10px;font-weight:700;opacity:.9">Загрузить из файла или вставить JSON:</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <button id="fmt_import_file_btn"
            style="padding:8px 14px;background:rgba(52,152,219,0.15);border:1px solid rgba(52,152,219,0.5);color:#5dade2;border-radius:8px;cursor:pointer;font-size:13px">
            📁 Выбрать файл (.json)
          </button>
        </div>
        <input type="file" id="fmt_import_file_input" accept=".json,application/json" style="display:none">
        <textarea id="fmt_import_textarea"
          placeholder="…или вставь JSON сюда вручную (экспорт из FMT)"
          style="width:100%;height:140px;background:rgba(5,12,25,0.85);border:1px solid rgba(100,160,255,0.2);color:#c8deff;border-radius:8px;padding:8px;font-family:Consolas,monospace;font-size:11px;resize:vertical;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button id="fmt_import_apply"
            style="padding:8px 14px;background:rgba(80,180,140,0.15);border:1px solid rgba(80,180,140,0.5);color:#70e8c0;border-radius:8px;cursor:pointer;font-size:13px">
            ⬆️ Применить JSON
          </button>
          <span id="fmt_import_status" style="font-size:11px;opacity:.75"></span>
        </div>
      </div>`
    );

    setTimeout(() => {
      // File picker button
      document.getElementById('fmt_import_file_btn')?.addEventListener('click', () => {
        document.getElementById('fmt_import_file_input')?.click();
      });

      // Read selected file into textarea
      document.getElementById('fmt_import_file_input')?.addEventListener('change', (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const ta = document.getElementById('fmt_import_textarea');
          if (ta) ta.value = e.target.result;
          const st = document.getElementById('fmt_import_status');
          if (st) st.textContent = `📄 Загружен: ${file.name}`;
        };
        reader.onerror = () => toastr.error('Не удалось прочитать файл');
        reader.readAsText(file);
      });

      // Apply JSON from textarea
      document.getElementById('fmt_import_apply')?.addEventListener('click', async () => {
        const raw = document.getElementById('fmt_import_textarea')?.value?.trim();
        if (!raw) { toastr.warning('Вставьте JSON или выберите файл'); return; }
        try {
          const { saveMetadata, chatMetadata } = ctx();
          const p = JSON.parse(raw);
          if (!p || typeof p !== 'object') throw new Error('Not an object');
          p.facts               = Array.isArray(p.facts)  ? p.facts  : [];
          p.lastScannedMsgIndex = p.lastScannedMsgIndex   || 0;
          p.scanLog             = Array.isArray(p.scanLog) ? p.scanLog : [];
          chatMetadata[chatKey()] = p;
          await saveMetadata();
          await updateInjectedPrompt();
          await renderDrawer();
          await renderWidget();
          toastr.success(`✅ Импортировано ${p.facts.length} фактов`);
          const st = document.getElementById('fmt_import_status');
          if (st) st.textContent = `✅ Готово (${p.facts.length} фактов)`;
        } catch (e) {
          toastr.error('[FMT] Неверный JSON: ' + e.message);
          const st = document.getElementById('fmt_import_status');
          if (st) st.textContent = `❌ ${e.message}`;
        }
      });
    }, 0);
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

    const secState = (() => {
      try { return JSON.parse(localStorage.getItem('fmt_sec_state') || '{}'); } catch { return {}; }
    })();
    const saveSec = () => { try { localStorage.setItem('fmt_sec_state', JSON.stringify(secState)); } catch {} };

    const sec = (id, icon, title, content, defaultOpen = false) => {
      const open = secState[id] !== undefined ? secState[id] : defaultOpen;
      return `
        <div class="fmt-sec" id="fmt_sec_${id}">
          <div class="fmt-sec-hdr" data-sec="${id}">
            <span class="fmt-sec-chev">${open ? '▾' : '▸'}</span>
            <span>${icon} ${title}</span>
          </div>
          <div class="fmt-sec-body"${open ? '' : ' style="display:none"'}>${content}</div>
        </div>`;
    };

    const secBasic = `
      <div class="fmt-2col">
        <label class="fmt-ck"><input type="checkbox" id="fmt_enabled" ${s.enabled?'checked':''}><span>Инъекция в промпт</span></label>
        <label class="fmt-ck"><input type="checkbox" id="fmt_show_widget" ${s.showWidget?'checked':''}><span>Виджет 🧠</span></label>
      </div>
      <div class="fmt-srow fmt-slider-row">
        <label>Размер виджета:</label>
        <input type="range" id="fmt_fab_scale" min="0.4" max="1.4" step="0.1" value="${s.fabScale??0.8}">
        <span id="fmt_fab_scale_val">${Math.round((s.fabScale??0.8)*100)}%</span>
      </div>
      <div class="fmt-compact-btns">
        <button class="menu_button" id="fmt_open_drawer_btn">📂 Открыть трекер</button>
        <button class="menu_button" id="fmt_scan_settings_btn">🔍 Сканировать</button>
        <button class="menu_button" id="fmt_reset_pos_btn">↺ Позиция</button>
      </div>`;

    const secScan = `
      <div class="fmt-2col">
        <label class="fmt-ck"><input type="checkbox" id="fmt_auto_scan" ${s.autoScan?'checked':''}><span>Авто-скан</span></label>
        <label class="fmt-ck"><input type="checkbox" id="fmt_auto_marker" ${s.autoMarker?'checked':''}><span>Авто-маркер [FACT:]</span></label>
      </div>
      <div class="fmt-srow fmt-slider-row">
        <label>Каждые:</label>
        <input type="range" id="fmt_auto_every" min="5" max="100" step="5" value="${s.autoScanEvery}">
        <span id="fmt_auto_every_val">${s.autoScanEvery}</span><span style="opacity:.5;font-size:10px">сообщ.</span>
      </div>
      <div class="fmt-srow fmt-slider-row">
        <label>Глубина:</label>
        <input type="range" id="fmt_scan_depth" min="10" max="200" step="10" value="${s.scanDepth}">
        <span id="fmt_scan_depth_val">${s.scanDepth}</span><span style="opacity:.5;font-size:10px">сообщ.</span>
      </div>
      <div style="font-size:10px;color:rgba(120,220,160,.55);margin-top:4px;line-height:1.5">
        ⚠️ Скрытые сообщения, саммари и лорбуки автоматически исключаются из сканирования.
      </div>`;

    const secInject = `
      <div class="fmt-srow">
        <label style="white-space:nowrap;font-size:12px">Важность ≥</label>
        <select id="fmt_inject_imp" style="flex:1">
          <option value="low" ${s.injectImportance==='low'?'selected':''}>⚪ Все</option>
          <option value="medium" ${s.injectImportance==='medium'?'selected':''}>🟡 Medium+</option>
          <option value="high" ${s.injectImportance==='high'?'selected':''}>🔴 High only</option>
        </select>
      </div>
      <div class="fmt-srow fmt-slider-row">
        <label>Макс. фактов:</label>
        <input type="range" id="fmt_max_facts" min="5" max="100" step="5" value="${s.maxInjectFacts||30}">
        <span id="fmt_max_facts_val">${s.maxInjectFacts||30}</span>
      </div>
      <div style="margin-top:6px">
        <div style="font-size:10px;color:rgba(180,200,240,.5);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">Шаблон промпта <code style="background:rgba(100,160,255,.1);padding:1px 4px;border-radius:3px">{{facts}}</code></div>
        <textarea id="fmt_prompt_tpl" rows="3">${escHtml(s.promptTemplate||DEFAULT_PROMPT_TEMPLATE)}</textarea>
        <button class="menu_button" id="fmt_reset_tpl_btn" style="margin-top:3px;padding:3px 8px;font-size:10px">↩ Сброс</button>
      </div>`;

    const flashCats = s.flashCats || ['flashbacks','secrets','characters'];
    const secFlash = `
      <div class="fmt-2col">
        <label class="fmt-ck"><input type="checkbox" id="fmt_flash_enabled" ${s.flashEnabled!==false?'checked':''}><span>Включён</span></label>
      </div>
      <div class="fmt-srow fmt-slider-row">
        <label>Авто-шанс:</label>
        <input type="range" id="fmt_flash_chance" min="0" max="30" step="1" value="${s.flashChance||0}">
        <span id="fmt_flash_chance_val">${s.flashChance||0}%</span>
      </div>
      <div style="font-size:11px;color:rgba(180,200,240,.6);margin:4px 0 3px">Категории для флешбека:</div>
      <div class="fmt-2col">
        ${Object.entries(CATEGORIES).map(([k,v])=>`
          <label class="fmt-ck"><input type="checkbox" class="fmt-flash-cat-cb" value="${k}" ${flashCats.includes(k)?'checked':''}><span>${v.icon} ${v.label}</span></label>`).join('')}
      </div>
      <div style="font-size:10px;color:rgba(180,200,240,.4);margin-top:4px;line-height:1.5">
        Кнопка ⚡ в трекере — ручной запуск. Авто-шанс срабатывает на каждое сообщение юзера.
      </div>`;

    const hasCustomApi = !!(s.apiEndpoint || '').trim();
    const secApi = `
      <div class="fmt-api-mode-bar">
        <div class="fmt-api-mode-label">Источник генерации:</div>
        <div class="fmt-api-mode-btns">
          <button class="fmt-api-mode-btn ${!hasCustomApi?'active':''}" data-mode="st">🟢 ST (текущий)</button>
          <button class="fmt-api-mode-btn ${hasCustomApi?'active':''}" data-mode="custom">🔌 Кастомный API</button>
        </div>
      </div>
      <div id="fmt_mode_st" ${hasCustomApi?'style="display:none"':''}>
        <div class="fmt-api-st-info">
          ✅ FMT использует модель которая сейчас подключена в SillyTavern.<br>
          Никаких дополнительных настроек не нужно — всё работает из коробки.
        </div>
      </div>
      <div id="fmt_mode_custom" ${!hasCustomApi?'style="display:none"':''}>
        <div style="font-size:10px;color:rgba(100,220,160,.6);margin-bottom:7px;line-height:1.5">
          Отдельный API для сканирования. Авто-перебор эндпоинтов и форматов.
        </div>
        <div class="fmt-2col" style="margin-bottom:6px">
          <label class="fmt-ck"><input type="checkbox" id="fmt_fallback_enabled" ${s.fallbackEnabled!==false?'checked':''}><span>Fallback на ST если недоступен</span></label>
        </div>
        <input type="text" id="fmt_api_endpoint" class="fmt-api-field" placeholder="http://localhost:1234/v1 или https://api.openai.com" value="${escHtml(s.apiEndpoint||'')}">
        <div class="fmt-srow" style="gap:5px;margin-top:4px">
          <input type="password" id="fmt_api_key" class="fmt-api-field" placeholder="API Key (необязателен)" value="${s.apiKey||''}" style="margin-bottom:0;flex:1">
          <button type="button" id="fmt_api_key_toggle" class="menu_button" style="padding:4px 8px;flex-shrink:0">👁</button>
        </div>
        <div class="fmt-srow" style="gap:5px;margin-top:4px">
          <select id="fmt_api_model" class="fmt-api-select" style="flex:1">
            ${s.apiModel?`<option value="${escHtml(s.apiModel)}" selected>${escHtml(s.apiModel)}</option>`:'<option value="">-- введи или загрузи 🔄 --</option>'}
          </select>
          <button type="button" id="fmt_refresh_models" class="menu_button" style="padding:4px 8px;flex-shrink:0" title="Загрузить список моделей">🔄</button>
        </div>
        <div class="fmt-srow" style="gap:5px;margin-top:4px">
          <input type="text" id="fmt_api_model_manual" class="fmt-api-field" placeholder="Или введи модель вручную (gpt-4o-mini, llama3 и т.д.)" value="${s.apiModel||''}" style="margin-bottom:0;flex:1">
        </div>
        <div class="fmt-srow" style="gap:5px;margin-top:6px">
          <button type="button" id="fmt_test_api" class="menu_button" style="flex:1;padding:5px 8px;font-size:11px">🔌 Тест соединения</button>
        </div>
        <div id="fmt_api_status" style="margin-top:5px;font-size:10px;min-height:14px"></div>
      </div>`;

    $(target).append(`
      <div class="fmt-settings-block" id="fmt_settings_block">
        <div class="fmt-settings-title">
          <span>🧠 Память фактов</span>
          <button type="button" id="fmt_collapse_btn">${s.collapsed?'▸':'▾'}</button>
        </div>
        <div class="fmt-settings-body"${s.collapsed?' style="display:none"':''}>
          ${sec('basic',  '⚙️', 'Основное',    secBasic,  true)}
          ${sec('scan',   '🔍', 'Сканирование', secScan,   false)}
          ${sec('inject', '💉', 'Инъекция',     secInject, false)}
          ${sec('flash',  '⚡', 'Флешбек',      secFlash,  false)}
          ${sec('api',    '🔌', 'API',          secApi,    false)}
        </div>
      </div>
    `);

    $(document).off('click.fmt_sec').on('click.fmt_sec', '.fmt-sec-hdr', function () {
      const id   = this.getAttribute('data-sec');
      const body = $(this).next('.fmt-sec-body');
      const open = body.is(':visible');
      body.toggle(!open);
      $(this).find('.fmt-sec-chev').text(open ? '▸' : '▾');
      secState[id] = !open;
      saveSec();
    });

    $('#fmt_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#fmt_settings_block .fmt-settings-body').toggle(!s.collapsed);
      $('#fmt_collapse_btn').text(s.collapsed ? '▸' : '▾');
      ctx().saveSettingsDebounced();
    });

    $('#fmt_enabled').on('input',    async ev => { s.enabled    = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });
    $('#fmt_show_widget').on('input',async ev => { s.showWidget = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); await renderWidget(); });
    $('#fmt_auto_scan').on('input',       ev => { s.autoScan   = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#fmt_auto_marker').on('input',     ev => { s.autoMarker = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });

    $('#fmt_fab_scale').on('input', ev => {
      const v = parseFloat($(ev.currentTarget).val());
      s.fabScale = v;
      $('#fmt_fab_scale_val').text(Math.round(v * 100) + '%');
      ctx().saveSettingsDebounced();
      applyFabScale();
      applyFabPosition();
    });

    $('#fmt_auto_every').on('input', ev => { const v = +$(ev.currentTarget).val(); s.autoScanEvery  = v; $('#fmt_auto_every_val').text(v);  ctx().saveSettingsDebounced(); });
    $('#fmt_scan_depth').on('input', ev => { const v = +$(ev.currentTarget).val(); s.scanDepth      = v; $('#fmt_scan_depth_val').text(v);  ctx().saveSettingsDebounced(); });
    $('#fmt_max_facts').on('input',  ev => { const v = +$(ev.currentTarget).val(); s.maxInjectFacts = v; $('#fmt_max_facts_val').text(v);   ctx().saveSettingsDebounced(); });

    $('#fmt_inject_imp').on('change', async ev => { s.injectImportance = $(ev.currentTarget).val(); ctx().saveSettingsDebounced(); await updateInjectedPrompt(); });

    $('#fmt_flash_enabled').on('input', ev => { s.flashEnabled = $(ev.currentTarget).prop('checked'); ctx().saveSettingsDebounced(); });
    $('#fmt_flash_chance').on('input', ev => {
      const v = +$(ev.currentTarget).val();
      s.flashChance = v;
      $('#fmt_flash_chance_val').text(v + '%');
      ctx().saveSettingsDebounced();
    });
    $(document).on('change.fmt_flash_cats', '.fmt-flash-cat-cb', () => {
      const cats = [];
      document.querySelectorAll('.fmt-flash-cat-cb:checked').forEach(el => cats.push(el.value));
      s.flashCats = cats;
      ctx().saveSettingsDebounced();
    });

    $('#fmt_prompt_tpl').on('input', () => { s.promptTemplate = $('#fmt_prompt_tpl').val(); ctx().saveSettingsDebounced(); });
    $('#fmt_reset_tpl_btn').on('click', async () => {
      s.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
      $('#fmt_prompt_tpl').val(DEFAULT_PROMPT_TEMPLATE);
      ctx().saveSettingsDebounced();
      await updateInjectedPrompt();
      toastr.success('Шаблон сброшен');
    });

    $(document).off('click.fmt_apimode').on('click.fmt_apimode', '.fmt-api-mode-btn', function () {
      const mode = this.getAttribute('data-mode');
      document.querySelectorAll('.fmt-api-mode-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      if (mode === 'st') {
        $('#fmt_mode_st').show(); $('#fmt_mode_custom').hide();
        s.apiEndpoint = ''; s.apiKey = '';
        _workingApiConfig = null;
        ctx().saveSettingsDebounced();
        toastr.info('[FMT] Используется ST (текущая подключённая модель)', '', { timeOut: 2500 });
      } else {
        $('#fmt_mode_st').hide(); $('#fmt_mode_custom').show();
      }
    });

    $('#fmt_api_endpoint').on('input', () => {
      s.apiEndpoint = $('#fmt_api_endpoint').val().trim();
      _workingApiConfig = null;
      ctx().saveSettingsDebounced();
    });
    $('#fmt_api_key').on('input', () => {
      s.apiKey = $('#fmt_api_key').val().trim();
      _workingApiConfig = null;
      ctx().saveSettingsDebounced();
    });
    $('#fmt_api_key_toggle').on('click', () => {
      const inp = document.getElementById('fmt_api_key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#fmt_api_model').on('change', () => {
      s.apiModel = $('#fmt_api_model').val();
      $('#fmt_api_model_manual').val(s.apiModel);
      _workingApiConfig = null;
      ctx().saveSettingsDebounced();
    });
    $('#fmt_api_model_manual').on('input', () => {
      const v = $('#fmt_api_model_manual').val().trim();
      s.apiModel = v;
      _workingApiConfig = null;
      ctx().saveSettingsDebounced();
    });
    $('#fmt_fallback_enabled').on('input', ev => {
      s.fallbackEnabled = $(ev.currentTarget).prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#fmt_test_api').on('click', async () => {
      const $btn    = $('#fmt_test_api');
      const $status = $('#fmt_api_status');
      $btn.prop('disabled', true).text('⏳ Проверка…');
      $status.css('color', 'rgba(180,200,240,.5)').text('Перебираю эндпоинты…');
      try {
        const cfg = await testApiConnection();
        _workingApiConfig = { base: getBaseUrl(), url: cfg.url, builder: cfg.builder };
        $status.css('color', '#70e8c0').text(`✅ Работает: ${cfg.url.replace(getBaseUrl(), '')}`);
        toastr.success('[FMT] API отвечает корректно');
      } catch (e) {
        $status.css('color', '#ff7070').text(`❌ ${e.message}`);
        toastr.error('[FMT] ' + e.message);
      } finally {
        $btn.prop('disabled', false).text('🔌 Тест соединения');
      }
    });

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
      } catch (e) {
        toastr.warning(`[FMT] ${e.message} — введи модель вручную`);
      } finally {
        $btn.prop('disabled', false).text('🔄');
      }
    });

    $(document)
      .off('click.fmt_settings')
      .on('click.fmt_settings', '#fmt_open_drawer_btn',   () => openDrawer(true))
      .on('click.fmt_settings', '#fmt_scan_settings_btn', () => runScan('manual'))
      .on('click.fmt_settings', '#fmt_reset_pos_btn', () => {
        try { localStorage.removeItem(FAB_POS_KEY); } catch {}
        setFabDefault(); toastr.success('Позиция сброшена');
      });
  }

  // ─── Flashback trigger ────────────────────────────────────────────────────────

  function buildFlashBlock(fact) {
    const catMeta = CATEGORIES[fact.category] || CATEGORIES.events;
    return `[ФЛЕШБЕК — ТОЛЬКО ДЛЯ ЭТОГО ОТВЕТА]
В этом ответе {{char}} внезапно — посреди сцены или разговора — переживает краткое непроизвольное воспоминание или внутренний образ, связанный со следующим фактом:

${catMeta.icon} «${fact.text}»

Инструкция:
- Воспоминание должно прорваться естественно, как вспышка — образ, запах, звук, обрывок фразы
- Не объясняй это игроку напрямую — покажи через поведение, паузу, изменение тона {{char}}
- Флешбек короткий (1–3 предложения), не должен занимать весь ответ
- После него {{char}} возвращается к текущей сцене
[/ФЛЕШБЕК]`;
  }

  function applyFlashQueue() {
    if (!flashQueue.length) {
      try { ctx().setExtensionPrompt(FLASHBACK_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
      return;
    }
    const next = flashQueue[0];
    try { ctx().setExtensionPrompt(FLASHBACK_TAG, next.block, EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
  }

  async function triggerFlashback(factId = null) {
    const s     = getSettings();
    const state = await getChatState();

    const allowed = s.flashCats || ['flashbacks', 'secrets', 'characters'];
    const pool    = state.facts.filter(f => !f.disabled && allowed.includes(f.category));

    if (!pool.length) {
      toastr.warning('[FMT] Нет подходящих фактов для флешбека.');
      return;
    }

    const fact = factId
      ? (pool.find(f => f.id === factId) ?? pool[Math.floor(Math.random() * pool.length)])
      : pool[Math.floor(Math.random() * pool.length)];

    const entry = {
      id:       makeId(),
      factId:   fact.id,
      factText: fact.text,
      factCat:  fact.category,
      block:    buildFlashBlock(fact),
      ts:       Date.now(),
    };

    flashQueue.push(entry);
    applyFlashQueue();
    renderFlashQueueUI();

    const qLen = flashQueue.length;
    toastr.info(
      `⚡ Флешбек добавлен${qLen > 1 ? ` (в очереди: ${qLen})` : ''}: «${fact.text.slice(0, 55)}${fact.text.length > 55 ? '…' : ''}»`,
      'FMT',
      { timeOut: 4000 }
    );

    const row = document.querySelector(`.fmt-fact-row[data-id="${fact.id}"]`);
    if (row) {
      row.classList.add('fmt-flash-highlight');
      setTimeout(() => row.classList.remove('fmt-flash-highlight'), 2500);
    }
  }

  function consumeFlashQueue() {
    if (!flashQueue.length) return;
    const fired = flashQueue.shift();
    flashHistory.unshift({ ...fired, fired: Date.now() });
    if (flashHistory.length > MAX_FLASH_HISTORY) flashHistory.length = MAX_FLASH_HISTORY;
    applyFlashQueue();
    renderFlashQueueUI();
  }

  function removeFromFlashQueue(id) {
    const idx = flashQueue.findIndex(e => e.id === id);
    if (idx < 0) return;
    flashQueue.splice(idx, 1);
    applyFlashQueue();
    renderFlashQueueUI();
    toastr.info('[FMT] Флешбек убран из очереди', '', { timeOut: 2000 });
  }

  function clearFlashQueue() {
    flashQueue.length = 0;
    try { ctx().setExtensionPrompt(FLASHBACK_TAG, '', EXT_PROMPT_TYPES.IN_PROMPT, 0, true); } catch {}
    renderFlashQueueUI();
    toastr.info('[FMT] Очередь флешбеков очищена', '', { timeOut: 2000 });
  }

  function renderFlashQueueUI() {
    const $panel = $('#fmt_flash_panel');
    if (!$panel.length) return;

    const hasQueue   = flashQueue.length > 0;
    const hasHistory = flashHistory.length > 0;

    if (!hasQueue && !hasHistory) { $panel.hide(); return; }

    $panel.show();
    let html = '';

    if (hasQueue) {
      html += `<div class="fmt-fq-section">
        <div class="fmt-fq-title">
          ⏳ Очередь (${flashQueue.length})
          <button class="fmt-fq-clear-all" title="Очистить всю очередь">✕ всё</button>
        </div>`;
      flashQueue.forEach((e, i) => {
        const cat = CATEGORIES[e.factCat] || CATEGORIES.events;
        html += `<div class="fmt-fq-row">
          <span class="fmt-fq-pos">${i + 1}</span>
          <span class="fmt-fq-cat">${cat.icon}</span>
          <span class="fmt-fq-text">${escHtml(e.factText.slice(0, 70))}${e.factText.length > 70 ? '…' : ''}</span>
          <button class="fmt-fq-remove" data-qid="${e.id}" title="Убрать из очереди">✕</button>
        </div>`;
      });
      html += '</div>';
    }

    if (hasHistory) {
      html += `<div class="fmt-fq-section fmt-fq-history">
        <div class="fmt-fq-title">🕓 Сработали (последние ${flashHistory.length})</div>`;
      flashHistory.forEach(e => {
        const cat  = CATEGORIES[e.factCat] || CATEGORIES.events;
        const time = new Date(e.fired).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        html += `<div class="fmt-fq-row fmt-fq-fired">
          <span class="fmt-fq-cat">${cat.icon}</span>
          <span class="fmt-fq-text">${escHtml(e.factText.slice(0, 70))}${e.factText.length > 70 ? '…' : ''}</span>
          <span class="fmt-fq-time">${time}</span>
        </div>`;
      });
      html += '</div>';
    }

    $panel.html(html);
    $panel.find('.fmt-fq-clear-all').off('click').on('click', clearFlashQueue);
    $panel.find('.fmt-fq-remove').off('click').on('click', function () {
      removeFromFlashQueue(this.getAttribute('data-qid'));
    });
  }

  // ─── Events ───────────────────────────────────────────────────────────────────

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
      scanInProgress = false;
      await new Promise(r => setTimeout(r, 300));
      await updateInjectedPrompt();
      await renderWidget();
      if ($('#fmt_drawer').hasClass('fmt-open')) await renderDrawer();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async (idx) => {
      consumeFlashQueue();
      const { chat } = ctx();
      const msg = chat?.[idx];
      if (msg && !msg.is_user) {
        await detectFactMarkers(msg.mes || '');
        await detectFlashbackMarkers(msg.mes || '');
      }
      await renderWidget();
      const s = getSettings();
      if (!s.autoScan) return;
      msgSinceLastScan++;
      if (msgSinceLastScan >= s.autoScanEvery) { msgSinceLastScan = 0; await runScan('auto'); }
    });

    eventSource.on(event_types.MESSAGE_SENT, async () => {
      await renderWidget();
      const s = getSettings();
      if (!s.flashEnabled || !s.flashChance || flashQueue.length > 0) return;
      if (Math.random() * 100 < s.flashChance) await triggerFlashback();
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try { wireChatEvents(); console.log('[FMT] v1.3.4 loaded'); }
    catch (e) { console.error('[FMT] init failed', e); }
  });

})();
