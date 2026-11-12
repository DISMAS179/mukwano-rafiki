import type {
  BadTranslationReport,
  HistoryItem,
  ModelChoice,
  TestPhraseEvaluation,
  ThemeMode,
  VoiceTestEvaluation,
} from '../types';

const KEYS = {
  theme: 'mr_theme',
  history: 'mr_history_v1',
  reports: 'mr_reports_v1',
  evaluationsV1: 'mr_test_evals_v1',
  evaluationsV2: 'mr_test_evals_v2',
  voiceEvaluationsV1: 'mr_voice_test_evals_v1',
  voiceEvaluationsV2: 'mr_voice_test_evals_v2',
} as const;

const MAX_HISTORY_ITEMS = 10;

export function makeEvalKey(modelChoice: ModelChoice, phraseId: string): string {
  return `${modelChoice}::${phraseId}`;
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
      const choice: ModelChoice = val.modelChoice ?? 'primary';
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

export function loadVoiceTestEvaluations(): Record<string, VoiceTestEvaluation> {
  const v2 = readJson<Record<string, VoiceTestEvaluation> | null>(
    KEYS.voiceEvaluationsV2,
    null,
  );
  if (v2 && typeof v2 === 'object') return v2;

  const v1 = readJson<Record<string, VoiceTestEvaluation>>(KEYS.voiceEvaluationsV1, {});
  if (v1 && typeof v1 === 'object' && Object.keys(v1).length > 0) {
    const migrated: Record<string, VoiceTestEvaluation> = {};
    for (const [phraseId, val] of Object.entries(v1)) {
      const choice: ModelChoice = val.modelChoice ?? 'primary';
      migrated[makeEvalKey(choice, phraseId)] = { ...val, modelChoice: choice, phraseId };
    }
    writeJson(KEYS.voiceEvaluationsV2, migrated);
    return migrated;
  }
  return {};
}

export function persistVoiceTestEvaluations(items: Record<string, VoiceTestEvaluation>): boolean {
  return writeJson(KEYS.voiceEvaluationsV2, items);
}

export function mergeVoiceTestEvaluation(
  current: Record<string, VoiceTestEvaluation>,
  modelChoice: ModelChoice,
  phraseId: string,
  patch: Partial<VoiceTestEvaluation>,
): Record<string, VoiceTestEvaluation> {
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

export function removeVoiceTestEvaluationsForModel(
  current: Record<string, VoiceTestEvaluation>,
  modelChoice?: ModelChoice,
): Record<string, VoiceTestEvaluation> {
  if (!modelChoice) return {};
  const prefix = `${modelChoice}::`;
  const next: Record<string, VoiceTestEvaluation> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!k.startsWith(prefix)) {
      next[k] = v;
    }
  }
  return next;
}
