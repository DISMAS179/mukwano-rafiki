import type {
  BadReplyReport,
  BadTranslationReport,
  ChatMessage,
  ChatTestEvaluation,
  HistoryItem,
  ModelChoice,
  TestPhraseEvaluation,
  ThemeMode,
  UserProfile,
} from '../types';

const KEYS = {
  theme: 'mr_theme',
  profile: 'mr_profile_v1',
  chatHistory: 'mr_chat_history_v1',
  badReplies: 'mr_bad_replies_v1',
  chatEvaluations: 'mr_chat_test_evals_v1',
  history: 'mr_history_v1',
  reports: 'mr_reports_v1',
  evaluationsV1: 'mr_test_evals_v1',
  evaluationsV2: 'mr_test_evals_v2',
} as const;

const MAX_HISTORY_ITEMS = 10;
const MAX_CHAT_MESSAGES = 60;

export const DEFAULT_USER_PROFILE: UserProfile = {
  name: '',
  preferredLanguage: '',
  ageGroup: '',
  interest: '',
  onboarded: false,
};

export function makeEvalKey(modelChoice: ModelChoice, itemId: string): string {
  return `${modelChoice}::${itemId}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEYS.theme);
    if (saved === 'dark' || saved === 'light') return saved;
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    // Fallback
  }
  return 'light';
}

export function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(KEYS.theme, theme);
  } catch {
    // Ignore
  }
}

// User Profile (browser-only)
export function loadUserProfile(): UserProfile {
  const saved = readJson<Partial<UserProfile> | null>(KEYS.profile, null);
  if (!saved || typeof saved !== 'object') return DEFAULT_USER_PROFILE;
  return {
    name: typeof saved.name === 'string' ? saved.name : '',
    preferredLanguage: saved.preferredLanguage ?? '',
    ageGroup: saved.ageGroup ?? '',
    interest: saved.interest ?? '',
    onboarded: Boolean(saved.onboarded),
  };
}

export function persistUserProfile(profile: UserProfile): boolean {
  return writeJson(KEYS.profile, profile);
}

// Chat Messages (browser-only)
export function loadChatHistory(): ChatMessage[] {
  const items = readJson<ChatMessage[]>(KEYS.chatHistory, []);
  return Array.isArray(items) ? items.slice(-MAX_CHAT_MESSAGES) : [];
}

export function persistChatHistory(items: ChatMessage[]): boolean {
  return writeJson(KEYS.chatHistory, items.slice(-MAX_CHAT_MESSAGES));
}

export function clearPersonalChatData(): void {
  try {
    localStorage.removeItem(KEYS.profile);
    localStorage.removeItem(KEYS.chatHistory);
  } catch {
    // Ignore
  }
}

// Bad Reply Reports (browser-only)
export function loadBadReplyReports(): BadReplyReport[] {
  const items = readJson<BadReplyReport[]>(KEYS.badReplies, []);
  return Array.isArray(items) ? items : [];
}

export function persistBadReplyReports(items: BadReplyReport[]): boolean {
  return writeJson(KEYS.badReplies, items);
}

// Chatbot Test Evaluations
export function loadChatTestEvaluations(): Record<string, ChatTestEvaluation> {
  const saved = readJson<Record<string, ChatTestEvaluation> | null>(KEYS.chatEvaluations, null);
  return saved && typeof saved === 'object' ? saved : {};
}

export function persistChatTestEvaluations(items: Record<string, ChatTestEvaluation>): boolean {
  return writeJson(KEYS.chatEvaluations, items);
}

export function mergeChatTestEvaluation(
  current: Record<string, ChatTestEvaluation>,
  modelChoice: ModelChoice,
  caseId: string,
  patch: Partial<ChatTestEvaluation>,
): Record<string, ChatTestEvaluation> {
  const key = makeEvalKey(modelChoice, caseId);
  const existing = current[key] ?? { caseId, modelChoice };
  return {
    ...current,
    [key]: {
      ...existing,
      ...patch,
      caseId,
      modelChoice,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function removeChatTestEvaluationsForModel(
  current: Record<string, ChatTestEvaluation>,
  modelChoice?: ModelChoice,
): Record<string, ChatTestEvaluation> {
  if (!modelChoice) return {};
  const prefix = `${modelChoice}::`;
  const next: Record<string, ChatTestEvaluation> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!k.startsWith(prefix)) next[k] = v;
  }
  return next;
}

// Translator History & Reports (browser-only)
export function loadHistory(): HistoryItem[] {
  const items = readJson<HistoryItem[]>(KEYS.history, []);
  return Array.isArray(items) ? items.slice(0, MAX_HISTORY_ITEMS) : [];
}

export function persistHistory(items: HistoryItem[]): boolean {
  return writeJson(KEYS.history, items.slice(0, MAX_HISTORY_ITEMS));
}

export function loadReports(): BadTranslationReport[] {
  const items = readJson<BadTranslationReport[]>(KEYS.reports, []);
  return Array.isArray(items) ? items : [];
}

export function persistReports(items: BadTranslationReport[]): boolean {
  return writeJson(KEYS.reports, items);
}

export function loadTestEvaluations(): Record<string, TestPhraseEvaluation> {
  const v2 = readJson<Record<string, TestPhraseEvaluation> | null>(KEYS.evaluationsV2, null);
  if (v2 && typeof v2 === 'object') return v2;

  const v1 = readJson<Record<string, TestPhraseEvaluation>>(KEYS.evaluationsV1, {});
  if (v1 && typeof v1 === 'object' && Object.keys(v1).length > 0) {
    const migrated: Record<string, TestPhraseEvaluation> = {};
    for (const [phraseId, val] of Object.entries(v1)) {
      const choice: ModelChoice = val.modelChoice === 'secondary' ? 'secondary' : 'primary';
      migrated[makeEvalKey(choice, phraseId)] = { ...val, modelChoice: choice, phraseId };
    }
    writeJson(KEYS.evaluationsV2, migrated);
    return migrated;
  }
  return {};
}

export function persistTestEvaluations(items: Record<string, TestPhraseEvaluation>): boolean {
  return writeJson(KEYS.evaluationsV2, items);
}

export function mergeTestEvaluation(
  current: Record<string, TestPhraseEvaluation>,
  modelChoice: ModelChoice,
  phraseId: string,
  patch: Partial<TestPhraseEvaluation>,
): Record<string, TestPhraseEvaluation> {
  const key = makeEvalKey(modelChoice, phraseId);
  const existing = current[key] ?? { phraseId, modelChoice };
  return {
    ...current,
    [key]: {
      ...existing,
      ...patch,
      phraseId,
      modelChoice,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function removeTestEvaluationsForModel(
  current: Record<string, TestPhraseEvaluation>,
  modelChoice?: ModelChoice,
): Record<string, TestPhraseEvaluation> {
  if (!modelChoice) return {};
  const prefix = `${modelChoice}::`;
  const next: Record<string, TestPhraseEvaluation> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!k.startsWith(prefix)) {
      next[k] = v;
    }
  }
  return next;
}
