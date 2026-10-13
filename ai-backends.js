export const AI_BACKENDS = {
    current_st: { label: 'Current SillyTavern API', kind: 'current' },
    horde: { label: 'AI Horde', kind: 'horde' },
    ollama: { label: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    openai_compatible: { label: 'OpenAI-Compatible', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
    lm_studio: { label: 'LM Studio', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' },
    llamacpp: { label: 'llama.cpp', kind: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' },
    koboldcpp: { label: 'KoboldCPP', kind: 'openai', baseUrl: 'http://127.0.0.1:5001/v1' },
    aphrodite: { label: 'Aphrodite', kind: 'openai', baseUrl: 'http://127.0.0.1:2242/v1' },
    mancer: { label: 'Mancer', kind: 'openai', baseUrl: 'https://neuro.mancer.tech/v1' },
};

export function createDefaultAiProfiles() {
    return Object.fromEntries(Object.entries(AI_BACKENDS).map(([key, backend]) => [key, {
        baseUrl: backend.baseUrl || '', model: '', apiKey: '', models: [], requestTimeoutMs: 120000,
    }]));
}

export function ensureAiProfiles(settings) {
    settings.aiProfiles ??= createDefaultAiProfiles();
    for (const [key, backend] of Object.entries(AI_BACKENDS)) {
        settings.aiProfiles[key] ??= { baseUrl: backend.baseUrl || '', model: '', apiKey: '', models: [], requestTimeoutMs: 120000 };
        settings.aiProfiles[key].models ??= [];
        if (key === 'current_st') continue;
        if (!settings.aiProfiles[key].baseUrl && settings.aiBaseUrl && settings.aiBackend === key) settings.aiProfiles[key].baseUrl = settings.aiBaseUrl;
        if (!settings.aiProfiles[key].model && settings.aiModel && settings.aiBackend === key) settings.aiProfiles[key].model = settings.aiModel;
        if (!settings.aiProfiles[key].apiKey && settings.aiApiKey && settings.aiBackend === key) settings.aiProfiles[key].apiKey = settings.aiApiKey;
    }
    return settings.aiProfiles;
}

function normalizeBaseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function headersFor(profile) {
    const headers = { 'Content-Type': 'application/json' };
    if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
    return headers;
}

export async function refreshAiBackendModels(backendKey, profile, context) {
    const backend = AI_BACKENDS[backendKey];
    if (!backend || backend.kind === 'current') return [];
    if (backend.kind === 'horde') {
        const direct = Boolean(profile.apiKey);
        const response = direct
            ? await fetch('https://aihorde.net/api/v2/status/models?type=text', { headers: { apikey: profile.apiKey, 'Client-Agent': 'SillyTavern-Repetition-Repair' } })
            : await fetch('/api/horde/text-models', { method: 'POST', headers: context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) });
        if (!response.ok) throw new Error(`Refresh AI Horde models failed (${response.status}).`);
        const entries = await response.json();
        const models = (Array.isArray(entries) ? entries : []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
        profile.models = models;
        return models;
    }
    const baseUrl = normalizeBaseUrl(profile.baseUrl);
    if (!baseUrl) throw new Error('Base URL is empty.');
    const endpoint = backend.kind === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
    const response = await fetch(endpoint, { headers: headersFor(profile) });
    if (!response.ok) throw new Error(`Refresh models failed (${response.status}).`);
    const data = await response.json();
    const models = backend.kind === 'ollama'
        ? (data.models || []).map(item => item.name).filter(Boolean)
        : (data.data || data.models || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
    profile.models = models;
    return models;
}

export async function testAiBackend(backendKey, profile, context) {
    const backend = AI_BACKENDS[backendKey];
    if (!backend) throw new Error('Unknown AI backend.');
    if (backend.kind === 'current') return `Current SillyTavern API (${context.mainApi || 'unknown'}) is selected.`;
    const models = await refreshAiBackendModels(backendKey, profile, context);
    return `${backend.label} connected. ${models.length} model(s) found.`;
}

export async function generateAiBackendText(backendKey, profile, prompt, sourceLength, context) {
    const backend = AI_BACKENDS[backendKey];
    const maxTokens = Math.max(300, Math.min(1200, sourceLength + 160));
    if (backend?.kind === 'current') {
        if (typeof context.generateQuietPrompt !== 'function') throw new Error('SillyTavern generateQuietPrompt() is not available.');
        return await context.generateQuietPrompt({ quietPrompt: prompt, quietName: 'Repetition Repair', skipWIAN: true, removeReasoning: true, trimToSentence: false, responseLength: maxTokens });
    }
    if (backend?.kind === 'horde') {
        if (!profile.model) throw new Error('Select an AI Horde model first.');
        const direct = Boolean(profile.apiKey);
        const headers = direct ? { 'Content-Type': 'application/json', apikey: profile.apiKey, 'Client-Agent': 'SillyTavern-Repetition-Repair' } : (context.getRequestHeaders?.() || { 'Content-Type': 'application/json' });
        const response = await fetch(direct ? 'https://aihorde.net/api/v2/generate/text/async' : '/api/horde/generate-text', { method: 'POST', headers, body: JSON.stringify({
            prompt: `${prompt}\n\nAssistant rewrite:\n`,
            params: { n: 1, max_length: maxTokens, max_context_length: Math.max(2048, Math.min(32768, Math.ceil(prompt.length / 3) + maxTokens)), temperature: .2, top_p: .9, top_k: 0, rep_pen: 1.05, frmtadsnsp: false, frmtrmblln: false, frmtrmspch: false, frmttriminc: false },
            trusted_workers: false,
            models: [profile.model],
        }) });
        if (!response.ok) throw new Error(`AI Horde generation failed (${response.status}).`);
        const task = await response.json();
        if (task?.error) throw new Error(task.error.message || 'AI Horde rejected the request.');
        const startedAt = Date.now();
        const timeout = Number(profile.requestTimeoutMs) || 120000;
        while (Date.now() - startedAt < timeout) {
            await new Promise(resolve => setTimeout(resolve, 2500));
            const statusResponse = direct
                ? await fetch(`https://aihorde.net/api/v2/generate/text/status/${task.id}`, { headers })
                : await fetch('/api/horde/task-status', { method: 'POST', headers, body: JSON.stringify({ taskId: task.id }) });
            if (!statusResponse.ok) throw new Error(`AI Horde status failed (${statusResponse.status}).`);
            const status = await statusResponse.json();
            if (status.faulted) throw new Error('AI Horde request faulted.');
            if (status.is_possible === false) throw new Error(`No AI Horde worker can run model "${profile.model}".`);
            if (status.done && status.generations?.length) return String(status.generations[0].text || '').trim();
        }
        if (direct) fetch(`https://aihorde.net/api/v2/generate/text/status/${task.id}`, { method: 'DELETE', headers }).catch(() => { });
        else fetch('/api/horde/cancel-task', { method: 'POST', headers, body: JSON.stringify({ taskId: task.id }) }).catch(() => { });
        throw new Error(`AI Horde request timed out after ${timeout} ms.`);
    }
    const baseUrl = normalizeBaseUrl(profile.baseUrl);
    const model = String(profile.model || '').trim();
    if (!baseUrl || !model) throw new Error('Configure the selected AI backend base URL and model first.');
    const headers = headersFor(profile);
    let endpoint = `${baseUrl}/chat/completions`;
    let body = { model, messages: [{ role: 'user', content: prompt }], temperature: .2, max_tokens: maxTokens, stream: false };
    if (backend.kind === 'ollama') {
        endpoint = `${baseUrl}/api/chat`;
        body = { model, messages: [{ role: 'user', content: prompt }], stream: false, options: { temperature: .2 } };
    }
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`AI backend error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data?.message?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.response ?? '';
}

