import { yaml } from '../../../../lib.js';
import { getStringHash } from '../../../utils.js';

const chatGenerations = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const sessionHeaders = new Set(['x-session-id', 'x-opencode-session', 'x-session-affinity']);
const idleLimitMs = 60 * 60 * 1000;
const { accountStorage, eventSource, eventTypes } = SillyTavern.getContext();

const indicator = document.createElement('div');
indicator.id = 'meridian-session-id';
indicator.title = 'Meridian session ID';
indicator.style.cssText = 'font: 9px/12px monospace; text-align: right; padding-inline: 6px; opacity: .7; user-select: text;';
indicator.hidden = true;
document.getElementById('send_form')?.before(indicator);

function getChatKey() {
    const { chatId, groupId, characters, characterId } = SillyTavern.getContext();
    if (chatId == null || chatId === '') return;

    const chatOwner = groupId != null ? ['group', groupId] : ['character', characters[characterId]?.avatar];
    return getStringHash(JSON.stringify([location.origin, chatOwner, chatId])).toString(36);
}

function showSession(id) {
    indicator.textContent = id ? `Meridian · ${id}` : '';
    indicator.hidden = !id;
}

function showSavedSession() {
    const chatKey = getChatKey();
    const saved = chatKey && accountStorage.getItem(`meridian-session:${chatKey}`);
    showSession(saved?.split(' ')[0]);
}

eventSource.on(eventTypes.APP_READY, showSavedSession);
eventSource.on(eventTypes.CHAT_CHANGED, showSavedSession);

eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, request => {
    if (request.chat_completion_source !== 'custom' || !chatGenerations.has(request.type)
        || !request.model?.startsWith('claude-') || !URL.canParse(request.custom_url)
        || new URL(request.custom_url).port !== '3456') {
        return;
    }

    const chatKey = getChatKey();
    if (!chatKey) return;

    let configuredHeaders;
    try {
        configuredHeaders = yaml.parse(request.custom_include_headers || '');
    } catch {
        return;
    }

    const layers = Array.isArray(configuredHeaders) ? configuredHeaders : [configuredHeaders];
    const headers = Object.assign(Object.create(null), ...layers.filter(layer => layer
        && typeof layer === 'object' && !Array.isArray(layer)));
    for (const name of Object.keys(headers)) {
        if (sessionHeaders.has(name.toLowerCase())) delete headers[name];
    }

    const storageKey = `meridian-session:${chatKey}`;
    const [savedId, lastUsed] = (accountStorage.getItem(storageKey) ?? '').split(' ');
    const now = Date.now();
    const idleMs = now - Number(lastUsed);
    const id = savedId && idleMs >= 0 && idleMs <= idleLimitMs ? savedId : `st-${chatKey}-${now.toString(36)}`;
    accountStorage.setItem(storageKey, `${id} ${now}`);
    headers['x-session-id'] = id;
    request.custom_include_headers = JSON.stringify(headers);
    showSession(id);
});
