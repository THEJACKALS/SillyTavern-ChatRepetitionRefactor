import { getContext } from '../../../extensions.js';
import { detectRepetitions, getCategoryDefinitions } from './detector.js';
import { buildAutoClean, makePreview } from './repair.js';
import { AI_BACKENDS, createDefaultAiProfiles, ensureAiProfiles, generateAiBackendText, refreshAiBackendModels, testAiBackend } from './ai-backends.js';

const context = getContext();
const EXTENSION_ID = 'repetition_repair';
const defaults = { enabled: true, cutoff: 2, categories: { longer: true, long: true, short: true }, repairMode: 'auto', aiBackend: 'current_st', aiProfiles: createDefaultAiProfiles() };
const state = { results: [], selected: new Set(), selectedOccurrences: new Set(), openCategories: null, openGroups: null, undo: null, overlay: null, resultsPanel: null };
const settings = context.extensionSettings[EXTENSION_ID] ??= structuredClone(defaults);
for (const [key, value] of Object.entries(defaults)) if (settings[key] === undefined) settings[key] = structuredClone(value);
settings.categories ??= structuredClone(defaults.categories);
ensureAiProfiles(settings);
const node = (tag, attrs = {}, children = []) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') element.textContent = value;
        else if (key === 'class') element.className = value;
        else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) element.setAttribute(key, value);
    }
    if (tag === 'button' && !element.className) element.className = 'menu_button reprep-btn';
    for (const child of children) element.append(child);
    return element;
};
const saveSettings = () => context.saveSettingsDebounced();

function scan() {
    state.results = settings.enabled ? detectRepetitions(context.chat, settings) : [];
    // Keep scan results unselected by default so repairs are always an explicit user choice.
    state.selected = new Set();
    state.selectedOccurrences = new Set();
    // Start every scan collapsed. Users can open only the category/group they want to inspect.
    state.openCategories = new Set();
    state.openGroups = new Set();
    renderReview();
    toastr.info(`${state.results.length} repetition group(s) found.`);
}
function clearResults() { state.results = []; state.selected.clear(); state.selectedOccurrences.clear(); state.openCategories = new Set(); state.openGroups = new Set(); renderReview(); }
function syncSelectionUi() {
    if (!state.resultsPanel) return;
    state.resultsPanel.querySelectorAll('[data-reprep-group]').forEach(input => {
        const groupId = input.dataset.reprepGroup;
        input.checked = state.selected.has(groupId);
        input.closest('.reprep-card')?.classList.toggle('is-disabled', !state.selected.has(groupId));
    });
    state.resultsPanel.querySelectorAll('[data-reprep-occurrence]').forEach(input => {
        input.checked = state.selectedOccurrences.has(input.dataset.reprepOccurrence);
    });
}
function contextMarkup(message, occurrence) {
    const from = Math.max(0, occurrence.start - 100), to = Math.min(message.mes.length, occurrence.end + 100);
    const box = node('div', { class: 'reprep-context' });
    box.append(document.createTextNode(message.mes.slice(from, occurrence.start)));
    box.append(node('mark', { class: 'reprep-highlight', text: message.mes.slice(occurrence.start, occurrence.end) }));
    box.append(document.createTextNode(message.mes.slice(occurrence.end, to)));
    return box;
}
function locateMessage(messageId) {
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return toastr.warning(`Message ${messageId} is not currently rendered.`);
    messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    messageElement.classList.add('reprep-locate-highlight');
    setTimeout(() => messageElement.classList.remove('reprep-locate-highlight'), 1400);
}
function messageLabel(message, messageId) {
    const label = node('div', { class: 'reprep-message-label' });
    label.append(
        node('span', { text: `Message ${messageId} (${message.name || (message.is_user ? 'User' : 'Character')})` }),
        node('button', { class: 'menu_button reprep-locate-btn', text: 'Locate', title: 'Locate message', onclick: event => { event.stopPropagation(); locateMessage(messageId); } }),
    );
    return label;
}
function filterResultsUi(query) {
    const needle = query.trim().toLocaleLowerCase();
    document.querySelectorAll('#reprep_results_panel .reprep-result-section').forEach(section => {
        const content = section.querySelector('.reprep-category-content');
        let sectionMatches = false;
        [...(content?.children || [])].filter(card => card.classList.contains('reprep-card')).forEach(card => {
            const blocks = [...card.querySelectorAll('.reprep-chat-block')];
            let cardMatches = !needle;
            for (const block of blocks) {
                const matches = !needle || (block.dataset.reprepSearch || '').includes(needle);
                block.style.display = matches ? '' : 'none';
                cardMatches ||= matches;
            }
            card.style.display = cardMatches ? '' : 'none';
            sectionMatches ||= cardMatches;
            if (needle && cardMatches) {
                const groupContent = card.querySelector('.reprep-group-content');
                if (groupContent) groupContent.style.display = 'block';
                state.openGroups.add(card.dataset.reprepCard);
            }
        });
        section.style.display = !needle || sectionMatches ? '' : 'none';
        if (needle && sectionMatches) {
            const categoryContent = section.querySelector('.reprep-category-content');
            if (categoryContent) categoryContent.style.display = 'block';
            const category = Object.entries(getCategoryDefinitions()).find(([, definition]) => section.querySelector('.reprep-category-title')?.textContent?.startsWith(definition.label))?.[0];
            if (category) state.openCategories.add(category);
        }
    });
}
function locationField() {
    const input = node('input', { class: 'text_pole reprep-location-input', type: 'search', placeholder: 'Find text in messages...', title: 'Filter occurrences by text found in the chat' });
    input.addEventListener('input', event => filterResultsUi(event.target.value));
    const field = node('div', { class: 'reprep-location-field' });
    field.append(node('label', { text: 'Find in messages' }), input);
    return field;
}
function renderReview() {
    if (state.resultsPanel) {
        renderResultsPanel();
        return;
    }
    if (!state.overlay) { state.overlay = node('div', { id: 'reprep_review', class: 'popup' }); document.body.append(state.overlay); }
    state.overlay.replaceChildren(node('h3', { text: 'Chat Repetition Refactor' }));
    const toolbar = node('div', { class: 'reprep-toolbar' });
    toolbar.append(node('button', { text: 'Select All', onclick: () => { state.results.forEach(x => state.selected.add(x.id)); renderReview(); } }));
    toolbar.append(node('button', { text: 'Deselect All', onclick: () => { state.selected.clear(); renderReview(); } }));
    toolbar.append(node('button', { text: 'Scan Current Chat', onclick: scan }));
    toolbar.append(node('button', { text: 'Clear Results', onclick: clearResults }));
    toolbar.append(node('button', { text: 'Undo Last Repair', onclick: undoLast }));
    for (const [key, definition] of Object.entries(getCategoryDefinitions())) toolbar.append(node('label', {}, [node('input', { type: 'checkbox', checked: settings.categories[key] ? '' : null, onchange: (event) => { settings.categories[key] = event.target.checked; saveSettings(); renderReview(); } }), document.createTextNode(` ${definition.label}`)]));
    const mode = node('select', { onchange: (event) => { settings.repairMode = event.target.value; saveSettings(); } }, [node('option', { value: 'auto', text: 'Auto-Clean' }), node('option', { value: 'rewrite', text: 'Rewrite' }), node('option', { value: 'rewrite_ai', text: 'Rewrite (AI Generated)' })]);
    mode.value = settings.repairMode;
    toolbar.append(mode, node('button', { text: 'Repair Selected', onclick: repairSelected }));
    state.overlay.append(toolbar);
    if (!state.results.length) state.overlay.append(node('p', { text: 'No scan results. Run a scan to review the current chat.' }));
    for (const result of state.results) {
        const card = node('article', { class: `reprep-card${state.selected.has(result.id) ? '' : ' is-disabled'}` });
        card.append(node('label', {}, [node('input', { type: 'checkbox', checked: state.selected.has(result.id) ? '' : null, onchange: (event) => { event.target.checked ? state.selected.add(result.id) : state.selected.delete(result.id); renderReview(); } }), document.createTextNode(' Select ')]));
        card.append(node('span', { class: 'reprep-category', text: getCategoryDefinitions()[result.category].label }));
        card.append(node('p', { text: `Occurrences: ${result.count} · ${result.text}` }));
        for (const occurrence of result.occurrences) { const message = context.chat[occurrence.messageId]; if (message) card.append(messageLabel(message, occurrence.messageId), contextMarkup(message, occurrence)); }
        state.overlay.append(card);
    }
}

function renderResultsPanel() {
    const panel = state.resultsPanel;
    if (!panel) return;
    panel.replaceChildren();
    const heading = node('div', { class: 'reprep-results-heading' });
    heading.append(node('strong', { text: 'Scan Results' }), node('span', { text: state.results.length ? ` ${state.results.length} group(s)` : ' No repetitions found' }));
    panel.append(heading);
    if (!state.results.length) {
        panel.append(node('p', { class: 'reprep-empty', text: 'No results yet. Click Scan Current Chat.' }));
        return;
    }
    panel.append(locationField());
    const colors = { longer: 'reprep-section-longer', long: 'reprep-section-long', short: 'reprep-section-short' };
    for (const [category, definition] of Object.entries(getCategoryDefinitions())) {
        const groups = state.results.filter(result => result.category === category);
        const section = node('section', { class: `reprep-result-section inline-drawer ${colors[category]}` });
        const title = node('div', { class: 'inline-drawer-toggle inline-drawer-header reprep-category-header' });
        const titleText = node('strong', { class: 'reprep-category-title', text: `${definition.label} (${groups.length})` });
        const categoryActions = node('div', { class: 'reprep-category-actions' });
        const selectCategory = node('button', { text: 'Select All' });
        const deselectCategory = node('button', { text: 'Deselect All' });
        for (const button of [selectCategory, deselectCategory]) button.addEventListener('click', event => event.stopPropagation());
        selectCategory.addEventListener('click', () => setCategorySelection(category, true));
        deselectCategory.addEventListener('click', () => setCategorySelection(category, false));
        categoryActions.append(selectCategory, deselectCategory);
        title.append(titleText, categoryActions, node('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }));
        const sectionContent = node('div', { class: 'inline-drawer-content reprep-category-content' });
        if (state.openCategories === null || state.openCategories.has(category)) sectionContent.style.display = 'block';
        else sectionContent.style.display = 'none';
        title.addEventListener('click', event => {
            if (event.target.closest('.reprep-category-actions')) return;
            if (sectionContent.style.display === 'none') state.openCategories.add(category);
            else state.openCategories.delete(category);
        });
        section.append(title, sectionContent);
        if (!groups.length) sectionContent.append(node('p', { class: 'reprep-empty', text: 'No results in this category.' }));
        for (const result of groups) {
            const card = node('div', { class: `reprep-card inline-drawer${state.selected.has(result.id) ? '' : ' is-disabled'}`, 'data-reprep-card': result.id });
            const groupHeader = node('div', { class: 'inline-drawer-toggle reprep-group-header' });
            const groupCheckbox = node('input', { type: 'checkbox', 'data-reprep-group': result.id, checked: state.selected.has(result.id) ? '' : null });
            groupCheckbox.addEventListener('change', (event) => { event.target.checked ? state.selected.add(result.id) : state.selected.delete(result.id); result.occurrences.forEach((_, index) => event.target.checked ? state.selectedOccurrences.add(`${result.id}:${index}`) : state.selectedOccurrences.delete(`${result.id}:${index}`)); syncSelectionUi(); });
            const groupLabel = node('label', { class: 'checkbox_label reprep-group-check' }, [groupCheckbox, node('span', { text: 'Select group' })]);
            groupLabel.addEventListener('click', event => event.stopPropagation());
            groupHeader.append(groupLabel, node('strong', { class: 'reprep-group-title', text: `Group · ${result.count} occurrence(s)` }), node('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }));
            const groupContent = node('div', { class: 'inline-drawer-content reprep-group-content' });
            if (state.openGroups === null || state.openGroups.has(result.id)) groupContent.style.display = 'block';
            else groupContent.style.display = 'none';
            groupHeader.addEventListener('click', event => {
                if (event.target.closest('.reprep-group-check')) return;
                if (groupContent.style.display === 'none') state.openGroups.add(result.id);
                else state.openGroups.delete(result.id);
            });
            groupContent.append(node('p', { class: 'reprep-result-text', text: result.text }), node('small', { text: `Occurrences: ${result.count}` }));
            for (const occurrence of result.occurrences) {
                const message = context.chat[occurrence.messageId];
                if (!message) continue;
                const occurrenceIndex = result.occurrences.indexOf(occurrence);
                const chatBlock = node('div', { class: 'reprep-chat-block', 'data-reprep-search': `${message.mes} ${occurrence.text}`.toLocaleLowerCase() });
                const occurrenceCheckbox = node('input', { type: 'checkbox', 'data-reprep-occurrence': `${result.id}:${occurrenceIndex}`, checked: state.selectedOccurrences.has(`${result.id}:${occurrenceIndex}`) ? '' : null });
                occurrenceCheckbox.addEventListener('change', (event) => {
                    event.target.checked ? state.selectedOccurrences.add(`${result.id}:${occurrenceIndex}`) : state.selectedOccurrences.delete(`${result.id}:${occurrenceIndex}`);
                    state.selected = new Set(state.results.filter(group => group.occurrences.some((_, index) => state.selectedOccurrences.has(`${group.id}:${index}`))).map(group => group.id));
                    syncSelectionUi();
                });
                chatBlock.append(node('label', { class: 'checkbox_label reprep-chat-check' }, [occurrenceCheckbox, node('span', { text: occurrenceIndex === 0 ? 'Original occurrence (kept)' : 'Repeated occurrence' })]));
                chatBlock.append(messageLabel(message, occurrence.messageId), contextMarkup(message, occurrence));
                groupContent.append(chatBlock);
            }
            card.append(groupHeader, groupContent);
            sectionContent.append(card);
        }
        panel.append(section);
    }
}

function setCategorySelection(category, checked) {
    for (const result of state.results.filter(item => item.category === category)) {
        checked ? state.selected.add(result.id) : state.selected.delete(result.id);
        result.occurrences.forEach((_, index) => checked ? state.selectedOccurrences.add(`${result.id}:${index}`) : state.selectedOccurrences.delete(`${result.id}:${index}`));
    }
    syncSelectionUi();
}
async function applyChanges(changes, { askConfirmation = true } = {}) {
    if (!changes.length) return;
    const preview = makePreview(context.chat, changes);
    if (askConfirmation) {
        const confirmed = context.callGenericPopup ? await context.callGenericPopup(`Apply ${changes.length} repair(s)?`, context.POPUP_TYPE?.CONFIRM) : window.confirm(`Apply ${changes.length} repair(s)?`);
        if (confirmed === false) return;
    }
    state.undo = { chatId: context.chatId, changes: preview };
    for (const change of changes) context.chat[change.messageId].mes = change.after;
    await context.saveChat(); await context.reloadCurrentChat(); clearResults(); toastr.success('Repair applied. Undo is available for the most recent operation.');
}

function paragraphAt(text, offset) {
    const separators = /\n\s*\n/g;
    let start = 0;
    let end = text.length;
    let match;
    while ((match = separators.exec(text))) {
        if (match.index < offset) start = match.index + match[0].length;
        else { end = match.index; break; }
    }
    return { start, end, text: text.slice(start, end) };
}

function collectAiParagraphs(groups) {
    const paragraphs = new Map();
    for (const group of groups) for (const occurrence of group.occurrences) {
        const message = context.chat[occurrence.messageId];
        if (!message || typeof message.mes !== 'string') continue;
        const paragraph = paragraphAt(message.mes, occurrence.start);
        const key = `${occurrence.messageId}:${paragraph.start}:${paragraph.end}`;
        if (!paragraphs.has(key)) paragraphs.set(key, { key, messageId: occurrence.messageId, ...paragraph, groups: [] });
        paragraphs.get(key).groups.push(group.id);
    }
    return [...paragraphs.values()];
}

async function generateAiParagraph(paragraph) {
    const prompt = `Rewrite exactly the paragraph below to remove repetitive or redundant wording. Preserve the original meaning, facts, character voice, roleplay context, tense, formatting, and language. Do not add events, explanations, headings, or commentary. Return only the rewritten paragraph.\n\nParagraph:\n${paragraph.text.trim()}`;
    const generated = await generateAiBackendText(settings.aiBackend, settings.aiProfiles[settings.aiBackend], prompt, paragraph.text.length, context);
    const text = String(generated || '').trim();
    if (!text) throw new Error('AI returned an empty rewrite.');
    return text;
}

async function rewriteWithAi(groups) {
    const paragraphs = collectAiParagraphs(groups);
    if (!paragraphs.length) return toastr.warning('No repeated paragraph was selected.');
    const warning = node('div');
    warning.append(node('h3', { text: 'Rewrite selected repetitions with AI?' }), node('p', { text: `This will generate ${paragraphs.length} paragraph(s) and may change the current chat.` }), node('p', { text: 'Only the paragraph(s) containing the selected repetitions will be sent to the active SillyTavern AI backend. Nothing is replaced until you click Replace.' }));
    const confirmed = context.callGenericPopup ? await context.callGenericPopup(warning, context.POPUP_TYPE?.CONFIRM) : window.confirm(`Generate ${paragraphs.length} AI rewrite(s) and review them first?`);
    if (confirmed === false) return;
    try {
        toastr.info(`Generating ${paragraphs.length} paragraph rewrite(s)...`);
        for (const paragraph of paragraphs) paragraph.generated = await generateAiParagraph(paragraph);
        showAiReview(paragraphs);
    } catch (error) {
        toastr.error(String(error.message || error));
    }
}

function showAiReview(paragraphs) {
    document.querySelector('#reprep_ai_review')?.remove();
    const layer = node('div', { id: 'reprep_ai_review', class: 'reprep-ai-review-layer' });
    const panel = node('div', { class: 'reprep-ai-review-panel' });
    panel.append(node('h3', { text: 'AI Rewrite Review' }), node('p', { text: `${paragraphs.length} paragraph(s) are ready for review. Edit any replacement before applying.` }));
    const fields = [];
    for (const [index, paragraph] of paragraphs.entries()) {
        const card = node('div', { class: 'reprep-ai-preview-card' });
        card.append(node('strong', { text: `Paragraph ${index + 1} · Message ${paragraph.messageId}` }));
        const field = node('textarea', { class: 'text_pole' });
        field.value = paragraph.generated;
        fields.push({ paragraph, field });
        card.append(field);
        panel.append(card);
    }
    const actions = node('div', { class: 'reprep-ai-actions' });
    const replace = node('button', { text: 'Replace' });
    const regenerate = node('button', { text: 'Regenerate' });
    const cancel = node('button', { text: 'Cancel' });
    actions.append(replace, regenerate, cancel);
    panel.append(actions);
    layer.append(panel);
    document.body.append(layer);
    cancel.addEventListener('click', () => layer.remove());
    regenerate.addEventListener('click', async () => {
        regenerate.disabled = true;
        regenerate.textContent = 'Regenerating...';
        try {
            for (const item of fields) item.paragraph.generated = await generateAiParagraph(item.paragraph);
            for (const item of fields) item.field.value = item.paragraph.generated;
        } catch (error) { toastr.error(String(error.message || error)); }
        finally { regenerate.disabled = false; regenerate.textContent = 'Regenerate'; }
    });
    replace.addEventListener('click', async () => {
        const grouped = new Map();
        for (const { paragraph, field } of fields) {
            const current = context.chat[paragraph.messageId]?.mes;
            if (!current || current.slice(paragraph.start, paragraph.end) !== paragraph.text) return toastr.warning(`Message ${paragraph.messageId} changed. Review was cancelled.`);
            if (!grouped.has(paragraph.messageId)) grouped.set(paragraph.messageId, { messageId: paragraph.messageId, after: current });
        }
        for (const [messageId, change] of grouped) {
            const items = fields.filter(item => item.paragraph.messageId === Number(messageId)).sort((a, b) => b.paragraph.start - a.paragraph.start);
            for (const { paragraph, field } of items) change.after = change.after.slice(0, paragraph.start) + field.value.trim() + change.after.slice(paragraph.end);
        }
        layer.remove();
        await applyChanges([...grouped.values()], { askConfirmation: false });
    });
}
async function repairSelected() {
    const selected = state.results.filter(x => state.selected.has(x.id));
    if (!selected.length) return toastr.warning('Select at least one repetition.');
    const selectedOccurrences = selected.map(group => ({ ...group, occurrences: group.occurrences.slice(1).filter((_, index) => state.selectedOccurrences.has(`${group.id}:${index + 1}`)) })).filter(group => group.occurrences.length);
    if (!selectedOccurrences.length) return toastr.warning('Select at least one repeated occurrence. The original occurrence is kept as reference.');
    if (settings.repairMode === 'rewrite') return openRewrite(selectedOccurrences);
    if (settings.repairMode === 'rewrite_ai') return rewriteWithAi(selectedOccurrences);
    const byMessage = new Map();
    for (const group of selectedOccurrences) for (const occurrence of group.occurrences) {
        if (!byMessage.has(occurrence.messageId)) byMessage.set(occurrence.messageId, []);
        byMessage.get(occurrence.messageId).push(occurrence);
    }
    await applyChanges([...byMessage].map(([messageId, occurrences]) => ({ messageId, after: buildAutoClean(context.chat[messageId].mes, occurrences) })).filter(x => x.after !== context.chat[x.messageId].mes));
}
function openRewrite(groups) {
    const dialog = node('div', { class: 'popup' }), fields = [];
    dialog.append(node('h3', { text: 'Review Rewrite' }));
    for (const group of groups) for (const occurrence of group.occurrences.slice(1)) { const field = node('textarea', { value: occurrence.text }); field.value = occurrence.text; fields.push({ occurrence, field }); dialog.append(node('p', { text: `Message ${occurrence.messageId}` }), field); }
    dialog.append(node('button', { text: 'Cancel', onclick: () => dialog.remove() }), node('button', { text: 'Apply Rewrite', onclick: async () => { const byMessage = new Map(); for (const { occurrence, field } of fields) { if (!byMessage.has(occurrence.messageId)) byMessage.set(occurrence.messageId, []); byMessage.get(occurrence.messageId).push({ ...occurrence, replacement: field.value }); } const changes = [...byMessage].map(([messageId, items]) => { let after = context.chat[messageId].mes; for (const item of items.sort((a, b) => b.start - a.start)) after = after.slice(0, item.start) + item.replacement + after.slice(item.end); return { messageId, after }; }); dialog.remove(); await applyChanges(changes); } }));
    document.body.append(dialog);
}
async function undoLast() {
    if (!state.undo || state.undo.chatId !== context.chatId) return toastr.info('No compatible repair to undo.');
    for (const change of state.undo.changes) if (context.chat[change.messageId]?.mes !== change.after) return toastr.warning(`Message ${change.messageId} changed after repair; undo was cancelled.`);
    for (const change of state.undo.changes) context.chat[change.messageId].mes = change.before;
    await context.saveChat(); await context.reloadCurrentChat(); state.undo = null; toastr.success('Last repair undone.');
}
function addSettings() {
    const container = node('div', { id: 'repetition_repair_settings', class: 'extension_settings inline-drawer' });
    const header = node('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [node('b', { text: 'Chat Repetition Refactor' }), node('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })]);
    const content = node('div', { class: 'inline-drawer-content' });
    container.append(header, content);
    content.append(node('label', { class: 'checkbox_label' }, [node('input', { type: 'checkbox', checked: settings.enabled ? '' : null, onchange: (event) => { settings.enabled = event.target.checked; saveSettings(); } }), document.createTextNode(' Enable repetition repair')]));
    const categories = node('div', { class: 'reprep-category-settings' });
    for (const [key, definition] of Object.entries(getCategoryDefinitions())) categories.append(node('label', { class: 'checkbox_label' }, [node('input', { type: 'checkbox', checked: settings.categories[key] ? '' : null, onchange: (event) => { settings.categories[key] = event.target.checked; saveSettings(); } }), node('span', { text: definition.label })]));
    let updateRepairBackendVisibility = () => { };
    const repairMode = node('select', { onchange: (event) => { settings.repairMode = event.target.value; saveSettings(); updateRepairBackendVisibility(); } }, [node('option', { value: 'auto', text: 'Auto-Clean' }), node('option', { value: 'rewrite', text: 'Rewrite' }), node('option', { value: 'rewrite_ai', text: 'Rewrite (AI Generated)' })]);
    repairMode.value = settings.repairMode;
    content.append(node('p', { text: 'Detection categories:' }), categories, node('p', { text: 'Repair behavior:' }), repairMode);
    const backendPanel = node('div', { class: 'reprep-ai-backend-panel' });
    const backendSelect = node('select', { class: 'text_pole' }, Object.entries(AI_BACKENDS).map(([key, backend]) => node('option', { value: key, text: backend.label })));
    backendSelect.value = settings.aiBackend;
    const backendFields = node('div', { class: 'reprep-ai-backend-fields' });
    const baseUrl = node('input', { class: 'text_pole', type: 'text', placeholder: 'Backend Base URL' });
    const model = node('select', { class: 'text_pole' });
    const apiKey = node('input', { class: 'text_pole', type: 'password', placeholder: 'API key (optional)' });
    const baseUrlLabel = node('label', { text: 'Base URL' });
    const modelLabel = node('label', { text: 'Model' });
    const apiKeyLabel = node('label', { text: 'API key' });
    const testBackend = node('button', { text: 'Test Connection' });
    const refreshModels = node('button', { text: 'Refresh Models' });
    const profile = () => settings.aiProfiles[settings.aiBackend];
    const syncProfileFields = () => {
        const current = profile();
        baseUrl.value = current.baseUrl || '';
        model.replaceChildren(...(current.models || []).map(item => node('option', { value: item, text: item })));
        if (!current.models?.length) model.append(node('option', { value: '', text: 'Refresh Models first' }));
        model.value = current.model || '';
        apiKey.value = current.apiKey || '';
        backendFields.style.display = settings.aiBackend === 'current_st' ? 'none' : '';
        const isHorde = AI_BACKENDS[settings.aiBackend]?.kind === 'horde';
        baseUrlLabel.style.display = isHorde ? 'none' : '';
        baseUrl.style.display = isHorde ? 'none' : '';
        apiKeyLabel.style.display = '';
        apiKey.style.display = '';
    };
    backendSelect.addEventListener('change', event => { settings.aiBackend = event.target.value; saveSettings(); syncProfileFields(); });
    baseUrl.addEventListener('input', event => { profile().baseUrl = event.target.value; saveSettings(); });
    model.addEventListener('change', event => { profile().model = event.target.value; saveSettings(); });
    apiKey.addEventListener('input', event => { profile().apiKey = event.target.value; saveSettings(); });
    testBackend.addEventListener('click', async () => {
        testBackend.disabled = true; testBackend.textContent = 'Testing...';
        try { toastr.success(await testAiBackend(settings.aiBackend, profile(), context)); }
        catch (error) { toastr.error(String(error.message || error)); }
        finally { testBackend.disabled = false; testBackend.textContent = 'Test Connection'; }
    });
    refreshModels.addEventListener('click', async () => {
        refreshModels.disabled = true; refreshModels.textContent = 'Refreshing...';
        try { const models = await refreshAiBackendModels(settings.aiBackend, profile(), context); syncProfileFields(); toastr.success(`Found ${models.length} model(s).`); }
        catch (error) { toastr.error(String(error.message || error)); }
        finally { refreshModels.disabled = false; refreshModels.textContent = 'Refresh Models'; }
    });
    backendFields.append(baseUrlLabel, baseUrl, modelLabel, model, apiKeyLabel, apiKey, node('span'), node('span', {}, [testBackend, refreshModels]));
    backendPanel.append(node('p', { text: 'AI backend for Rewrite (AI Generated):' }), backendSelect, backendFields);
    updateRepairBackendVisibility = () => { backendPanel.style.display = settings.repairMode === 'rewrite_ai' ? '' : 'none'; };
    syncProfileFields();
    updateRepairBackendVisibility();
    content.append(backendPanel);
    const buttons = node('div', { class: 'reprep-buttons' });
    buttons.append(node('button', { text: 'Scan Current Chat', onclick: scan }), node('button', { text: 'Clear Scan Results', onclick: clearResults }), node('button', { text: 'Repair Selected', onclick: repairSelected }), node('button', { text: 'Open Review', onclick: () => { renderReview(); state.resultsPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }));
    content.append(buttons, node('p', { text: 'Supported categories: Longer sequences, Long sequences, Short sequences. Shorter sequences are intentionally excluded.' }));
    state.resultsPanel = node('div', { id: 'reprep_results_panel' });
    content.append(state.resultsPanel);
    renderResultsPanel();
    const target = document.querySelector('#extensions_settings2');
    if (target) target.append(container);
    else setTimeout(addSettings, 500);
}
function registerCommands() {
    const { SlashCommandParser, SlashCommand } = context;
    for (const [name, callback, description] of [['reprep', () => renderReview(), 'Open Chat Repetition Refactor review'], ['reprep-scan', () => scan(), 'Scan the current chat for repetitions'], ['reprep-clear', () => clearResults(), 'Clear Chat Repetition Refactor scan results'], ['inrep', () => scan(), 'Legacy parent command: scan repetitions']]) SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name, callback, aliases: [], returns: description, helpString: `<div>${description}</div>` }));
}
addSettings();
registerCommands();

