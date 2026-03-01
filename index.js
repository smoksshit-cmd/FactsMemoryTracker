// ============================================================
//  Memory Extractor — SillyTavern Extension v1.0
// ============================================================

import {
    getContext,
    saveMetadataDebounced,
    extension_settings,
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    generateQuietPrompt,
    chat_metadata,
    setExtensionPrompt,
} from '../../../../script.js';

const EXT_NAME   = 'memory-extractor';
const PROMPT_KEY = 'MEMORY_EXTRACTOR';
const META_KEY   = 'memory_extractor_facts';

const DEFAULT_SETTINGS = {
    enabled:          true,
    triggerMode:      'auto',
    triggerInterval:  10,
    useCustomApi:     false,
    apiUrl:           '',
    apiKey:           '',
    apiModel:         'gpt-4o-mini',
    injectPosition:   'after_an',
    injectCategories: { characters: true, events: true, secrets: true },
    scanLastN:        20,
};

let settings       = {};
let messageCounter = 0;
let isScanning     = false;

// ─── Init ────────────────────────────────────────────────────
jQuery(async () => {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    settings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[EXT_NAME]);

    $('#extensions_settings').append(buildSettingsHTML());
    bindSettingsEvents();
    renderSettingsValues();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);

    console.log('[' + EXT_NAME + '] loaded');
});

// ─── Hooks ───────────────────────────────────────────────────
async function onMessageReceived() {
    if (!settings.enabled || settings.triggerMode !== 'auto') return;
    messageCounter++;
    if (messageCounter >= settings.triggerInterval) {
        messageCounter = 0;
        await runExtraction();
    }
}

function onChatChanged() {
    messageCounter = 0;
    renderFactsPanel();
}

// ─── Core ────────────────────────────────────────────────────
async function runExtraction() {
    if (isScanning) return;
    isScanning = true;
    updateScanButton(true);

    try {
        const context      = getContext();
        const chat         = context.chat || [];
        const lastMessages = chat.slice(-settings.scanLastN);
        if (!lastMessages.length) { isScanning = false; updateScanButton(false); return; }

        const existingFacts = loadFacts();
        const prompt        = buildExtractionPrompt(lastMessages, existingFacts);

        let rawResponse;
        if (settings.useCustomApi && settings.apiUrl && settings.apiKey) {
            rawResponse = await callCustomApi(prompt);
        } else {
            rawResponse = await generateQuietPrompt(prompt, false, true);
        }

        const incoming = parseFactsResponse(rawResponse);
        if (incoming) {
            const merged = mergeFacts(existingFacts, incoming);
            saveFacts(merged);
            injectMemoryIntoContext(merged);
            renderFactsPanel();
            showToast('Memory updated: +' + countNew(incoming) + ' facts');
        } else {
            showToast('Nothing new found');
        }
    } catch (err) {
        console.error('[' + EXT_NAME + '] Extraction error:', err);
        showToast('Extraction failed — check console', true);
    } finally {
        isScanning = false;
        updateScanButton(false);
    }
}

// ─── Prompt ──────────────────────────────────────────────────
function buildExtractionPrompt(messages, existing) {
    const chatText = messages
        .map(function(m) { return '[' + (m.is_user ? 'User' : (m.name || 'Character')) + ']: ' + m.mes; })
        .join('\n');

    return 'You are a fact extractor for a roleplay session.\n\n' +
        'RULES:\n' +
        '1. Extract ONLY concrete, important facts — no filler, no interpretation\n' +
        '2. EXISTING MEMORY is already stored — do NOT repeat any fact already there\n' +
        '3. If a fact UPDATES an existing one (e.g. location changed) add to "updates"\n' +
        '4. Respond ONLY with valid JSON — no markdown, no explanation\n\n' +
        'EXISTING MEMORY:\n' + JSON.stringify(existing, null, 2) + '\n\n' +
        'NEW MESSAGES:\n' + chatText + '\n\n' +
        'Respond ONLY with this JSON:\n' +
        '{\n' +
        '  "new_facts": {\n' +
        '    "characters": [{ "name": "", "aliases": [], "traits": [], "status": "", "location": "" }],\n' +
        '    "relations":  [{ "from": "", "to": "", "type": "", "notes": "" }],\n' +
        '    "events":     [{ "what": "", "who": [], "where": "", "consequence": "" }],\n' +
        '    "secrets":    [{ "fact": "", "known_by": [], "hidden_from": [] }]\n' +
        '  },\n' +
        '  "updates": [{ "category": "", "match_name": "", "field": "", "new_value": "" }],\n' +
        '  "nothing_new": false\n' +
        '}';
}

// ─── Parser ───────────────────────────────────────────────────
function parseFactsResponse(raw) {
    try {
        var clean  = raw.replace(/```json|```/gi, '').trim();
        var parsed = JSON.parse(clean);
        return parsed.nothing_new ? null : parsed;
    } catch (e) {
        console.warn('[' + EXT_NAME + '] Parse failed:', raw);
        return null;
    }
}

// ─── Merge ───────────────────────────────────────────────────
function mergeFacts(existing, incoming) {
    var result = JSON.parse(JSON.stringify(existing));
    result.characters = result.characters || [];
    result.relations  = result.relations  || [];
    result.events     = result.events     || [];
    result.secrets    = result.secrets    || [];

    (incoming.updates || []).forEach(function(upd) {
        var arr = result[upd.category];
        if (!arr) return;
        var item = arr.find(function(i) { return i.name === upd.match_name || i.what === upd.match_name; });
        if (item) item[upd.field] = upd.new_value;
    });

    var nf = incoming.new_facts || {};

    (nf.characters || []).forEach(function(c) {
        var ex = result.characters.find(function(x) {
            return x.name && c.name && x.name.toLowerCase() === c.name.toLowerCase();
        });
        if (ex) {
            ex.traits  = Array.from(new Set((ex.traits  || []).concat(c.traits  || [])));
            ex.aliases = Array.from(new Set((ex.aliases || []).concat(c.aliases || [])));
            if (c.status)   ex.status   = c.status;
            if (c.location) ex.location = c.location;
        } else {
            c._id = uid();
            result.characters.push(c);
        }
    });

    (nf.relations || []).forEach(function(r) {
        var key = (r.from + '|' + r.to + '|' + r.type).toLowerCase();
        var dup = result.relations.find(function(x) {
            return (x.from + '|' + x.to + '|' + x.type).toLowerCase() === key;
        });
        if (!dup) { r._id = uid(); result.relations.push(r); }
    });

    (nf.events || []).forEach(function(e) {
        var dup = result.events.find(function(x) { return similarity(x.what, e.what) > 0.8; });
        if (!dup) { e._id = uid(); result.events.push(e); }
    });

    (nf.secrets || []).forEach(function(s) {
        var dup = result.secrets.find(function(x) { return similarity(x.fact, s.fact) > 0.8; });
        if (!dup) { s._id = uid(); result.secrets.push(s); }
    });

    return result;
}

// ─── Storage ─────────────────────────────────────────────────
function loadFacts() {
    return chat_metadata[META_KEY] || { characters: [], relations: [], events: [], secrets: [] };
}
function saveFacts(facts) {
    chat_metadata[META_KEY] = facts;
    saveMetadataDebounced();
}

// ─── Inject ──────────────────────────────────────────────────
function injectMemoryIntoContext(facts) {
    var cfg   = settings.injectCategories;
    var lines = ['[MEMORY EXTRACT]'];

    if (cfg.characters) {
        if (facts.characters && facts.characters.length) {
            lines.push('## Characters');
            facts.characters.slice(0, 10).forEach(function(c) {
                var l = '* ' + c.name;
                if (c.status)        l += ' [' + c.status + ']';
                if (c.location)      l += ' @ ' + c.location;
                if (c.traits && c.traits.length) l += ' — ' + c.traits.join(', ');
                lines.push(l);
            });
        }
        if (facts.relations && facts.relations.length) {
            lines.push('## Relations');
            facts.relations.slice(0, 10).forEach(function(r) {
                lines.push('* ' + r.from + ' <-> ' + r.to + ': ' + r.type + (r.notes ? ' (' + r.notes + ')' : ''));
            });
        }
    }

    if (cfg.events && facts.events && facts.events.length) {
        lines.push('## Key Events');
        facts.events.slice(0, 10).forEach(function(e) {
            var l = '* ' + e.what;
            if (e.where)       l += ' [' + e.where + ']';
            if (e.consequence) l += ' -> ' + e.consequence;
            lines.push(l);
        });
    }

    if (cfg.secrets && facts.secrets && facts.secrets.length) {
        lines.push('## Hidden Info');
        facts.secrets.slice(0, 10).forEach(function(s) {
            var l = '* ' + s.fact;
            if (s.hidden_from && s.hidden_from.length) l += ' (hidden from: ' + s.hidden_from.join(', ') + ')';
            lines.push(l);
        });
    }

    lines.push('[/MEMORY EXTRACT]');

    var posMap = { after_an: 1, before_an: 0, top: -1 };
    setExtensionPrompt(PROMPT_KEY, lines.join('\n'), posMap[settings.injectPosition] !== undefined ? posMap[settings.injectPosition] : 1, 0);
}

// ─── Custom API ───────────────────────────────────────────────
async function callCustomApi(prompt) {
    var res = await fetch(settings.apiUrl + '/v1/chat/completions', {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + settings.apiKey,
        },
        body: JSON.stringify({
            model:      settings.apiModel,
            max_tokens: 1500,
            messages:   [{ role: 'user', content: prompt }],
        }),
    });
    if (!res.ok) throw new Error('API ' + res.status + ': ' + (await res.text()));
    var data = await res.json();
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
        || (data && data.content && data.content[0] && data.content[0].text)
        || '';
}

// ─── Settings HTML ────────────────────────────────────────────
function buildSettingsHTML() {
    return '<div id="mem-ext-settings" class="mem-ext-panel">' +
        '<div class="mem-ext-header" id="mem-ext-toggle-btn">' +
            '<span>&#x1F9E0; Memory Extractor</span>' +
            '<span class="mem-ext-chevron">&#9662;</span>' +
        '</div>' +
        '<div class="mem-ext-body" id="mem-ext-body">' +

            // Status bar
            '<div class="mem-statusbar">' +
                '<label class="mem-switch"><input type="checkbox" id="mem-enabled"><span class="mem-slider"></span></label>' +
                '<span class="mem-status-lbl" id="mem-status-lbl">Enabled</span>' +
                '<button id="mem-scan-btn" class="mem-btn mem-btn-primary">&#9889; Scan Now</button>' +
                '<button id="mem-clear-btn" class="mem-btn mem-btn-danger">&#x1F5D1; Clear</button>' +
            '</div>' +

            // Tabs
            '<div class="mem-tabs">' +
                '<button class="mem-tab active" data-tab="facts">&#x1F4CB; Facts</button>' +
                '<button class="mem-tab" data-tab="trigger">&#x2699; Trigger</button>' +
                '<button class="mem-tab" data-tab="api">&#x1F50C; API</button>' +
                '<button class="mem-tab" data-tab="inject">&#x1F4E5; Inject</button>' +
            '</div>' +

            // FACTS TAB
            '<div class="mem-tab-content active" id="tab-facts">' +
                '<div class="mem-filters">' +
                    '<button class="mem-filter active" data-filter="all">All</button>' +
                    '<button class="mem-filter" data-filter="characters">&#x1F464; Chars</button>' +
                    '<button class="mem-filter" data-filter="relations">&#x1F517; Relations</button>' +
                    '<button class="mem-filter" data-filter="events">&#x26A1; Events</button>' +
                    '<button class="mem-filter" data-filter="secrets">&#x1F510; Secrets</button>' +
                '</div>' +
                '<div id="mem-facts-list" class="mem-facts-list"><div class="mem-empty">No facts yet &mdash; click Scan Now</div></div>' +
            '</div>' +

            // TRIGGER TAB
            '<div class="mem-tab-content" id="tab-trigger">' +
                '<div class="mem-field"><label>Trigger mode</label>' +
                    '<select id="mem-trigger-mode"><option value="auto">Auto (every N messages)</option><option value="manual">Manual only</option></select>' +
                '</div>' +
                '<div class="mem-field" id="mem-interval-wrap"><label>Every <span id="mem-interval-val">10</span> messages</label>' +
                    '<input type="range" id="mem-trigger-interval" min="5" max="50" step="5" value="10">' +
                '</div>' +
                '<div class="mem-field"><label>Messages to scan per run</label>' +
                    '<input type="number" id="mem-scan-last" min="5" max="100" value="20">' +
                '</div>' +
            '</div>' +

            // API TAB
            '<div class="mem-tab-content" id="tab-api">' +
                '<div class="mem-field"><label>API source</label>' +
                    '<select id="mem-api-source"><option value="st">Current ST connection</option><option value="custom">Custom API (own key)</option></select>' +
                '</div>' +
                '<div id="mem-custom-api-fields" style="display:none">' +
                    '<div class="mem-field"><label>Base URL</label><input type="text" id="mem-api-url" placeholder="https://api.openai.com"></div>' +
                    '<div class="mem-field"><label>API Key</label><input type="password" id="mem-api-key" placeholder="sk-..."></div>' +
                    '<div class="mem-field"><label>Model</label><input type="text" id="mem-api-model" placeholder="gpt-4o-mini"></div>' +
                '</div>' +
                '<p class="mem-hint">Any OpenAI-compatible or Anthropic-compatible endpoint works.</p>' +
            '</div>' +

            // INJECT TAB
            '<div class="mem-tab-content" id="tab-inject">' +
                '<div class="mem-field"><label>Inject position</label>' +
                    '<select id="mem-inject-pos">' +
                        '<option value="after_an">After Author\'s Note</option>' +
                        '<option value="before_an">Before Author\'s Note</option>' +
                        '<option value="top">Top of context</option>' +
                    '</select>' +
                '</div>' +
                '<div class="mem-field"><label>What to inject</label>' +
                    '<div class="mem-checks">' +
                        '<label><input type="checkbox" id="inj-characters"> Characters &amp; Relations</label>' +
                        '<label><input type="checkbox" id="inj-events"> Events</label>' +
                        '<label><input type="checkbox" id="inj-secrets"> Secrets</label>' +
                    '</div>' +
                '</div>' +
            '</div>' +

        '</div>' +
    '</div>';
}

// ─── Settings Events ──────────────────────────────────────────
function bindSettingsEvents() {
    $('#mem-ext-toggle-btn').on('click', function() {
        var $body = $('#mem-ext-body');
        $body.toggleClass('collapsed');
        $('#mem-ext-toggle-btn .mem-ext-chevron').text($body.hasClass('collapsed') ? '\u25B8' : '\u25BE');
    });

    $(document).on('click', '.mem-tab', function() {
        $('.mem-tab').removeClass('active');
        $('.mem-tab-content').removeClass('active');
        $(this).addClass('active');
        $('#tab-' + $(this).data('tab')).addClass('active');
    });

    $(document).on('click', '.mem-filter', function() {
        $('.mem-filter').removeClass('active');
        $(this).addClass('active');
        renderFactsPanel($(this).data('filter'));
    });

    $('#mem-enabled').on('change', function() {
        settings.enabled = this.checked;
        $('#mem-status-lbl').text(this.checked ? 'Enabled' : 'Disabled');
        saveSettings();
    });

    $('#mem-scan-btn').on('click', function() { runExtraction(); });

    $('#mem-clear-btn').on('click', function() {
        if (!confirm('Clear all memory for this chat?')) return;
        saveFacts({ characters: [], relations: [], events: [], secrets: [] });
        setExtensionPrompt(PROMPT_KEY, '');
        renderFactsPanel();
        showToast('Memory cleared');
    });

    $('#mem-trigger-mode').on('change', function() {
        settings.triggerMode = this.value;
        $('#mem-interval-wrap').toggle(this.value === 'auto');
        saveSettings();
    });

    $('#mem-trigger-interval').on('input', function() {
        settings.triggerInterval = parseInt(this.value);
        $('#mem-interval-val').text(this.value);
        saveSettings();
    });

    $('#mem-scan-last').on('change',   function() { settings.scanLastN = parseInt(this.value);  saveSettings(); });
    $('#mem-api-url').on('change',     function() { settings.apiUrl    = this.value.trim();     saveSettings(); });
    $('#mem-api-key').on('change',     function() { settings.apiKey    = this.value.trim();     saveSettings(); });
    $('#mem-api-model').on('change',   function() { settings.apiModel  = this.value.trim();     saveSettings(); });
    $('#mem-inject-pos').on('change',  function() { settings.injectPosition = this.value;       saveSettings(); });

    $('#mem-api-source').on('change', function() {
        settings.useCustomApi = this.value === 'custom';
        $('#mem-custom-api-fields').toggle(settings.useCustomApi);
        saveSettings();
    });

    $('#inj-characters').on('change', function() { settings.injectCategories.characters = this.checked; saveSettings(); });
    $('#inj-events').on('change',     function() { settings.injectCategories.events     = this.checked; saveSettings(); });
    $('#inj-secrets').on('change',    function() { settings.injectCategories.secrets    = this.checked; saveSettings(); });

    $(document).on('click', '.mem-fact-delete', function() {
        var id    = $(this).data('id');
        var cat   = $(this).data('cat');
        var facts = loadFacts();
        facts[cat] = (facts[cat] || []).filter(function(f) { return f._id !== id; });
        saveFacts(facts);
        injectMemoryIntoContext(facts);
        renderFactsPanel($('.mem-filter.active').data('filter') || 'all');
    });
}

function renderSettingsValues() {
    $('#mem-enabled').prop('checked', settings.enabled);
    $('#mem-status-lbl').text(settings.enabled ? 'Enabled' : 'Disabled');
    $('#mem-trigger-mode').val(settings.triggerMode);
    $('#mem-trigger-interval').val(settings.triggerInterval);
    $('#mem-interval-val').text(settings.triggerInterval);
    $('#mem-scan-last').val(settings.scanLastN);
    $('#mem-api-source').val(settings.useCustomApi ? 'custom' : 'st');
    $('#mem-custom-api-fields').toggle(settings.useCustomApi);
    $('#mem-api-url').val(settings.apiUrl);
    $('#mem-api-key').val(settings.apiKey);
    $('#mem-api-model').val(settings.apiModel);
    $('#mem-inject-pos').val(settings.injectPosition);
    $('#mem-interval-wrap').toggle(settings.triggerMode === 'auto');
    $('#inj-characters').prop('checked', settings.injectCategories.characters);
    $('#inj-events').prop('checked',     settings.injectCategories.events);
    $('#inj-secrets').prop('checked',    settings.injectCategories.secrets);
    renderFactsPanel();
}

function saveSettings() {
    Object.assign(extension_settings[EXT_NAME], settings);
    saveMetadataDebounced();
}

// ─── Facts Renderer ───────────────────────────────────────────
function renderFactsPanel(filter) {
    if (!filter) filter = 'all';
    var facts = loadFacts();
    var $list = $('#mem-facts-list');
    $list.empty();

    var sections = [
        { key: 'characters', label: 'Characters', items: facts.characters || [] },
        { key: 'relations',  label: 'Relations',  items: facts.relations  || [] },
        { key: 'events',     label: 'Events',     items: facts.events     || [] },
        { key: 'secrets',    label: 'Secrets',    items: facts.secrets    || [] },
    ];

    var total = 0;

    sections.forEach(function(sec) {
        if (filter !== 'all' && filter !== sec.key) return;
        if (!sec.items.length) return;

        var $sec = $('<div class="mem-section"><div class="mem-section-title">' + sec.label + ' <span class="mem-count">' + sec.items.length + '</span></div></div>');

        sec.items.forEach(function(item) {
            $sec.append(
                '<div class="mem-fact">' +
                    '<span class="mem-fact-text">' + formatFact(sec.key, item) + '</span>' +
                    '<button class="mem-fact-delete" data-id="' + item._id + '" data-cat="' + sec.key + '" title="Delete">&#x2715;</button>' +
                '</div>'
            );
            total++;
        });

        $list.append($sec);
    });

    if (!total) $list.html('<div class="mem-empty">Nothing here yet.</div>');
}

function formatFact(cat, item) {
    if (cat === 'characters') {
        var s = '<b>' + (item.name || '') + '</b>';
        if (item.status)         s += ' <em>[' + item.status + ']</em>';
        if (item.location)       s += ' @ ' + item.location;
        if (item.traits && item.traits.length) s += '<br><small>' + item.traits.join(', ') + '</small>';
        return s;
    }
    if (cat === 'relations') {
        return '<b>' + item.from + '</b> &harr; <b>' + item.to + '</b>: ' + item.type + (item.notes ? '<br><small>' + item.notes + '</small>' : '');
    }
    if (cat === 'events') {
        var s = item.what;
        if (item.where)       s += ' <small>@ ' + item.where + '</small>';
        if (item.consequence) s += '<br><small>&rarr; ' + item.consequence + '</small>';
        return s;
    }
    if (cat === 'secrets') {
        var s = item.fact;
        if (item.hidden_from && item.hidden_from.length) s += '<br><small>hidden from: ' + item.hidden_from.join(', ') + '</small>';
        return s;
    }
    return JSON.stringify(item);
}

// ─── Utils ────────────────────────────────────────────────────
function updateScanButton(scanning) {
    $('#mem-scan-btn').prop('disabled', scanning).text(scanning ? 'Scanning...' : 'Scan Now');
}

function showToast(msg, isError) {
    var $t = $('<div class="mem-toast' + (isError ? ' mem-toast-err' : '') + '">' + msg + '</div>');
    $('body').append($t);
    setTimeout(function() { $t.addClass('show'); }, 10);
    setTimeout(function() { $t.removeClass('show'); setTimeout(function() { $t.remove(); }, 300); }, 3000);
}

function countNew(incoming) {
    var nf = incoming.new_facts || {};
    return (nf.characters ? nf.characters.length : 0)
         + (nf.relations  ? nf.relations.length  : 0)
         + (nf.events     ? nf.events.length     : 0)
         + (nf.secrets    ? nf.secrets.length    : 0);
}

function uid() { return Math.random().toString(36).slice(2, 9); }

function similarity(a, b) {
    if (!a || !b) return 0;
    var sa = new Set(a.toLowerCase().split(/\s+/));
    var sb = new Set(b.toLowerCase().split(/\s+/));
    var inter = 0;
    sa.forEach(function(w) { if (sb.has(w)) inter++; });
    var union = new Set(Array.from(sa).concat(Array.from(sb))).size;
    return union === 0 ? 0 : inter / union;
}
