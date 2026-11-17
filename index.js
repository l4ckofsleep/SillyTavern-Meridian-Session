import { yaml } from '../../../../lib.js';
import { getStringHash } from '../../../utils.js';
import { promptManager } from '../../../openai.js';
import { INJECTION_POSITION } from '../../../PromptManager.js';

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

function separateTailInstructions(request) {
    const built = promptManager?.messages?.flatten().filter(message => message.content || message.tool_calls);
    if (!Array.isArray(request.messages) || built?.length !== request.messages.length) return;
    const matches = built.every((message, index) => message.role === request.messages[index].role
        && JSON.stringify(message.content) === JSON.stringify(request.messages[index].content));
    if (!matches) return;

    const promptGroups = new Map();
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
    for (const item of order) {
        const template = promptManager.getPromptById(item.identifier);
        if (!item.enabled || template?.injection_position !== INJECTION_POSITION.ABSOLUTE
            || template.injection_depth !== 0 || !template.content || !promptManager.shouldTrigger(template, request.type)) continue;
        // shortcut: state-changing macros stay untouched until resolved prompt metadata is available.
        if (/\{\{\s*(?:setvar|setglobalvar|addvar|addglobalvar|incvar|incglobalvar|decvar|decglobalvar)\b/i.test(template.content)) continue;
        const prompt = promptManager.preparePrompt(template);
        const key = JSON.stringify([prompt.injection_order ?? 100, prompt.role]);
        const group = promptGroups.get(key) ?? { role: prompt.role, parts: [] };
        group.parts.push(prompt.content);
        promptGroups.set(key, group);
    }
    const depthZero = [...promptGroups.values()].map(group => ({ role: group.role, content: group.parts.join('\n').trim() }));
    let lastHistory = built.findLastIndex(message => message.identifier?.startsWith('chatHistory-'));
    while (lastHistory >= 0) {
        const match = depthZero.findIndex(prompt => prompt.role === built[lastHistory].role && prompt.content === built[lastHistory].content);
        if (match < 0) break;
        depthZero.splice(match, 1);
        lastHistory = built.findLastIndex((message, index) => index < lastHistory && message.identifier?.startsWith('chatHistory-'));
    }
    if (lastHistory < 0 || lastHistory === built.length - 1) return;
    const tail = request.messages.slice(lastHistory + 1);
    if (!tail.every(message => ['system', 'user', 'assistant'].includes(message.role)
        && typeof message.content === 'string' && !message.tool_calls)) return;

    // A per-turn footer must not become part of the previous user message on resume.
    request.messages = request.messages.map((message, index) => index <= lastHistory ? message : {
        ...message,
        role: 'system',
        content: message.role === 'assistant'
            ? `Start the next assistant response with this exact prefix:\n${message.content}`
            : message.content,
    });
    request.custom_prompt_post_processing = '';
}

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
    separateTailInstructions(request);
    showSession(id);
});
