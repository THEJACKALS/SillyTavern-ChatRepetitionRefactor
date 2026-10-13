# Chat Repetition Refactor

Chat Repetition Refactor is a SillyTavern extension that detects repeated phrases in character messages and organizes them into manageable sequence groups. It provides text-based filtering, occurrence-level selection, message locating, safe auto-cleaning, manual rewriting, and AI-generated paragraph rewriting with a review step before applying changes.
The extension supports multiple AI backends, including LM Studio, AI Horde, Ollama, OpenAI-compatible APIs, llama.cpp, KoboldCpp, Aphrodite, and Mancer. It is designed for large chats where repeated content can be difficult to locate and repair manually.

This is a modified standalone version based on the GPL-3.0 parent project [SillyTavern-Repetition-Inspector](https://github.com/bbonvi/SillyTavern-Repetition-Inspector). The extension name, interface, detection workflow, repair workflow, and AI backend support have been refactored and extended.

## Features
<img width="556" height="231" alt="image" src="https://github.com/user-attachments/assets/f5fe8dfa-5e31-4668-9f6b-c0bf4da83134" />

- Scan the active chat for three categories:
  - **Longer sequences** — 10 words or more.
  - **Long sequences** — 5 words or more.
  - **Short sequences** — 4 words or more.
- Scan results are organized into category and group drawers to keep large chats manageable.
- Scan results always start **unchecked**.
- Checkboxes are available for every group and occurrence.
- The original occurrence is kept as a reference and is never repaired automatically.
- Thin separators are used between occurrences, with thicker separators between groups.
- The **Find in messages** field works like a browser Find feature: type a word or phrase to filter occurrences from matching chat messages.
- A `Locate` button is available for every original and repeated occurrence.
- Message IDs follow SillyTavern's internal **zero-based** indexing. The first message is `Message 0`.

## Repair behavior

- **Auto-Clean** — safely cleans selected repeated occurrences.
<img width="544" height="79" alt="image" src="https://github.com/user-attachments/assets/788ec129-c357-472f-9c04-7b145f7bf737" />

- **Rewrite** — opens selected occurrences for manual editing.
<img width="546" height="331" alt="image" src="https://github.com/user-attachments/assets/b3d1404e-129b-4792-bb0b-9292ab39047f" />

- **Rewrite (AI Generated)** — regenerates only paragraphs containing selected repetitions, then opens a review before replacement.
<img width="546" height="331" alt="image" src="https://github.com/user-attachments/assets/abd8b0c1-7196-42ed-8912-849992b8bc46" />

AI Generated provides separate profiles for LM Studio, AI Horde, Ollama, OpenAI-compatible, llama.cpp, KoboldCpp, Aphrodite, and Mancer. Use `Test Connection` and `Refresh Models` to verify backends and available models.

## Slash commands

- `/reprep` — open the review interface.
- `/reprep-scan` — scan the active chat.
- `/reprep-clear` — clear scan results.
- `/inrep` — legacy-compatible command from the parent extension; runs a scan using the new interface.

## Notes

- Scanning never changes chat content.
- Repairs only run on explicitly selected occurrences.
- The latest repair can be reverted with `Undo Last Repair` while the affected messages remain unchanged.
- The extension scans character/assistant messages in the active chat; user and system messages are excluded.

## License

This project is distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for the full license text.
