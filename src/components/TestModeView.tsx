import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import { TEST_PHRASES } from '../data/testPhrases';
import type {
  LanguageName,
  ModelChoice,
  TestCategory,
  TestPhrase,
  TestPhraseEvaluation,
  TestRatingValue,
  VoiceTestEvaluation,
} from '../types';
import {
  DEFAULT_MODEL_CONFIG,
  TEST_MODE_REQUEST_DELAY_MS,
  TranslationApiError,
  translateText,
  translateVoice,
  type ServerHealthConfig,
} from '../utils/api';
import {
  blobToBase64,
  isWebSpeechSupported,
  pickSupportedAudioMimeType,
  recognizeBrowserSpeech,
} from '../utils/speech';
import { makeEvalKey } from '../utils/storage';
import { ConfidenceBadge } from './ConfidenceBadge';

interface TestModeViewProps {
  evaluations: Record<string, TestPhraseEvaluation>;
  voiceEvaluations: Record<string, VoiceTestEvaluation>;
  modelConfig?: ServerHealthConfig;
  onUpdateEvaluation: (
    modelChoice: ModelChoice,
    phraseId: string,
    patch: Partial<TestPhraseEvaluation>,
  ) => void;
  onUpdateVoiceEvaluation: (
    modelChoice: ModelChoice,
    phraseId: string,
    patch: Partial<VoiceTestEvaluation>,
  ) => void;
  onResetEvaluations: (modelChoice: ModelChoice) => void;
  onResetVoiceEvaluations: (modelChoice: ModelChoice) => void;
  onNavigateToResults: () => void;
}

interface QueuedTask {
  key: string;
  phraseId: string;
  mode: 'text' | 'voice';
  run: () => Promise<void>;
}

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
const MAX_RECORDING_SECONDS = 30;

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

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function browserSpeechLangFor(sourceLanguage: LanguageName): 'en-US' | 'sw-KE' | null {
  if (sourceLanguage === 'English') return 'en-US';
  if (sourceLanguage === 'Swahili') return 'sw-KE';
  return null;
}

export function TestModeView({
  evaluations,
  voiceEvaluations,
  modelConfig = DEFAULT_MODEL_CONFIG,
  onUpdateEvaluation,
  onUpdateVoiceEvaluation,
  onResetEvaluations,
  onResetVoiceEvaluations,
  onNavigateToResults,
}: TestModeViewProps) {
  const [testTab, setTestTab] = useState<'text' | 'voice'>('text');
  const [selectedModel, setSelectedModel] = useState<ModelChoice>('primary');
  const [selectedCategory, setSelectedCategory] = useState<'All' | TestCategory>('All');
  const [selectedLanguage, setSelectedLanguage] = useState<'All' | LanguageName>('All');

  // Phrases start collapsed; translating happens on-demand when opened or when Translate is clicked
  const [openPhraseIds, setOpenPhraseIds] = useState<Record<string, boolean>>({});

  // Single-flight serialized request state (at most 1 request running across all phrases)
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [queuedKeys, setQueuedKeys] = useState<Record<string, boolean>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Voice test recording & browser speech state
  const [recordingPhraseId, setRecordingPhraseId] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [browserListeningPhraseId, setBrowserListeningPhraseId] = useState<string | null>(null);
  const [voiceErrors, setVoiceErrors] = useState<Record<string, string>>({});
  const [voiceShowFallback, setVoiceShowFallback] = useState<Record<string, boolean>>({});

  const queueRef = useRef<QueuedTask[]>([]);
  const activeTaskKeyRef = useRef<string | null>(null);
  const isQueueRunningRef = useRef(false);
  const lastRequestFinishedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);

  const modelOptions = useMemo<Array<{ value: ModelChoice; label: string; idHint: string }>>(
    () => [
      { value: 'primary', label: 'Gemma 26B', idHint: modelConfig.primaryModel },
      { value: 'alternative', label: 'Gemma 31B', idHint: modelConfig.alternativeModel },
      { value: 'fallback', label: 'Gemini Flash', idHint: modelConfig.fallbackModel },
    ],
    [modelConfig],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueRef.current = [];
      if (timerIntervalRef.current !== null) {
        window.clearInterval(timerIntervalRef.current);
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

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

  const voiceRatedCount = useMemo(() => {
    return TEST_PHRASES.filter((p) => {
      const ev = voiceEvaluations[makeEvalKey(selectedModel, p.id)];
      return Boolean(ev?.transcriptRating || ev?.translationRating);
    }).length;
  }, [voiceEvaluations, selectedModel]);

  const voiceRecordedCount = useMemo(() => {
    return TEST_PHRASES.filter((p) =>
      Boolean(voiceEvaluations[makeEvalKey(selectedModel, p.id)]?.transcript),
    ).length;
  }, [voiceEvaluations, selectedModel]);

  function stopMediaStreamAndTimer() {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }

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

  function clearVoiceError(modelChoice: ModelChoice, phraseId: string) {
    const evalKey = makeEvalKey(modelChoice, phraseId);
    setVoiceErrors((prev) => {
      if (!(evalKey in prev)) return prev;
      const next = { ...prev };
      delete next[evalKey];
      return next;
    });
    setVoiceShowFallback((prev) => {
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

  function handleResetCurrentVoiceEvaluations() {
    const prefix = `${selectedModel}::`;
    setVoiceErrors((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return next;
    });
    setVoiceShowFallback((prev) => {
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return next;
    });
    onResetVoiceEvaluations(selectedModel);
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

  function enqueueVoiceAudioTranslation(
    phrase: TestPhrase,
    blob: Blob,
    mimeType: string,
    modelChoice: ModelChoice,
  ) {
    const evalKey = makeEvalKey(modelChoice, phrase.id);
    if (blob.size < 400) {
      setVoiceErrors((prev) => ({
        ...prev,
        [evalKey]: 'No speech was detected. Please speak clearly closer to the phone.',
      }));
      setVoiceShowFallback((prev) => ({ ...prev, [evalKey]: true }));
      return;
    }

    const taskKey = `voice::${evalKey}`;
    clearVoiceError(modelChoice, phrase.id);

    enqueueTask({
      key: taskKey,
      phraseId: phrase.id,
      mode: 'voice',
      run: async () => {
        setRowStatus((prev) => ({
          ...prev,
          [taskKey]: 'Transcribing & translating…',
        }));

        try {
          const audioBase64 = await blobToBase64(blob);
          const res = await translateVoice({
            audioBase64,
            mimeType: mimeType || blob.type || 'audio/webm',
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
          clearVoiceError(modelChoice, phrase.id);
          onUpdateVoiceEvaluation(modelChoice, phrase.id, {
            transcript: res.transcript,
            output: res.translation,
            detectedLanguage: res.detected_language,
            resolvedTargetLanguage: res.target_language,
            confidence: res.confidence,
            notes: res.notes,
            modelUsed: res.model_used,
          });
        } catch (err) {
          if (!mountedRef.current) return;
          const msg =
            err instanceof Error
              ? err.message
              : 'Could not process voice recording. Please try again.';
          setVoiceErrors((prev) => ({ ...prev, [evalKey]: msg }));
          if (
            !(err instanceof TranslationApiError) ||
            err.code === 'AUDIO_UNSUPPORTED' ||
            err.code === 'NETWORK' ||
            err.code === 'HIGH_DEMAND' ||
            err.code === 'TIMEOUT' ||
            err.code === 'MODEL_NOT_FOUND' ||
            err.code === 'UNKNOWN'
          ) {
            setVoiceShowFallback((prev) => ({ ...prev, [evalKey]: true }));
          }
        }
      },
    });
  }

  function enqueueVoiceTranscriptTranslation(
    phrase: TestPhrase,
    transcriptText: string,
    modelChoice: ModelChoice = selectedModel,
  ) {
    const evalKey = makeEvalKey(modelChoice, phrase.id);
    const cleanTranscript = transcriptText.trim();
    if (!cleanTranscript) {
      setVoiceErrors((prev) => ({
        ...prev,
        [evalKey]: 'Please record audio or enter a transcript first.',
      }));
      return;
    }

    const taskKey = `voice::${evalKey}`;
    clearVoiceError(modelChoice, phrase.id);

    enqueueTask({
      key: taskKey,
      phraseId: phrase.id,
      mode: 'voice',
      run: async () => {
        setRowStatus((prev) => ({
          ...prev,
          [taskKey]: 'Translating transcript with Gemma 4…',
        }));

        try {
          const res = await translateText({
            text: cleanTranscript,
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
          clearVoiceError(modelChoice, phrase.id);
          onUpdateVoiceEvaluation(modelChoice, phrase.id, {
            transcript: cleanTranscript,
            output: res.translation,
            detectedLanguage: res.detected_language,
            resolvedTargetLanguage: res.target_language,
            confidence: res.confidence,
            notes: res.notes,
            modelUsed: res.model_used,
          });
        } catch (err) {
          if (!mountedRef.current) return;
          const msg =
            err instanceof Error
              ? err.message
              : 'Could not translate the captured transcript.';
          setVoiceErrors((prev) => ({ ...prev, [evalKey]: msg }));
        }
      },
    });
  }

  async function startVoiceTestRecording(phrase: TestPhrase) {
    const activeModel = selectedModel;
    const evalKey = makeEvalKey(activeModel, phrase.id);
    setOpenPhraseIds((prev) => ({ ...prev, [phrase.id]: true }));
    clearVoiceError(activeModel, phrase.id);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      const langCode = browserSpeechLangFor(phrase.sourceLanguage);
      const hint =
        langCode && isWebSpeechSupported()
          ? ` Audio recording is unavailable in this browser—you can use browser speech (${phrase.sourceLanguage}) below.`
          : ' Audio recording is not supported in this browser, and Luganda voice needs a connection to the server.';
      setVoiceErrors((prev) => ({
        ...prev,
        [evalKey]: `Audio recording is not supported in this browser.${hint}`,
      }));
      setVoiceShowFallback((prev) => ({ ...prev, [evalKey]: true }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = pickSupportedAudioMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const finalMime = recorder.mimeType || mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: finalMime });
        audioChunksRef.current = [];
        stopMediaStreamAndTimer();
        setRecordingPhraseId(null);
        setRecordingSeconds(0);
        enqueueVoiceAudioTranslation(phrase, audioBlob, finalMime, activeModel);
      };

      recorder.onerror = () => {
        audioChunksRef.current = [];
        stopMediaStreamAndTimer();
        setRecordingPhraseId(null);
        setRecordingSeconds(0);
        setVoiceErrors((prev) => ({
          ...prev,
          [evalKey]: 'Recording failed. Try again closer to the phone.',
        }));
        setVoiceShowFallback((prev) => ({ ...prev, [evalKey]: true }));
      };

      recorder.start();
      setRecordingPhraseId(phrase.id);
      setRecordingSeconds(0);

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => {
          const next = prev + 1;
          if (next >= MAX_RECORDING_SECONDS) {
            stopVoiceTestRecording();
            return MAX_RECORDING_SECONDS;
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      stopMediaStreamAndTimer();
      setRecordingPhraseId(null);
      const errName = err instanceof Error ? err.name : '';
      let msg = 'Could not access the microphone. Check your device settings.';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        msg = 'Microphone permission was denied. Allow microphone access in browser settings and try again.';
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        msg = 'No microphone was found on this device.';
      }
      setVoiceErrors((prev) => ({ ...prev, [evalKey]: msg }));
      setVoiceShowFallback((prev) => ({ ...prev, [evalKey]: true }));
    }
  }

  function stopVoiceTestRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      stopMediaStreamAndTimer();
      setRecordingPhraseId(null);
      setRecordingSeconds(0);
    }
  }

  function toggleVoiceTestRecording(phrase: TestPhrase) {
    if (recordingPhraseId === phrase.id) {
      stopVoiceTestRecording();
      return;
    }
    if (recordingPhraseId !== null) {
      stopVoiceTestRecording();
      return;
    }
    void startVoiceTestRecording(phrase);
  }

  async function handleVoiceTestBrowserSpeech(phrase: TestPhrase, langCode: 'en-US' | 'sw-KE') {
    const activeModel = selectedModel;
    const evalKey = makeEvalKey(activeModel, phrase.id);
    setOpenPhraseIds((prev) => ({ ...prev, [phrase.id]: true }));
    clearVoiceError(activeModel, phrase.id);
    setBrowserListeningPhraseId(phrase.id);

    try {
      const spokenText = await recognizeBrowserSpeech(langCode);
      onUpdateVoiceEvaluation(activeModel, phrase.id, {
        transcript: spokenText,
        detectedLanguage: langCode === 'sw-KE' ? 'Swahili' : 'English',
      });
      enqueueVoiceTranscriptTranslation(phrase, spokenText, activeModel);
    } catch (err) {
      setVoiceErrors((prev) => ({
        ...prev,
        [evalKey]:
          err instanceof Error
            ? err.message
            : 'Browser voice input failed. Please try recording again.',
      }));
    } finally {
      setBrowserListeningPhraseId(null);
    }
  }

  function handleRetryVoicePhrase(phrase: TestPhrase, voiceItem?: VoiceTestEvaluation) {
    const evalKey = makeEvalKey(selectedModel, phrase.id);
    clearVoiceError(selectedModel, phrase.id);

    const transcript =
      voiceItem?.suggestedTranscriptFix?.trim() || voiceItem?.transcript?.trim() || '';
    if (transcript) {
      enqueueVoiceTranscriptTranslation(phrase, transcript, selectedModel);
      return;
    }

    if (voiceShowFallback[evalKey] && typeof MediaRecorder === 'undefined') {
      const langCode = browserSpeechLangFor(phrase.sourceLanguage);
      if (langCode && isWebSpeechSupported()) {
        void handleVoiceTestBrowserSpeech(phrase, langCode);
        return;
      }
    }

    void startVoiceTestRecording(phrase);
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
              {testTab === 'text'
                ? 'Open any phrase or press Translate to test one request at a time.'
                : 'Open a phrase, record speech or use browser speech (English/Swahili), then rate transcript and translation.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400 tabular-nums">
              <span>Model: {activeModelMeta.label}</span>
              <span aria-hidden="true">·</span>
              <span>{TEST_PHRASES.length} phrases</span>
              <span aria-hidden="true">·</span>
              {testTab === 'text' ? (
                <>
                  <span>{translatedCount} translated</span>
                  <span aria-hidden="true">·</span>
                  <span>{ratedCount} rated</span>
                </>
              ) : (
                <>
                  <span>{voiceRecordedCount} recorded</span>
                  <span aria-hidden="true">·</span>
                  <span>{voiceRatedCount} rated</span>
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

            {testTab === 'voice' &&
              (voiceRatedCount > 0 || voiceRecordedCount > 0) &&
              !anyRequestActive && (
                <button
                  type="button"
                  onClick={handleResetCurrentVoiceEvaluations}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 px-3.5 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-300 dark:hover:bg-emerald-950/60 whitespace-nowrap"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Reset {activeModelMeta.label} voice</span>
                </button>
              )}
          </div>
        </div>

        {/* Mode Segmented Tabs: Text test | Voice test */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-4 dark:border-emerald-950/70">
          <div
            role="tablist"
            aria-label="Test mode type"
            className="inline-flex rounded-xl bg-stone-100 p-1 dark:bg-[#0D1310]"
          >
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
              Text test
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={testTab === 'voice'}
              onClick={() => setTestTab('voice')}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                testTab === 'voice'
                  ? 'bg-white text-emerald-950 shadow-sm dark:bg-[#19241E] dark:text-amber-300'
                  : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-200'
              }`}
            >
              <Mic className="h-4 w-4" aria-hidden="true" />
              <span>Voice test</span>
            </button>
          </div>

          {testTab === 'voice' && (
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Your voice is used only to translate and is not saved.
            </p>
          )}
        </div>

        {/* Model Selector & Filter Controls */}
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
      </section>

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

      {/* VOICE TEST VIEW */}
      {testTab === 'voice' && (
        <section className="space-y-4" aria-label="Voice test phrases">
          {filteredPhrases.map((phrase, idx) => {
            const evalKey = makeEvalKey(selectedModel, phrase.id);
            const voiceItem = voiceEvaluations[evalKey];
            const taskKey = `voice::${evalKey}`;
            const isRec = recordingPhraseId === phrase.id;
            const isListeningBrowser = browserListeningPhraseId === phrase.id;
            const isProcessing = activeTaskKey === taskKey;
            const isQueued = Boolean(queuedKeys[taskKey]);
            const vErr = voiceErrors[evalKey];
            const showFallback = Boolean(voiceShowFallback[evalKey]);
            const speechLang = browserSpeechLangFor(phrase.sourceLanguage);
            const statusText = rowStatus[taskKey] || 'Processing…';

            return (
              <article
                key={phrase.id}
                className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6"
              >
                {/* Prompt Row */}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-mono tabular-nums">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                        Speak in {phrase.sourceLanguage} → {phrase.targetLanguage}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{phrase.category}</span>
                    </div>
                    <p className="mt-1.5 text-base font-semibold leading-snug text-stone-900 dark:text-stone-50 sm:text-lg">
                      {phrase.phrase}
                    </p>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                      {phrase.contextHint}
                    </p>
                  </div>

                  {/* Controls: Server Mic Recording + Optional Browser Web Speech (English/Swahili) */}
                  <div className="flex flex-col gap-2 sm:items-end shrink-0">
                    <button
                      type="button"
                      disabled={
                        isProcessing ||
                        isQueued ||
                        isListeningBrowser ||
                        (recordingPhraseId !== null && !isRec)
                      }
                      onClick={() => toggleVoiceTestRecording(phrase)}
                      aria-pressed={isRec}
                      className={`relative inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55 ${
                        isRec
                          ? 'bg-rose-700 text-white ring-4 ring-rose-500/30 hover:bg-rose-800 dark:bg-rose-600'
                          : 'bg-amber-500 text-stone-950 hover:bg-amber-400 dark:bg-amber-400 dark:text-stone-950'
                      }`}
                    >
                      {isRec && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 rounded-xl border-2 border-rose-300/80 animate-ping"
                        />
                      )}
                      {isProcessing || isQueued ? (
                        <>
                          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                          <span>{isQueued ? 'Queued…' : statusText}</span>
                        </>
                      ) : isRec ? (
                        <>
                          <Square className="h-5 w-5 fill-current" aria-hidden="true" />
                          <span className="font-mono tabular-nums">
                            Stop ({formatTimer(recordingSeconds)})
                          </span>
                        </>
                      ) : (
                        <>
                          <Mic className="h-5 w-5" aria-hidden="true" />
                          <span>{voiceItem?.transcript ? 'Re-record phrase' : 'Record phrase'}</span>
                        </>
                      )}
                    </button>

                    {speechLang && isWebSpeechSupported() && !isRec && (
                      <button
                        type="button"
                        disabled={isProcessing || isQueued || isListeningBrowser}
                        onClick={() => void handleVoiceTestBrowserSpeech(phrase, speechLang)}
                        className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-amber-50 disabled:opacity-55 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-200 dark:hover:bg-emerald-950/50 whitespace-nowrap"
                      >
                        {isListeningBrowser ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            <span>Listening ({phrase.sourceLanguage})…</span>
                          </>
                        ) : (
                          <>
                            <Mic className="h-3.5 w-3.5 text-emerald-700 dark:text-amber-300" aria-hidden="true" />
                            <span>Use browser speech ({phrase.sourceLanguage})</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Visible Voice Error Alert */}
                {vErr && (
                  <div
                    role="alert"
                    className="mt-3 space-y-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
                  >
                    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                        <span className="leading-relaxed">{vErr}</span>
                      </div>
                      <button
                        type="button"
                        disabled={isProcessing || isQueued || isListeningBrowser}
                        onClick={() => handleRetryVoicePhrase(phrase, voiceItem)}
                        className="inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100 whitespace-nowrap"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Retry</span>
                      </button>
                    </div>

                    {showFallback && (
                      <div className="border-t border-rose-200/80 pt-2 dark:border-rose-900/60 flex flex-wrap items-center gap-2">
                        {speechLang && isWebSpeechSupported() ? (
                          <button
                            type="button"
                            disabled={isProcessing || isQueued || isListeningBrowser}
                            onClick={() => void handleVoiceTestBrowserSpeech(phrase, speechLang)}
                            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 font-semibold text-stone-900 hover:bg-amber-50 dark:border-rose-800 dark:bg-[#141D18] dark:text-stone-100"
                          >
                            <Mic className="h-3.5 w-3.5 text-emerald-700 dark:text-amber-300" aria-hidden="true" />
                            <span>Try browser speech ({phrase.sourceLanguage})</span>
                          </button>
                        ) : (
                          <span className="text-rose-800 dark:text-rose-200">
                            {phrase.sourceLanguage === 'Luganda'
                              ? 'Luganda voice requires server audio transcription. Check microphone permissions and try again.'
                              : 'Browser speech fallback is unavailable on this browser.'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Transcript & Translation Evaluation Grid */}
                {(voiceItem?.transcript || voiceItem?.output) && (
                  <div className="mt-4 grid grid-cols-1 gap-5 border-t border-stone-100 pt-4 dark:border-emerald-950/70 lg:grid-cols-2">
                    {/* Transcript Evaluation */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                          Heard transcript ({voiceItem.detectedLanguage ?? phrase.sourceLanguage})
                        </span>
                        {voiceItem.transcript && (
                          <button
                            type="button"
                            disabled={isProcessing || isQueued}
                            onClick={() =>
                              enqueueVoiceTranscriptTranslation(
                                phrase,
                                voiceItem.suggestedTranscriptFix?.trim() || voiceItem.transcript || '',
                                selectedModel,
                              )
                            }
                            className="inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-emerald-950/50"
                          >
                            <RefreshCw className="h-3 w-3" aria-hidden="true" />
                            <span>Re-translate with {activeModelMeta.label}</span>
                          </button>
                        )}
                      </div>
                      <p className="rounded-xl bg-[#FAF9F5] px-3.5 py-2.5 text-sm font-medium text-stone-900 dark:bg-[#0D1310] dark:text-stone-100">
                        {voiceItem.transcript}
                      </p>

                      <div className="space-y-2">
                        <span className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                          Rate transcript accuracy
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {RATING_OPTIONS.map((opt) => (
                            <button
                              key={`tr-${opt.value}`}
                              type="button"
                              onClick={() =>
                                onUpdateVoiceEvaluation(selectedModel, phrase.id, {
                                  transcriptRating: opt.value,
                                })
                              }
                              className={`inline-flex min-h-[40px] items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${ratingButtonClass(
                                voiceItem.transcriptRating,
                                opt.value,
                              )}`}
                            >
                              {voiceItem.transcriptRating === opt.value && (
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              <span>{opt.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label htmlFor={`vfix-tr-${phrase.id}`} className="sr-only">
                          Better transcript for {phrase.id}
                        </label>
                        <input
                          id={`vfix-tr-${phrase.id}`}
                          type="text"
                          value={voiceItem.suggestedTranscriptFix ?? ''}
                          onChange={(e) =>
                            onUpdateVoiceEvaluation(selectedModel, phrase.id, {
                              suggestedTranscriptFix: e.target.value,
                            })
                          }
                          placeholder="Optional: correct the transcript…"
                          className="min-h-[40px] w-full rounded-xl border border-stone-200 bg-[#FAF9F5] px-3 py-2 text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none dark:border-emerald-900/70 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
                        />
                      </div>
                    </div>

                    {/* Translation Evaluation */}
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                          Translation ({voiceItem.resolvedTargetLanguage ?? phrase.targetLanguage})
                        </span>
                        {voiceItem.confidence && (
                          <ConfidenceBadge level={voiceItem.confidence} />
                        )}
                      </div>
                      <p className="rounded-xl bg-[#FAF9F5] px-3.5 py-2.5 text-sm font-semibold text-stone-900 dark:bg-[#0D1310] dark:text-stone-100">
                        {voiceItem.output}
                      </p>
                      {voiceItem.modelUsed && (
                        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                          Model: {voiceItem.modelUsed}
                        </p>
                      )}
                      {voiceItem.notes && (
                        <p className="text-xs text-stone-500 dark:text-stone-400">
                          Note: {voiceItem.notes}
                        </p>
                      )}

                      <div className="space-y-2">
                        <span className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                          Rate translation quality
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {RATING_OPTIONS.map((opt) => (
                            <button
                              key={`tl-${opt.value}`}
                              type="button"
                              onClick={() =>
                                onUpdateVoiceEvaluation(selectedModel, phrase.id, {
                                  translationRating: opt.value,
                                })
                              }
                              className={`inline-flex min-h-[40px] items-center gap-1 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${ratingButtonClass(
                                voiceItem.translationRating,
                                opt.value,
                              )}`}
                            >
                              {voiceItem.translationRating === opt.value && (
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              <span>{opt.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label htmlFor={`vfix-tl-${phrase.id}`} className="sr-only">
                          Better translation for {phrase.id}
                        </label>
                        <input
                          id={`vfix-tl-${phrase.id}`}
                          type="text"
                          value={voiceItem.suggestedTranslationFix ?? ''}
                          onChange={(e) =>
                            onUpdateVoiceEvaluation(selectedModel, phrase.id, {
                              suggestedTranslationFix: e.target.value,
                            })
                          }
                          placeholder="Optional: type a better translation…"
                          className="min-h-[40px] w-full rounded-xl border border-stone-200 bg-[#FAF9F5] px-3 py-2 text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none dark:border-emerald-900/70 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
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
