// ============================================================
//  Memory Extractor — SillyTavern Extension v1.0
//  Extracts structured facts from roleplay chat
// ============================================================

import {
    getContext,
    saveSettingsDebounced,
    extension_settings,
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    chat_metadata,
    saveChat,
    setExtensionPrompt,
    generateQuietPrompt,
} from '../../../../script.js';

// ─── Constants ───────────────────────────────────────────────
const EXT_NAME   = 'memory-extractor';
const PROMPT_KEY = 'memory_extractor_block';
const META_KEY   = 'memory_extractor_facts';

const CATEGORIES = {
    characters: { label: '👤 Персонажи и отношения', color: '#7eb8f7' },
    events:     { label: '⚡ События и последствия',  color: '#f7c97e' },
    secrets:    { label: '🔒 Секреты и скрытая инфа', color: '#c97ef7' },
};

// ─── Default settings ─────────────────────────────────────────
const DEFAULT_SETTINGS = {
    enabled         : true,
    api_mode        : 'st',       // 'st' | 'custom'
    custom_api_url  : '',
    custom_api_key  : '',
    custom_model    : 'gpt-4o-mini',
    trigger_mode    : 'auto',     // 'auto' | 'manual'
    trigger_every   : 10,
    scan_last_msgs  : 20,
    inject_position : 'before',   // 'before' | 'after'
    inject_depth    : 2,
    active_cats     : ['characters', 'events', 'secrets'],
    max_facts       : 80,
};

// ─── State ────────────────────────────────────────────────────
let settings     = {};
let msgCounter   = 0;
let isExtracting = false;

// ─── Init ─────────────────────────────────────────────────────
jQuery(async () => {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    settings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[EXT_NAME]);
    syncSettings();

    injectSettingsUI();
    bindUIEvents();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);

    console.log(`[${EXT_NAME}] ✓ Loaded`);
});

// ─── Settings HTML ────────────────────────────────────────────
function injectSettingsUI() {
    const html = `
    <div id="mem_ext_wrap" class="mem-panel">
        <div class="mem-header" id="mem_header">
            <span>🧠 Memory Extractor</span>
            <div class="mem-header-right">
                <label class="mem-toggle-wrap" onclick="event.stopPropagation()">
                    <input type="checkbox" id="mem_enabled">
                    <span class="mem-toggle"></span>
                </label>
                <span class="mem-chevron" id="mem_chevron">▾</span>
            </div>
        </div>

        <div class="mem-body" id="mem_body">

            <!-- API -->
            <div class="mem-section">
                <div class="mem-label">Источник API</div>
                <div class="mem-radio-row">
                    <label><input type="radio" name="mem_api" value="st"> Текущее ST подключение</label>
                    <label><input type="radio" name="mem_api" value="custom"> Свой API / Прокси</label>
                </div>
                <div id="mem_custom_block">
                    <input id="mem_api_url"   class="mem-input" type="text"     placeholder="https://api.openai.com/v1" />
                    <input id="mem_api_key"   class="mem-input" type="password" placeholder="API ключ (sk-...)" />
                    <input id="mem_api_model" class="mem-input" type="text"     placeholder="Модель: gpt-4o-mini" />
                </div>
            </div>

            <!-- Trigger -->
            <div class="mem-section">
                <div class="mem-label">Триггер</div>
                <div class="mem-radio-row">
                    <label><input type="radio" name="mem_trigger" value="auto"> Авто</label>
                    <label><input type="radio" name="mem_trigger" value="manual"> Вручную</label>
                </div>
                <div id="mem_auto_block" class="mem-row">
                    <span>Каждые</span>
                    <input id="mem_every" class="mem-input-sm" type="number" min="1" max="200" />
                    <span>сообщений. Сканировать последние</span>
                    <input id="mem_scan"  class="mem-input-sm" type="number" min="5" max="200" />
                </div>
            </div>

            <!-- Categories -->
            <div class="mem-section">
                <div class="mem-label">Категории фактов</div>
                ${Object.entries(CATEGORIES).map(([k, v]) => `
                    <label class="mem-cat-row">
                        <input type="checkbox" class="mem-cat-chk" data-cat="${k}">
                        <span style="color:${v.color}">${v.label}</span>
                    </label>`).join('')}
            </div>

            <!-- Inject -->
            <div class="mem-section">
                <div class="mem-label">Инжект в контекст</div>
                <div class="mem-row">
                    <span>Позиция:</span>
                    <select id="mem_inject_pos" class="mem-select">
                        <option value="before">До системного промпта</option>
                        <option value="after">После системного промпта</option>
                    </select>
                </div>
                <div class="mem-row" style="margin-top:6px">
                    <span>Макс. фактов:</span>
                    <input id="mem_max" class="mem-input-sm" type="number" min="10" max="300" />
                </div>
            </div>

            <!-- Actions -->
            <div class="mem-section mem-actions">
                <button id="mem_btn_scan"  class="mem-btn mem-btn-primary">🔍 Сканировать</button>
                <button id="mem_btn_view"  class="mem-btn">📋 Факты</button>
                <button id="mem_btn_clear" class="mem-btn mem-btn-danger">🗑 Очистить</button>
            </div>
            <div id="mem_status" class="mem-status"></div>
        </div>
    </div>

    <!-- Modal -->
    <div id="mem_modal" class="mem-modal-overlay">
        <div class="mem-modal">
            <div class="mem-modal-head">
                <span>📋 Извлечённые факты</span>
                <button id="mem_modal_close" class="mem-btn">✕</button>
            </div>
            <div class="mem-modal-filters" id="mem_filters">
                <button class="mem-ftab active" data-cat="all">Все</button>
                ${Object.entries(CATEGORIES).map(([k, v]) => `
                    <button class="mem-ftab" data-cat="${k}" style="--cat-color:${v.color}">${v.label}</button>`).join('')}
            </div>
            <div class="mem-modal-search">
                <input id="mem_search" class="mem-input" type="text" placeholder="🔎 Поиск..." />
            </div>
            <div id="mem_facts_list" class="mem-facts-list"></div>
            <div id="mem_modal_footer" class="mem-modal-footer"></div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);
    applySettingsToUI();
}

function applySettingsToUI() {
    $('#mem_enabled').prop('checked', settings.enabled);
    $(`input[name="mem_api"][value="${settings.api_mode}"]`).prop('checked', true);
    $(`input[name="mem_trigger"][value="${settings.trigger_mode}"]`).prop('checked', true);
    $('#mem_api_url').val(settings.custom_api_url);
    $('#mem_api_key').val(settings.custom_api_key);
    $('#mem_api_model').val(settings.custom_model);
    $('#mem_every').val(settings.trigger_every);
    $('#mem_scan').val(settings.scan_last_msgs);
    $('#mem_inject_pos').val(settings.inject_position);
    $('#mem_max').val(settings.max_facts);
    $('.mem-cat-chk').each(function () {
        $(this).prop('checked', settings.active_cats.includes($(this).data('cat')));
    });
    toggleCustomBlock();
    toggleAutoBlock();
}

// ─── UI Events ────────────────────────────────────────────────
function bindUIEvents() {
    // Collapsible header
    $('#mem_header').on('click', function (e) {
        if ($(e.target).closest('.mem-toggle-wrap').length) return;
        $('#mem_body').slideToggle(180);
        $('#mem_chevron').toggleClass('open');
    });

    // Enabled
    $('#mem_enabled').on('change', function () {
        settings.enabled = this.checked;
        save();
        if (!settings.enabled) clearInjection();
    });

    // API mode
    $('input[name="mem_api"]').on('change', function () {
        settings.api_mode = this.value; save(); toggleCustomBlock();
    });
    $('#mem_api_url').on('input',   function () { settings.custom_api_url = this.value; save(); });
    $('#mem_api_key').on('input',   function () { settings.custom_api_key = this.value; save(); });
    $('#mem_api_model').on('input', function () { settings.custom_model   = this.value; save(); });

    // Trigger
    $('input[name="mem_trigger"]').on('change', function () {
        settings.trigger_mode = this.value; save(); toggleAutoBlock();
    });
    $('#mem_every').on('input', function () { settings.trigger_every  = parseInt(this.value) || 10; save(); });
    $('#mem_scan').on('input',  function () { settings.scan_last_msgs = parseInt(this.value) || 20; save(); });

    // Categories
    $('.mem-cat-chk').on('change', function () {
        const cat = $(this).data('cat');
        settings.active_cats = settings.active_cats.filter(c => c !== cat);
        if (this.checked) settings.active_cats.push(cat);
        save(); updateInjection();
    });

    // Inject
    $('#mem_inject_pos').on('change', function () { settings.inject_position = this.value; save(); updateInjection(); });
    $('#mem_max').on('input', function () { settings.max_facts = parseInt(this.value) || 80; save(); });

    // Buttons
    $('#mem_btn_scan').on('click',  () => runExtraction(true));
    $('#mem_btn_view').on('click',  openModal);
    $('#mem_btn_clear').on('click', clearMemory);
    $('#mem_modal_close').on('click', closeModal);
    $('#mem_modal').on('click', function (e) { if ($(e.target).is('#mem_modal')) closeModal(); });

    // Filter tabs
    $(document).on('click', '.mem-ftab', function () {
        $('.mem-ftab').removeClass('active');
        $(this).addClass('active');
        renderFacts($(this).data('cat'), $('#mem_search').val());
    });

    // Search
    $('#mem_search').on('input', function () {
        const cat = $('.mem-ftab.active').data('cat');
        renderFacts(cat, this.value);
    });

    // Delete fact
    $(document).on('click', '.mem-fact-del', function () {
        const cat = $(this).data('cat');
        const id  = $(this).data('id');
        deleteFact(cat, id);
    });
}

function toggleCustomBlock() {
    settings.api_mode === 'custom' ? $('#mem_custom_block').slideDown(150) : $('#mem_custom_block').slideUp(150);
}
function toggleAutoBlock() {
    settings.trigger_mode === 'auto' ? $('#mem_auto_block').slideDown(150) : $('#mem_auto_block').slideUp(150);
}

// ─── ST Hooks ─────────────────────────────────────────────────
function onMessageReceived() {
    if (!settings.enabled || settings.trigger_mode !== 'auto') return;
    msgCounter++;
    if (msgCounter >= settings.trigger_every) {
        msgCounter = 0;
        runExtraction(false);
    }
}

function onChatChanged() {
    msgCounter = 0;
    updateInjection();
}

// ─── Core: Extraction ─────────────────────────────────────────
async function runExtraction(manual = false) {
    if (isExtracting || !settings.enabled) return;
    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length < 2) { setStatus('⚠️ Чат пуст или слишком короткий', 'warn'); return; }

    isExtracting = true;
    setStatus('⏳ Извлечение фактов...', 'info');
    $('#mem_btn_scan').prop('disabled', true).text('⏳ Сканирую...');

    try {
        const messages = getRecentMessages(settings.scan_last_msgs);
        const existing = getStoredFacts();
        const prompt   = buildPrompt(messages, existing);
        const raw      = await callLLM(prompt);
        const parsed   = parseJSON(raw);

        if (parsed) {
            const merged  = mergeFacts(existing, parsed);
            storeFacts(merged);
            updateInjection();
            const n = countNew(parsed);
            setStatus(`✅ Готово! Новых фактов: ${n}`, 'success');
            if (manual) openModal();
        } else {
            setStatus('⚠️ LLM вернул нераспознаваемый ответ', 'warn');
        }
    } catch (err) {
        console.error(`[${EXT_NAME}]`, err);
        setStatus(`❌ Ошибка: ${err.message}`, 'error');
    }

    isExtracting = false;
    $('#mem_btn_scan').prop('disabled', false).text('🔍 Сканировать');
}

// ─── Prompt ───────────────────────────────────────────────────
function buildPrompt(messages, existing) {
    const existStr = formatExistingForPrompt(existing);
    const msgsStr  = messages.map(m => `[${m.role}]: ${m.content}`).join('\n');

    return `Ты — система извлечения фактов для ролевой игры. Анализируй диалог и извлекай ТОЛЬКО важные конкретные факты.

ПРАВИЛА:
1. Только факты из текста — никаких домыслов
2. Если факт уже есть в СУЩЕСТВУЮЩЕЙ ПАМЯТИ — ПРОПУСТИ (не дублируй)
3. Если факт ОБНОВЛЯЕТ существующий — используй блок "updates", укажи target_id
4. Пустые категории — пустые массивы []
5. Отвечай ТОЛЬКО валидным JSON. Никакого текста, никаких markdown-блоков вокруг

СУЩЕСТВУЮЩАЯ ПАМЯТЬ (не дублировать):
${existStr || '(пусто — первое сканирование)'}

СООБЩЕНИЯ ДЛЯ АНАЛИЗА:
${msgsStr}

Формат ответа:
{
  "characters": [
    { "id": "уникальный_snake_id", "name": "Имя", "aliases": [], "traits": [], "status": "жив", "location": "где", "type": "new" }
  ],
  "relations": [
    { "id": "уникальный_id", "from": "А", "to": "Б", "rel_type": "союзники", "notes": "", "type": "new" }
  ],
  "events": [
    { "id": "уникальный_id", "what": "Что случилось", "who": [], "where": "место", "consequence": "последствие", "type": "new" }
  ],
  "secrets": [
    { "id": "уникальный_id", "fact": "Секрет", "known_by": [], "hidden_from": [], "type": "new" }
  ],
  "updates": [
    { "target_id": "id_существующего", "field": "поле", "old_value": "было", "new_value": "стало" }
  ]
}`;
}

function formatExistingForPrompt(facts) {
    if (!facts) return '';
    const lines = [];
    const add = (cat, items, fmt) => {
        if (items?.length) { lines.push(cat); items.forEach(i => lines.push('  ' + fmt(i))); }
    };
    add('ПЕРСОНАЖИ:',  facts.characters, c => `[${c.id}] ${c.name} | статус:${c.status} | локация:${c.location} | черты:${(c.traits||[]).join(',')}`);
    add('ОТНОШЕНИЯ:',  facts.relations,  r => `[${r.id}] ${r.from} ↔ ${r.to} = ${r.rel_type}`);
    add('СОБЫТИЯ:',    facts.events,     e => `[${e.id}] ${e.what} @ ${e.where} → ${e.consequence}`);
    add('СЕКРЕТЫ:',    facts.secrets,    s => `[${s.id}] ${s.fact} | знает:${(s.known_by||[]).join(',')}`);
    return lines.join('\n');
}

// ─── LLM Call ─────────────────────────────────────────────────
async function callLLM(prompt) {
    if (settings.api_mode === 'custom' && settings.custom_api_url) {
        return callCustomAPI(prompt);
    }
    return generateQuietPrompt(prompt, false, false);
}

async function callCustomAPI(prompt) {
    const base = settings.custom_api_url.replace(/\/$/, '');
    const url  = `${base}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (settings.custom_api_key) headers['Authorization'] = `Bearer ${settings.custom_api_key}`;

    const resp = await fetch(url, {
        method  : 'POST',
        headers,
        body    : JSON.stringify({
            model      : settings.custom_model || 'gpt-4o-mini',
            messages   : [{ role: 'user', content: prompt }],
            max_tokens : 2500,
            temperature: 0.1,
        }),
    });

    if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
}

// ─── Parse & Merge ────────────────────────────────────────────
function parseJSON(raw) {
    if (!raw) return null;
    try {
        const clean = raw.replace(/```json|```/g, '').trim();
        const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
        if (s === -1 || e === -1) return null;
        return JSON.parse(clean.slice(s, e + 1));
    } catch (err) {
        console.warn(`[${EXT_NAME}] JSON parse error:`, err);
        return null;
    }
}

function mergeFacts(existing, parsed) {
    const base = existing || { characters: [], relations: [], events: [], secrets: [] };
    const cats  = ['characters', 'relations', 'events', 'secrets'];

    // Apply updates
    (parsed.updates || []).forEach(upd => {
        for (const cat of cats) {
            const item = base[cat]?.find(i => i.id === upd.target_id);
            if (item) { item[upd.field] = upd.new_value; item._updated = Date.now(); }
        }
    });

    // Merge new facts, skip duplicates by id
    for (const cat of cats) {
        if (!parsed[cat]?.length) continue;
        const existing_ids = new Set((base[cat] || []).map(i => i.id));
        parsed[cat].forEach(item => {
            if (!existing_ids.has(item.id)) {
                item._added = Date.now();
                base[cat].push(item);
            }
        });
    }

    // Trim to max_facts per category
    const maxPerCat = Math.ceil(settings.max_facts / cats.length);
    for (const cat of cats) {
        if (base[cat]?.length > maxPerCat) base[cat] = base[cat].slice(-maxPerCat);
    }

    return base;
}

function countNew(parsed) {
    return ['characters', 'relations', 'events', 'secrets']
        .reduce((n, cat) => n + (parsed[cat]?.length || 0), 0);
}

// ─── Storage ──────────────────────────────────────────────────
function getStoredFacts() {
    return chat_metadata?.[META_KEY] || null;
}

function storeFacts(facts) {
    if (!chat_metadata) return;
    chat_metadata[META_KEY] = facts;
    saveChat();
}

function clearMemory() {
    if (!confirm('Очистить всю извлечённую память для этого чата?')) return;
    if (chat_metadata) delete chat_metadata[META_KEY];
    saveChat();
    clearInjection();
    setStatus('🗑 Память очищена', 'warn');
    renderFacts('all', '');
}

// ─── Injection ────────────────────────────────────────────────
function updateInjection() {
    const facts = getStoredFacts();
    if (!facts || !settings.enabled) { clearInjection(); return; }

    const lines = [];
    const push  = (header, items, fmt) => {
        if (!items?.length) return;
        const active = items.filter(i => settings.active_cats.some(c => c === catOfItem(i)));
        if (!active.length) return;
        lines.push(header);
        active.forEach(i => lines.push('  • ' + fmt(i)));
    };

    push('### Персонажи',  facts.characters, c => `${c.name}${c.location ? ' ['+c.location+']' : ''}${c.status ? ' ('+c.status+')' : ''}${c.traits?.length ? ' — '+c.traits.join(', ') : ''}`);
    push('### Отношения',  facts.relations,  r => `${r.from} ↔ ${r.to}: ${r.rel_type}${r.notes ? ' ('+r.notes+')' : ''}`);
    push('### События',    facts.events,     e => `${e.what}${e.where ? ' @ '+e.where : ''}${e.consequence ? ' → '+e.consequence : ''}`);
    push('### Секреты',    facts.secrets,    s => `${s.fact}${s.known_by?.length ? ' [знает: '+s.known_by.join(', ')+']' : ''}`);

    if (!lines.length) { clearInjection(); return; }

    const block = `[ПАМЯТЬ СЦЕНЫ]\n${lines.join('\n')}\n[/ПАМЯТЬ СЦЕНЫ]`;
    const depth = settings.inject_position === 'before' ? 0 : settings.inject_depth;
    setExtensionPrompt(PROMPT_KEY, block, depth, 0);
}

function clearInjection() {
    setExtensionPrompt(PROMPT_KEY, '', 0, 0);
}

function catOfItem(item) {
    // helper to figure out which cat an item belongs to
    if ('name' in item && 'status' in item) return 'characters';
    if ('from' in item && 'to' in item)     return 'relations';
    if ('what' in item)                     return 'events';
    if ('fact' in item)                     return 'secrets';
    return null;
}

// ─── Modal / Facts Viewer ─────────────────────────────────────
function openModal() {
    renderFacts('all', '');
    $('#mem_modal').fadeIn(150);
    $('.mem-ftab[data-cat="all"]').click();
    $('#mem_search').val('');
}
function closeModal() { $('#mem_modal').fadeOut(150); }

function renderFacts(cat = 'all', search = '') {
    const facts = getStoredFacts();
    const $list = $('#mem_facts_list').empty();

    if (!facts) {
        $list.append('<div class="mem-empty">Нет извлечённых фактов. Нажмите «Сканировать».</div>');
        updateFooter(0);
        return;
    }

    const catMap = {
        characters: facts.characters || [],
        relations:  facts.relations  || [],
        events:     facts.events     || [],
        secrets:    facts.secrets    || [],
    };

    const searchLow = (search || '').toLowerCase();
    let total = 0;

    const catsToShow = cat === 'all' ? Object.keys(CATEGORIES) : [cat];

    // characters + relations both under 'characters' category
    const catToFacts = {
        characters: [...(facts.characters || []), ...(facts.relations || [])],
        events:     facts.events  || [],
        secrets:    facts.secrets || [],
    };

    catsToShow.forEach(c => {
        const items = (catToFacts[c] || []).filter(i => {
            if (!searchLow) return true;
            return JSON.stringify(i).toLowerCase().includes(searchLow);
        });
        if (!items.length) return;

        const info = CATEGORIES[c];
        const $sec = $(`<div class="mem-section-block"></div>`);
        $sec.append(`<div class="mem-cat-header" style="color:${info.color}">${info.label} <span class="mem-count">${items.length}</span></div>`);

        items.forEach(item => {
            const rawCat = 'name' in item && 'status' in item ? 'characters'
                         : 'from' in item ? 'relations'
                         : 'what' in item ? 'events' : 'secrets';
            const line = formatFactLine(item, rawCat);
            $sec.append(`
                <div class="mem-fact-item">
                    <span class="mem-fact-text">${line}</span>
                    <button class="mem-fact-del mem-btn" data-cat="${rawCat}" data-id="${item.id}" title="Удалить">✕</button>
                </div>`);
            total++;
        });

        $list.append($sec);
    });

    if (!total) $list.append('<div class="mem-empty">Нет фактов по выбранному фильтру.</div>');
    updateFooter(total);
}

function formatFactLine(item, cat) {
    switch (cat) {
        case 'characters': return `<b>${item.name}</b>${item.location ? ' 📍'+item.location : ''}${item.status ? ' · '+item.status : ''}${item.traits?.length ? ' · '+item.traits.join(', ') : ''}`;
        case 'relations':  return `<b>${item.from}</b> ↔ <b>${item.to}</b> — ${item.rel_type}${item.notes ? ' ('+item.notes+')' : ''}`;
        case 'events':     return `${item.what}${item.where ? ' <span class="mem-tag">📍'+item.where+'</span>' : ''}${item.consequence ? ' → '+item.consequence : ''}`;
        case 'secrets':    return `🔒 ${item.fact}${item.known_by?.length ? ' <span class="mem-tag">знает: '+item.known_by.join(', ')+'</span>' : ''}`;
        default: return JSON.stringify(item);
    }
}

function updateFooter(total) {
    const stored = getStoredFacts();
    const all    = stored ? ['characters','relations','events','secrets'].reduce((n,c) => n+(stored[c]?.length||0), 0) : 0;
    $('#mem_modal_footer').text(`Показано: ${total} · Всего в памяти: ${all}`);
}

function deleteFact(cat, id) {
    const facts = getStoredFacts();
    if (!facts || !facts[cat]) return;
    facts[cat] = facts[cat].filter(i => i.id !== id);
    storeFacts(facts);
    updateInjection();
    const activeCat = $('.mem-ftab.active').data('cat');
    renderFacts(activeCat, $('#mem_search').val());
}

// ─── Helpers ──────────────────────────────────────────────────
function getRecentMessages(n) {
    const ctx  = getContext();
    const chat = ctx.chat || [];
    return chat.slice(-n).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: m.mes || '',
    })).filter(m => m.content.trim());
}

function setStatus(msg, type = 'info') {
    const colors = { info: '#7eb8f7', success: '#7ef7a0', warn: '#f7c97e', error: '#f77e7e' };
    $('#mem_status').text(msg).css('color', colors[type] || '#ccc');
    if (type === 'success') setTimeout(() => $('#mem_status').text(''), 4000);
}

function syncSettings() {
    Object.assign(extension_settings[EXT_NAME], settings);
}

function save() {
    syncSettings();
    saveSettingsDebounced();
}
