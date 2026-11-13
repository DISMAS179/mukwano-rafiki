import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { MessageCircle } from 'lucide-react';
import { CHAT_TEST_CASES } from '../data/chatTestCases';
import { TEST_PHRASES } from '../data/testPhrases';
import type {
  ChatCaseType,
  ChatCriterionRating,
  ChatTestCase,
  ChatTestEvaluation,
  LanguageName,
  ModelChoice,
  TestCategory,
  TestPhrase,
  TestPhraseEvaluation,
  TestRatingValue,
} from '../types';
import {
  DEFAULT_MODEL_CONFIG,
  TEST_MODE_REQUEST_DELAY_MS,
  sendChatMessage,
  translateText,
  type ServerHealthConfig,
} from '../utils/api';
import { makeEvalKey } from '../utils/storage';
import { ConfidenceBadge } from './ConfidenceBadge';

interface TestModeViewProps {
  chatEvaluations: Record<string, ChatTestEvaluation>;
  evaluations: Record<string, TestPhraseEvaluation>;
  modelConfig?: ServerHealthConfig;
  onUpdateChatEvaluation: (
    modelChoice: ModelChoice,
    caseId: string,
    patch: Partial<ChatTestEvaluation>,
  ) => void;
  onUpdateEvaluation: (
    modelChoice: ModelChoice,
    phraseId: string,
    patch: Partial<TestPhraseEvaluation>,
  ) => void;
  onResetChatEvaluations: (modelChoice: ModelChoice) => void;
  onResetEvaluations: (modelChoice: ModelChoice) => void;
  onNavigateToResults: () => void;
}

interface QueuedTask {
  key: string;
  phraseId: string;
  mode: 'chat' | 'text';
  run: () => Promise<void>;
}

const CHAT_CASE_TYPES: Array<'All' | ChatCaseType> = [
  'All',
  'Mixed Language',
  'Emotional',
  'Unclear',
  'Health & Safety',
  'Farming',
  'School',
  'Business & Money',
  'Follow-up Context',
];

const CHAT_CRITERIA: Array<{
  field: 'understoodMe' | 'naturalLanguage' | 'helpfulAdvice' | 'safe';
  label: string;
}> = [
  { field: 'understoodMe', label: 'Understood me' },
  { field: 'naturalLanguage', label: 'Natural language' },
  { field: 'helpfulAdvice', label: 'Helpful advice' },
  { field: 'safe', label: 'Safe' },
];

const YES_PARTLY_NO: Array<{ value: ChatCriterionRating; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'partly', label: 'Partly' },
  { value: 'no', label: 'No' },
];

const CATEGORIES: Array<'All' | TestCategory> = [
  'All',
  'Greetings',
  'Market',
  'Health',
  'School',
  'Numbers & Money',
  'Idioms',
];

const LANGUAGES: Array<'All' | LanguageName> = ['All', 'Luganda', 'Swahili', 'English'];

const RATING_OPTIONS: Array<{ value: TestRatingValue; label: string }> = [
  { value: 'correct', label: 'Correct' },
  { value: 'understandable', label: 'Understandable but unnatural' },
  { value: 'wrong', label: 'Wrong' },
];

const RATING_LABEL_MAP: Record<TestRatingValue, string> = {
  correct: 'Correct',
  understandable: 'Unnatural',
  wrong: 'Wrong',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function TestModeView({
  chatEvaluations,
  evaluations,
  modelConfig = DEFAULT_MODEL_CONFIG,
  onUpdateChatEvaluation,
  onUpdateEvaluation,
  onResetChatEvaluations,
  onResetEvaluations,
  onNavigateToResults,
}: TestModeViewProps) {
  const [testTab, setTestTab] = useState<'chat' | 'text'>('chat');
  const [selectedModel, setSelectedModel] = useState<ModelChoice>('primary');
  const [selectedChatType, setSelectedChatType] = useState<'All' | ChatCaseType>('All');
  const [selectedCategory, setSelectedCategory] = useState<'All' | TestCategory>('All');
  const [selectedLanguage, setSelectedLanguage] = useState<'All' | LanguageName>('All');

  // Items start collapsed; requests run on-demand when opened or clicked
  const [openPhraseIds, setOpenPhraseIds] = useState<Record<string, boolean>>({});
  const [openChatCaseIds, setOpenChatCaseIds] = useState<Record<string, boolean>>({});

  // Single-flight serialized request state (at most 1 request running across all items)
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [queuedKeys, setQueuedKeys] = useState<Record<string, boolean>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});

  const queueRef = useRef<QueuedTask[]>([]);
  const activeTaskKeyRef = useRef<string | null>(null);
  const isQueueRunningRef = useRef(false);
  const lastRequestFinishedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const modelOptions = useMemo<Array<{ value: ModelChoice; label: string; idHint: string }>>(
    () => [
      { value: 'primary', label: 'Gemini Primary', idHint: modelConfig.primaryModel },
      { value: 'secondary', label: 'Gemini Secondary', idHint: modelConfig.secondaryModel },
    ],
    [modelConfig],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueRef.current = [];
    };
  }, []);

  const filteredChatCases = useMemo(() => {
    return CHAT_TEST_CASES.filter((c) =>
      selectedChatType === 'All' ? true : c.caseType === selectedChatType,
    );
  }, [selectedChatType]);

  const chatTestedCount = useMemo(() => {
    return CHAT_TEST_CASES.filter((c) =>
      Boolean(chatEvaluations[makeEvalKey(selectedModel, c.id)]?.reply),
    ).length;
  }, [chatEvaluations, selectedModel]);

  const chatRatedCount = useMemo(() => {
    return CHAT_TEST_CASES.filter((c) => {
      const ev = chatEvaluations[makeEvalKey(selectedModel, c.id)];
      return Boolean(
        ev?.understoodMe || ev?.naturalLanguage || ev?.helpfulAdvice || ev?.safe,
      );
    }).length;
  }, [chatEvaluations, selectedModel]);

  const filteredPhrases = useMemo(() => {
    return TEST_PHRASES.filter((item) => {
      if (selectedCategory !== 'All' && item.category !== selectedCategory) return false;
      if (selectedLanguage !== 'All' && item.sourceLanguage !== selectedLanguage) return false;
      return true;
    });
  }, [selectedCategory, selectedLanguage]);

  const ratedCount = useMemo(() => {
    return TEST_PHRASES.filter((p) =>
      Boolean(evaluations[makeEvalKey(selectedModel, p.id)]?.rating),
    ).length;
  }, [evaluations, selectedModel]);

  const translatedCount = useMemo(() => {
    return TEST_PHRASES.filter((p) =>
      Boolean(evaluations[makeEvalKey(selectedModel, p.id)]?.output),
    ).length;
  }, [evaluations, selectedModel]);

  async function drainQueue() {
    if (isQueueRunningRef.current) return;
    isQueueRunningRef.current = true;

    try {
      while (queueRef.current.length > 0 && mountedRef.current) {
        const nextTask = queueRef.current.shift();
        if (!nextTask) break;

        // Enforce a short delay between consecutive API requests
        const elapsedSinceLast = Date.now() - lastRequestFinishedAtRef.current;
        if (lastRequestFinishedAtRef.current > 0 && elapsedSinceLast < TEST_MODE_REQUEST_DELAY_MS) {
          const waitMs = TEST_MODE_REQUEST_DELAY_MS - elapsedSinceLast;
          if (mountedRef.current) {
            setRowStatus((prev) => ({
              ...prev,
              [nextTask.key]: 'Waiting briefly before sending…',
            }));
          }
          await sleep(waitMs);
        }

        if (!mountedRef.current) break;

        setQueuedKeys((prev) => {
          const copy = { ...prev };
          delete copy[nextTask.key];
          return copy;
        });
        activeTaskKeyRef.current = nextTask.key;
        setActiveTaskKey(nextTask.key);

        try {
          await nextTask.run();
        } finally {
          lastRequestFinishedAtRef.current = Date.now();
          activeTaskKeyRef.current = null;
          if (mountedRef.current) {
            setActiveTaskKey(null);
            setRowStatus((prev) => {
              const copy = { ...prev };
              delete copy[nextTask.key];
              return copy;
            });
          }
        }
      }
    } finally {
      isQueueRunningRef.current = false;
    }
  }

  function enqueueTask(task: QueuedTask) {
    if (activeTaskKeyRef.current === task.key) return;
    if (queueRef.current.some((item) => item.key === task.key)) return;

    queueRef.current.push(task);
    setQueuedKeys((prev) => ({ ...prev, [task.key]: true }));
    void drainQueue();
  }

  function cancelQueuedTask(key: string) {
    queueRef.current = queueRef.current.filter((item) => item.key !== key);
    setQueuedKeys((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }

  function clearTextError(modelChoice: ModelChoice, phraseId: string) {
    const evalKey = makeEvalKey(modelChoice, phraseId);
    setRowErrors((prev) => {
      if (!(evalKey in prev)) return prev;
      const next = { ...prev };
      delete next[evalKey];
      return next;
    });
  }

  function handleResetCurrentTextEvaluations() {
    const prefix = `${selectedModel}::`;
    setRowErrors((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return next;
    });
    onResetEvaluations(selectedModel);
  }

  function clearChatError(modelChoice: ModelChoice, caseId: string) {
    const evalKey = makeEvalKey(modelChoice, caseId);
    setChatErrors((prev) => {
      if (!(evalKey in prev)) return prev;
      const next = { ...prev };
      delete next[evalKey];
      return next;
    });
  }

  function handleResetCurrentChatEvaluations() {
    const prefix = `${selectedModel}::`;
    setChatErrors((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return next;
    });
    onResetChatEvaluations(selectedModel);
  }

  function requestChatTestReply(testCase: ChatTestCase, modelChoice: ModelChoice = selectedModel) {
    const evalKey = makeEvalKey(modelChoice, testCase.id);
    const taskKey = `chat::${evalKey}`;

    clearChatError(modelChoice, testCase.id);

    enqueueTask({
      key: taskKey,
      phraseId: testCase.id,
      mode: 'chat',
      run: async () => {
        setRowStatus((prev) => ({ ...prev, [taskKey]: 'Thinking…' }));
        try {
          const res = await sendChatMessage({
            message: testCase.message,
            history: testCase.priorTurns,
            profile: testCase.sampleProfile,
            modelChoice,
            onStatus: (msg) => {
              if (mountedRef.current) {
                setRowStatus((prev) => ({ ...prev, [taskKey]: msg }));
              }
            },
          });

          if (!mountedRef.current) return;
          clearChatError(modelChoice, testCase.id);
          onUpdateChatEvaluation(modelChoice, testCase.id, {
            reply: res.reply,
            detectedLanguage: res.detected_language,
            detectedEmotion: res.detected_emotion,
            whyThisAdvice: res.why_this_advice,
            suggestions: res.suggestions,
            confidence: res.confidence,
            modelUsed: res.model_used,
          });
        } catch (err) {
          if (!mountedRef.current) return;
          const message =
            err instanceof Error ? err.message : 'Chatbot request failed. Please try again.';
          setChatErrors((prev) => ({ ...prev, [evalKey]: message }));
        }
      },
    });
  }

  function handleToggleChatCase(testCase: ChatTestCase) {
    const willOpen = !openChatCaseIds[testCase.id];
    setOpenChatCaseIds((prev) => ({ ...prev, [testCase.id]: willOpen }));

    if (willOpen) {
      const evalKey = makeEvalKey(selectedModel, testCase.id);
      const existing = chatEvaluations[evalKey];
      if (!existing?.reply && !chatErrors[evalKey]) {
        requestChatTestReply(testCase, selectedModel);
      }
    }
  }

  function handlePressRunChatCase(testCase: ChatTestCase) {
    setOpenChatCaseIds((prev) => ({ ...prev, [testCase.id]: true }));
    requestChatTestReply(testCase, selectedModel);
  }

  function requestTextTranslation(phrase: TestPhrase, modelChoice: ModelChoice = selectedModel) {
    const evalKey = makeEvalKey(modelChoice, phrase.id);
    const taskKey = `text::${evalKey}`;

    clearTextError(modelChoice, phrase.id);

    enqueueTask({
      key: taskKey,
      phraseId: phrase.id,
      mode: 'text',
      run: async () => {
        setRowStatus((prev) => ({ ...prev, [taskKey]: 'Translating…' }));
        try {
          const res = await translateText({
            text: phrase.phrase,
            targetLanguage: phrase.targetLanguage,
            domain: phrase.domain,
            modelChoice,
            onStatus: (msg) => {
              if (mountedRef.current) {
                setRowStatus((prev) => ({ ...prev, [taskKey]: msg }));
              }
            },
          });

          if (!mountedRef.current) return;
          clearTextError(modelChoice, phrase.id);
          onUpdateEvaluation(modelChoice, phrase.id, {
            output: res.translation,
            detectedLanguage: res.detected_language,
            resolvedTargetLanguage: res.target_language,
            confidence: res.confidence,
            notes: res.notes,
            modelUsed: res.model_used,
          });
        } catch (err) {
          if (!mountedRef.current) return;
          const message =
            err instanceof Error
              ? err.message
              : 'Translation request failed. Please try again.';
          setRowErrors((prev) => ({ ...prev, [evalKey]: message }));
        }
      },
    });
  }

  function handleTogglePhrase(phrase: TestPhrase) {
    const willOpen = !openPhraseIds[phrase.id];
    setOpenPhraseIds((prev) => ({ ...prev, [phrase.id]: willOpen }));

    if (willOpen && testTab === 'text') {
      const evalKey = makeEvalKey(selectedModel, phrase.id);
      const existing = evaluations[evalKey];
      if (!existing?.output && !rowErrors[evalKey]) {
        requestTextTranslation(phrase, selectedModel);
      }
    }
  }

  function handlePressTranslatePhrase(phrase: TestPhrase) {
    setOpenPhraseIds((prev) => ({ ...prev, [phrase.id]: true }));
    requestTextTranslation(phrase, selectedModel);
  }

  function ratingButtonClass(current: TestRatingValue | undefined, option: TestRatingValue) {
    const active = current === option;
    if (!active) {
      return 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-300 dark:hover:bg-emerald-950/50';
    }
    if (option === 'correct') {
      return 'border-emerald-700 bg-emerald-800 text-white dark:border-emerald-500 dark:bg-emerald-600 dark:text-stone-950';
    }
    if (option === 'understandable') {
      return 'border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-500 dark:text-stone-950';
    }
    return 'border-rose-700 bg-rose-700 text-white dark:border-rose-500 dark:bg-rose-500 dark:text-stone-950';
  }

  function criterionButtonClass(
    current: ChatCriterionRating | undefined,
    option: ChatCriterionRating,
  ) {
    const active = current === option;
    if (!active) {
      return 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-300 dark:hover:bg-emerald-950/50';
    }
    if (option === 'yes') {
      return 'border-emerald-700 bg-emerald-800 text-white dark:border-emerald-500 dark:bg-emerald-600 dark:text-stone-950';
    }
    if (option === 'partly') {
      return 'border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-500 dark:text-stone-950';
    }
    return 'border-rose-700 bg-rose-700 text-white dark:border-rose-500 dark:bg-rose-500 dark:text-stone-950';
  }

  const activeModelMeta =
    modelOptions.find((m) => m.value === selectedModel) ?? modelOptions[0];
  const anyRequestActive = activeTaskKey !== null;

  return (
    <div className="space-y-6">
      {/* Overview, Tabs, Model Selector & Filters */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-bold text-stone-900 dark:text-stone-50">
              Native Speaker Test Mode
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
              {testTab === 'chat'
                ? 'Open any sample conversation or press Test reply to evaluate Mukwano-Rafiki one message at a time.'
                : 'Open any phrase or press Translate to test one request at a time.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400 tabular-nums">
              <span>Model: {activeModelMeta.label}</span>
              <span aria-hidden="true">·</span>
              {testTab === 'chat' ? (
                <>
                  <span>{CHAT_TEST_CASES.length} conversations</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatTestedCount} tested</span>
                  <span aria-hidden="true">·</span>
                  <span>{chatRatedCount} rated</span>
                </>
              ) : (
                <>
                  <span>{TEST_PHRASES.length} phrases</span>
                  <span aria-hidden="true">·</span>
                  <span>{translatedCount} translated</span>
                  <span aria-hidden="true">·</span>
                  <span>{ratedCount} rated</span>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onNavigateToResults}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-amber-400/80 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700/70 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50 whitespace-nowrap"
            >
              View accuracy scores
            </button>

            {testTab === 'chat' && (chatRatedCount > 0 || chatTestedCount > 0) && !anyRequestActive && (
              <button
                type="button"
                onClick={handleResetCurrentChatEvaluations}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 px-3.5 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-300 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset chatbot ratings</span>
              </button>
            )}

            {testTab === 'text' && (ratedCount > 0 || translatedCount > 0) && !anyRequestActive && (
              <button
                type="button"
                onClick={handleResetCurrentTextEvaluations}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 px-3.5 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-300 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Reset {activeModelMeta.label} ratings</span>
              </button>
            )}
          </div>
        </div>

        {/* Mode Segmented Tabs: Chatbot test | Translator text */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-4 dark:border-emerald-950/70">
          <div
            role="tablist"
            aria-label="Test mode type"
            className="inline-flex flex-wrap rounded-xl bg-stone-100 p-1 dark:bg-[#0D1310]"
          >
            <button
              type="button"
              role="tab"
              aria-selected={testTab === 'chat'}
              onClick={() => setTestTab('chat')}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                testTab === 'chat'
                  ? 'bg-white text-emerald-950 shadow-sm dark:bg-[#19241E] dark:text-amber-300'
                  : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200'
              }`}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              <span>Chatbot test (15)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={testTab === 'text'}
              onClick={() => setTestTab('text')}
              className={`min-h-[40px] rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                testTab === 'text'
                  ? 'bg-white text-emerald-950 shadow-sm dark:bg-[#19241E] dark:text-amber-300'
                  : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200'
              }`}
            >
              Translator text (25)
            </button>
          </div>
        </div>

        {/* Model Selector & Filter Controls */}
        {testTab === 'chat' ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="test-model-selector"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Model under test
              </label>
              <select
                id="test-model-selector"
                disabled={anyRequestActive}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value as ModelChoice)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm font-semibold text-emerald-950 focus:border-emerald-700 focus:outline-none disabled:opacity-60 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-amber-300"
              >
                {modelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} ({opt.idHint})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="test-chat-type-filter"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Scenario type
              </label>
              <select
                id="test-chat-type-filter"
                value={selectedChatType}
                onChange={(e) => setSelectedChatType(e.target.value as 'All' | ChatCaseType)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm font-medium text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100"
              >
                {CHAT_CASE_TYPES.map((ct) => (
                  <option key={ct} value={ct}>
                    {ct === 'All' ? 'All scenarios (15 conversations)' : ct}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label
                htmlFor="test-model-selector"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Model under test
              </label>
              <select
                id="test-model-selector"
                disabled={anyRequestActive}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value as ModelChoice)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm font-semibold text-emerald-950 focus:border-emerald-700 focus:outline-none disabled:opacity-60 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-amber-300"
              >
                {modelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} ({opt.idHint})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="test-category-filter"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Category
              </label>
              <select
                id="test-category-filter"
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value as 'All' | TestCategory)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm font-medium text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === 'All' ? 'All categories (25 phrases)' : cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="test-language-filter"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Source language
              </label>
              <select
                id="test-language-filter"
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value as 'All' | LanguageName)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm font-medium text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang === 'All' ? 'All source languages' : lang}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>

      {/* CHATBOT TEST VIEW (15 Conversations rated on Understood me, Natural language, Helpful advice, Safe) */}
      {testTab === 'chat' && (
        <section className="space-y-3" aria-label="Chatbot test conversations">
          {filteredChatCases.map((testCase, idx) => {
            const evalKey = makeEvalKey(selectedModel, testCase.id);
            const chatEval = chatEvaluations[evalKey];
            const taskKey = `chat::${evalKey}`;
            const isLoading = activeTaskKey === taskKey;
            const isQueued = Boolean(queuedKeys[taskKey]);
            const isOpen = Boolean(openChatCaseIds[testCase.id]);
            const err = chatErrors[evalKey];
            const statusText = rowStatus[taskKey] || 'Thinking…';
            const criteriaFilledCount = [
              chatEval?.understoodMe,
              chatEval?.naturalLanguage,
              chatEval?.helpfulAdvice,
              chatEval?.safe,
            ].filter(Boolean).length;

            return (
              <article
                key={testCase.id}
                className="rounded-2xl border border-stone-200/90 bg-white shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18]"
              >
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => handleToggleChatCase(testCase)}
                    aria-expanded={isOpen}
                    className="flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-mono tabular-nums">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                        {testCase.caseType}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{testCase.languageHint}</span>
                      {criteriaFilledCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-stone-800 dark:text-stone-200">
                            {criteriaFilledCount}/4 rated
                          </span>
                        </>
                      )}
                      {err && !isOpen && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-rose-700 dark:text-rose-300">
                            Error
                          </span>
                        </>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-semibold leading-snug text-stone-900 dark:text-stone-100 sm:text-base">
                      {testCase.message}
                    </p>
                  </button>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {isQueued ? (
                      <button
                        type="button"
                        onClick={() => cancelQueuedTask(taskKey)}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 whitespace-nowrap"
                      >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        <span>Queued</span>
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => handlePressRunChatCase(testCase)}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 bg-[#FAF9F5] px-4 py-2 text-xs font-semibold text-stone-800 hover:border-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:hover:border-emerald-500 whitespace-nowrap"
                      >
                        {isLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            <span>{statusText}</span>
                          </>
                        ) : err ? (
                          <>
                            <RotateCcw className="h-3.5 w-3.5 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                            <span>Retry</span>
                          </>
                        ) : chatEval?.reply ? (
                          <>
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Re-run</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                            <span>Test reply</span>
                          </>
                        )}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleToggleChatCase(testCase)}
                      aria-expanded={isOpen}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-stone-200 px-3 text-xs font-medium text-stone-600 hover:bg-stone-50 dark:border-emerald-950/80 dark:text-stone-300 dark:hover:bg-[#19241E]"
                    >
                      <span>{isOpen ? 'Close' : 'Open'}</span>
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-stone-100 p-4 pt-3 dark:border-emerald-950/70 space-y-4">
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      Expected behavior: {testCase.contextHint}
                    </p>

                    {testCase.priorTurns && testCase.priorTurns.length > 0 && (
                      <div className="rounded-xl bg-[#FAF9F5] p-3 text-xs space-y-1.5 dark:bg-[#0D1310]">
                        <p className="font-semibold text-stone-700 dark:text-stone-300">
                          Prior conversation turns:
                        </p>
                        {testCase.priorTurns.map((t, tIdx) => (
                          <p key={tIdx} className="text-stone-600 dark:text-stone-400">
                            <span className="font-semibold">
                              {t.role === 'user' ? 'User: ' : 'Bot: '}
                            </span>
                            {t.text}
                          </p>
                        ))}
                      </div>
                    )}

                    {err && (
                      <div
                        role="alert"
                        className="flex flex-col gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                          <span className="leading-relaxed">{err}</span>
                        </div>
                        <button
                          type="button"
                          disabled={isLoading || isQueued}
                          onClick={() => requestChatTestReply(testCase, selectedModel)}
                          className="inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100 whitespace-nowrap"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Retry</span>
                        </button>
                      </div>
                    )}

                    {isLoading && !chatEval?.reply && (
                      <div className="flex items-center gap-2 rounded-xl bg-[#FAF9F5] px-3.5 py-3 text-xs font-medium text-stone-700 dark:bg-[#0D1310] dark:text-stone-300">
                        <Loader2 className="h-4 w-4 animate-spin text-emerald-700 dark:text-amber-300" aria-hidden="true" />
                        <span>{statusText}</span>
                      </div>
                    )}

                    {chatEval?.reply && (
                      <div className="rounded-xl bg-[#FAF9F5] p-3.5 dark:bg-[#0D1310] space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                            {chatEval.detectedLanguage || testCase.languageHint}
                            {chatEval.detectedEmotion ? ` · Tone: ${chatEval.detectedEmotion}` : ''}
                          </span>
                          {chatEval.confidence && <ConfidenceBadge level={chatEval.confidence} />}
                        </div>

                        <p className="whitespace-pre-wrap text-sm leading-relaxed font-medium text-stone-900 dark:text-stone-100">
                          {chatEval.reply}
                        </p>

                        {chatEval.whyThisAdvice && (
                          <p className="text-xs text-stone-600 dark:text-stone-400">
                            <span className="font-semibold">Why this advice: </span>
                            {chatEval.whyThisAdvice}
                          </p>
                        )}

                        {chatEval.suggestions && chatEval.suggestions.length > 0 && (
                          <p className="text-xs text-stone-500 dark:text-stone-400">
                            <span className="font-semibold">Follow-up suggestions: </span>
                            {chatEval.suggestions.join(' · ')}
                          </p>
                        )}

                        {chatEval.modelUsed && (
                          <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                            Model: {chatEval.modelUsed}
                          </p>
                        )}
                      </div>
                    )}

                    {/* 4 Native Speaker Criteria: Understood me, Natural language, Helpful advice, Safe */}
                    <div className="space-y-3 border-t border-stone-100 pt-3 dark:border-emerald-950/70">
                      <p className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                        Native speaker evaluation
                      </p>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {CHAT_CRITERIA.map((criterion) => {
                          const currentVal = chatEval?.[criterion.field];
                          return (
                            <div key={criterion.field} className="space-y-1.5">
                              <span className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                                {criterion.label}
                              </span>
                              <div className="flex flex-wrap gap-1.5">
                                {YES_PARTLY_NO.map((opt) => (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() =>
                                      onUpdateChatEvaluation(selectedModel, testCase.id, {
                                        [criterion.field]: opt.value,
                                      })
                                    }
                                    className={`inline-flex min-h-[40px] items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${criterionButtonClass(
                                      currentVal,
                                      opt.value,
                                    )}`}
                                  >
                                    {currentVal === opt.value && (
                                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                    )}
                                    <span>{opt.label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div>
                        <label
                          htmlFor={`chat-fix-${testCase.id}`}
                          className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400"
                        >
                          Better reply (optional)
                        </label>
                        <input
                          id={`chat-fix-${testCase.id}`}
                          type="text"
                          value={chatEval?.betterReply ?? ''}
                          onChange={(e) =>
                            onUpdateChatEvaluation(selectedModel, testCase.id, {
                              betterReply: e.target.value,
                            })
                          }
                          placeholder="Type how a kind native speaker would reply…"
                          className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {/* TEXT TEST VIEW (On-demand expandable phrases; serialized 1 request at a time) */}
      {testTab === 'text' && (
        <section className="space-y-3" aria-label="Text test phrases">
          {filteredPhrases.map((phrase, idx) => {
            const evalKey = makeEvalKey(selectedModel, phrase.id);
            const evalItem = evaluations[evalKey];
            const taskKey = `text::${evalKey}`;
            const isLoading = activeTaskKey === taskKey;
            const isQueued = Boolean(queuedKeys[taskKey]);
            const isOpen = Boolean(openPhraseIds[phrase.id]);
            const err = rowErrors[evalKey];
            const statusText = rowStatus[taskKey] || 'Translating…';

            return (
              <article
                key={phrase.id}
                className="rounded-2xl border border-stone-200/90 bg-white shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18]"
              >
                {/* Collapsed / Header Row */}
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={() => handleTogglePhrase(phrase)}
                    aria-expanded={isOpen}
                    className="flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-mono tabular-nums">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                        {phrase.sourceLanguage} → {phrase.targetLanguage}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{phrase.category}</span>
                      {evalItem?.rating && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-stone-800 dark:text-stone-200">
                            Rated: {RATING_LABEL_MAP[evalItem.rating]}
                          </span>
                        </>
                      )}
                      {err && !isOpen && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-rose-700 dark:text-rose-300">
                            Error
                          </span>
                        </>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-semibold leading-snug text-stone-900 dark:text-stone-100 sm:text-base">
                      {phrase.phrase}
                    </p>
                  </button>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {isQueued ? (
                      <button
                        type="button"
                        onClick={() => cancelQueuedTask(taskKey)}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 whitespace-nowrap"
                      >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        <span>Queued</span>
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => handlePressTranslatePhrase(phrase)}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 bg-[#FAF9F5] px-4 py-2 text-xs font-semibold text-stone-800 hover:border-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/40 whitespace-nowrap"
                      >
                        {isLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            <span>{statusText}</span>
                          </>
                        ) : err ? (
                          <>
                            <RotateCcw className="h-3.5 w-3.5 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                            <span>Retry</span>
                          </>
                        ) : evalItem?.output ? (
                          <>
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Re-run</span>
                          </>
                        ) : (
                          <>
                            <Play
                              className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400"
                              aria-hidden="true"
                            />
                            <span>Translate</span>
                          </>
                        )}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleTogglePhrase(phrase)}
                      aria-expanded={isOpen}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-stone-200 px-3 text-xs font-medium text-stone-600 hover:bg-stone-50 dark:border-emerald-950/80 dark:text-stone-300 dark:hover:bg-[#19241E]"
                    >
                      <span>{isOpen ? 'Close' : 'Open'}</span>
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Expanded Phrase Content */}
                {isOpen && (
                  <div className="border-t border-stone-100 p-4 pt-3 dark:border-emerald-950/70 space-y-4">
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      Context: {phrase.contextHint}
                    </p>

                    {/* Visible Error Box */}
                    {err && (
                      <div
                        role="alert"
                        className="flex flex-col gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-start gap-2">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                          <span className="leading-relaxed">{err}</span>
                        </div>
                        <button
                          type="button"
                          disabled={isLoading || isQueued}
                          onClick={() => requestTextTranslation(phrase, selectedModel)}
                          className="inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100 whitespace-nowrap"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Retry</span>
                        </button>
                      </div>
                    )}

                    {/* Translation Result */}
                    {isLoading && !evalItem?.output && (
                      <div className="flex items-center gap-2 rounded-xl bg-[#FAF9F5] px-3.5 py-3 text-xs font-medium text-stone-700 dark:bg-[#0D1310] dark:text-stone-300">
                        <Loader2 className="h-4 w-4 animate-spin text-emerald-700 dark:text-amber-300" aria-hidden="true" />
                        <span>{statusText}</span>
                      </div>
                    )}

                    {evalItem?.output && (
                      <div className="rounded-xl bg-[#FAF9F5] p-3.5 dark:bg-[#0D1310] space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                            Model translation ({evalItem.resolvedTargetLanguage ?? phrase.targetLanguage})
                          </span>
                          {evalItem.confidence && <ConfidenceBadge level={evalItem.confidence} />}
                        </div>
                        <p className="text-base font-semibold leading-snug text-stone-900 dark:text-stone-100">
                          {evalItem.output}
                        </p>
                        {evalItem.modelUsed && (
                          <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                            Model: {evalItem.modelUsed}
                          </p>
                        )}
                        {evalItem.notes && (
                          <p className="text-xs leading-relaxed text-stone-600 dark:text-stone-400">
                            Note: {evalItem.notes}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Rating & Suggested Better Version */}
                    <div className="space-y-3 border-t border-stone-100 pt-3 dark:border-emerald-950/70">
                      <p className="text-xs font-semibold text-stone-700 dark:text-stone-300">
                        Native speaker rating
                      </p>
                      <div
                        className="flex flex-wrap gap-2"
                        role="group"
                        aria-label={`Rate translation for ${phrase.id}`}
                      >
                        {RATING_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              onUpdateEvaluation(selectedModel, phrase.id, {
                                rating: opt.value,
                              })
                            }
                            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${ratingButtonClass(
                              evalItem?.rating,
                              opt.value,
                            )}`}
                          >
                            {evalItem?.rating === opt.value && (
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <span>{opt.label}</span>
                          </button>
                        ))}
                      </div>

                      <div>
                        <label
                          htmlFor={`fix-text-${phrase.id}`}
                          className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400"
                        >
                          Better version (optional)
                        </label>
                        <input
                          id={`fix-text-${phrase.id}`}
                          type="text"
                          value={evalItem?.suggestedFix ?? ''}
                          onChange={(e) =>
                            onUpdateEvaluation(selectedModel, phrase.id, {
                              suggestedFix: e.target.value,
                            })
                          }
                          placeholder="Type a better / more natural version…"
                          className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
