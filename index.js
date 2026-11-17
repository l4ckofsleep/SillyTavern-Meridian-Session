import { yaml } from '../../../../lib.js';
import { getStringHash } from '../../../utils.js';

const chatGenerations = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const sessionHeaders = new Set(['x-session-id', 'x-opencode-session', 'x-session-affinity']);
const { eventSource, eventTypes } = SillyTavern.getContext();

eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, request => {
    if (request.chat_completion_source !== 'custom' || !chatGenerations.has(request.type)
        || !request.model?.startsWith('claude-') || !URL.canParse(request.custom_url)
        || new URL(request.custom_url).port !== '3456') {
        return;
    }

    const { chatId, groupId, characters, characterId } = SillyTavern.getContext();
    if (chatId == null || chatId === '') return;

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

    const chatOwner = groupId != null ? ['group', groupId] : ['character', characters[characterId]?.avatar];
    const chatKey = JSON.stringify([location.origin, chatOwner, chatId]);
    headers['x-session-id'] = `st-${getStringHash(chatKey).toString(36)}`;
    request.custom_include_headers = JSON.stringify(headers);
});
