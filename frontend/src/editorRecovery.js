import { generationHistoryPayload } from "./generationHistory.js";
import { validateEditorData } from "./editorData.js";

export const EDITOR_RECOVERY_KEY = "soramimic-editor-recovery";

export function canResumeEditor(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	if (Array.isArray(data.results) && data.results.length > 0) return !validateEditorData(data);
	return Array.isArray(data.phrases) && data.phrases.length > 0
		&& data.phrases.every(line => typeof line === "string");
}

// Keep one synchronous checkpoint in addition to IndexedDB history. Undo snapshots
// and host requests are deliberately excluded so the checkpoint stays small and
// can repair a stale copy in the same editing session.
export function saveEditorRecovery(data, storage = localStorage) {
	if (!canResumeEditor(data)) return false;
	const payload = generationHistoryPayload(data);
	if (data.generationHistoryId) payload.generationHistoryId = data.generationHistoryId;
	payload.editorSessionId = data.editorSessionId;
	payload.editorSavedAt = data.editorSavedAt;
	if (data.setupFirst) payload.setupFirst = true;
	storage.setItem(EDITOR_RECOVERY_KEY, JSON.stringify({ version: 1, savedAt: data.editorSavedAt, payload }));
	return true;
}

export async function recoverEditorData(session, repository, storage) {
	const usable = canResumeEditor(session);
	// Without this tab's data there is no reliable editing identity. Let the user
	// choose a saved result instead of opening another tab's most recent work.
	if (!usable) return { data: null, recovered: false };
	// Fresh generation/import payloads take priority over every saved edit.
	if (!session.editorSessionId) return { data: session, recovered: false };
	let data = session;
	let savedAt = session.editorSavedAt || 0;
	const belongsToSession = candidate => candidate.editorSessionId === session.editorSessionId;
	try {
		const checkpoint = readEditorRecovery(storage);
		if (checkpoint && belongsToSession(checkpoint.payload) && checkpoint.savedAt > savedAt) {
			data = checkpoint.payload;
			savedAt = checkpoint.savedAt;
		}
	} catch (error) { console.warn("復元用データを読み込めませんでした:", error); }
	try {
		const entry = session.generationHistoryId ? await repository.get(session.generationHistoryId) : null;
		if (entry && belongsToSession(entry) && canResumeEditor(entry.payload) && entry.updatedAt > savedAt) {
			const setupFirst = data?.generationHistoryId === entry.id && data.setupFirst;
			data = { ...entry.payload, generationHistoryId: entry.id,
				editorSessionId: entry.editorSessionId, editorSavedAt: entry.updatedAt };
			if (setupFirst) data.setupFirst = true;
		}
	} catch (error) { console.warn("編集履歴から復元できませんでした:", error); }
	return { data, recovered: !!data && data !== session };
}

export function readEditorRecovery(storage = localStorage) {
	const entry = JSON.parse(storage.getItem(EDITOR_RECOVERY_KEY));
	return entry?.version === 1 && Number.isFinite(entry.savedAt)
		&& canResumeEditor(entry.payload) ? entry : null;
}
