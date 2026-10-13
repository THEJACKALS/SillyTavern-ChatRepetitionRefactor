export function buildAutoClean(messageText, occurrences) {
    let result = messageText;
    for (const occurrence of [...occurrences].sort((a, b) => b.start - a.start)) {
        const before = result.slice(0, occurrence.start);
        if (!before.trim() || !/[.!?\n]$/.test(before.trimEnd())) continue;
        result = `${before}${result.slice(occurrence.end)}`.replace(/([.!?])\s{2,}/g, '$1 ');
    }
    return result;
}
export function makePreview(chat, changes) { return changes.map(x => ({ messageId: x.messageId, before: chat[x.messageId]?.mes ?? '', after: x.after })); }

