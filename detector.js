const CATEGORIES = Object.freeze({
    longer: { label: 'Longer sequences', words: 10 },
    long: { label: 'Long sequences', words: 5 },
    short: { label: 'Short sequences', words: 4 },
});
function tokenize(text) {
    const result = [], re = /\S+/gu;
    let match;
    while ((match = re.exec(String(text ?? '')))) {
        const raw = match[0], normalized = raw.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (normalized) result.push({ raw, normalized, start: match.index, end: re.lastIndex });
    }
    return result;
}
function overlaps(a, b) { return a.messageId === b.messageId && a.start < b.end && b.start < a.end; }
export function detectRepetitions(chat, settings = {}) {
    const groups = new Map();
    for (let messageId = 0; messageId < (chat?.length ?? 0); messageId++) {
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') continue;
        const tokens = tokenize(message.mes);
        for (const [category, definition] of Object.entries(CATEGORIES)) {
            if (settings.categories?.[category] === false) continue;
            for (let i = 0; i <= tokens.length - definition.words; i++) {
                const part = tokens.slice(i, i + definition.words);
                // Do not create a single repetition that crosses a sentence boundary.
                if (part.slice(0, -1).some(x => /[.!?]$/.test(x.raw))) continue;
                const key = `${category}:${part.map(x => x.normalized).join(' ')}`;
                if (!groups.has(key)) groups.set(key, { key, category, text: message.mes.slice(part[0].start, part.at(-1).end), occurrences: [] });
                groups.get(key).occurrences.push({ messageId, start: part[0].start, end: part.at(-1).end, text: message.mes.slice(part[0].start, part.at(-1).end) });
            }
        }
    }
    const cutoff = Math.max(2, Number(settings.cutoff) || 2);
    const candidates = [...groups.values()].filter(x => x.occurrences.length >= cutoff);
    candidates.sort((a, b) => CATEGORIES[b.category].words - CATEGORIES[a.category].words || b.occurrences.length - a.occurrences.length);
    const accepted = [];
    for (const candidate of candidates) {
        const remaining = candidate.occurrences.filter(o => !accepted.some(a => a.occurrences.some(x => overlaps(x, o))));
        if (remaining.length >= cutoff) accepted.push({ ...candidate, occurrences: remaining, count: remaining.length });
    }
    return accepted.map((x, index) => ({ ...x, id: `rep-${index}` }));
}
export function getCategoryDefinitions() { return CATEGORIES; }

