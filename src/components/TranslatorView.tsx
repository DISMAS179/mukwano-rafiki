import { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  Clock,
  Copy,
  Flag,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BadTranslationReport,
  DomainOption,
  HistoryItem,
  LanguageName,
  TargetLanguageOption,
  TranslationResponse,
} from '../types';
import { translateText } from '../utils/api';
import { ConfidenceBadge } from './ConfidenceBadge';

interface TranslatorViewProps {
  history: HistoryItem[];
  initialText?: string | null;
  onConsumeInitialText?: () => void;
  onTranslationSuccess: (item: HistoryItem) => void;
  onClearHistory: () => void;
  onSubmitReport: (report: BadTranslationReport) => void;
  onNavigateToReports: () => void;
}

const TARGET_OPTIONS: TargetLanguageOption[] = ['Auto', 'Luganda', 'Swahili', 'English'];
const DOMAIN_OPTIONS: DomainOption[] = ['General', 'Health', 'Market', 'School'];

const QUICK_STARTERS: Array<{ label: string; text: string; domain: DomainOption }> = [
  {
    label: 'Market price (Luganda)',
    text: 'Kino kigula ssente mmeka? Nnyinza okukuwa UGX 5,000?',
    domain: 'Market',
  },
  {
    label: 'Clinic greeting (Swahili)',
    text: 'Shikamoo daktari, kichwa kinaniuma tangu asubuhi.',
    domain: 'Health',
  },
  {
    label: 'School timetable (English)',
    text: 'When does the mathematics exam start tomorrow morning?',
    domain: 'School',
  },
];

function isSupportedLanguage(val: string): val is LanguageName {
  return val === 'Luganda' || val === 'Swahili' || val === 'English';
}

export function TranslatorView({
  history,
  initialText,
  onConsumeInitialText,
  onTranslationSuccess,
  onClearHistory,
  onSubmitReport,
  onNavigateToReports,
}: TranslatorViewProps) {
  const [inputText, setInputText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState<TargetLanguageOption>('Auto');
  const [domain, setDomain] = useState<DomainOption>('General');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Translating…');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslationResponse | null>(null);
  const [lastInput, setLastInput] = useState('');
  const [lastDomain, setLastDomain] = useState<DomainOption>('General');

  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Report bad translation drawer state
  const [reportOpen, setReportOpen] = useState(false);
  const [suggestedFix, setSuggestedFix] = useState('');
  const [reportSavedMessage, setReportSavedMessage] = useState(false);

  useEffect(() => {
    if (!initialText) return;
    const text = initialText.trim();
    if (!text) return;
    setInputText(text);
    setTargetLanguage('Auto');
    setDomain('General');
    onConsumeInitialText?.();
    void handleTranslate(text, 'Auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  async function handleTranslate(overrideText?: string, overrideTarget?: TargetLanguageOption) {
    const textToTranslate = (overrideText ?? inputText).trim();
    const effectiveTarget = overrideTarget ?? targetLanguage;

    if (!textToTranslate) {
      setError('Please enter a word, sentence, or phrase to translate.');
      return;
    }

    setLoading(true);
    setLoadingLabel('Translating…');
    setError(null);
    setReportOpen(false);
    setReportSavedMessage(false);
    setSuggestedFix('');

    try {
      const res = await translateText({
        text: textToTranslate,
        targetLanguage: effectiveTarget,
        domain,
        onStatus: (statusMsg) => setLoadingLabel(statusMsg),
      });

      setError(null);
      setResult(res);
      setLastInput(textToTranslate);
      setLastDomain(domain);

      const historyItem: HistoryItem = {
        id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        input: textToTranslate,
        domain,
        requestedTarget: effectiveTarget,
        ...res,
      };
      onTranslationSuccess(historyItem);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Something went wrong while translating.',
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSwapLanguages() {
    if (result && result.translation.trim().length > 0) {
      const previousDetected = result.detected_language;
      const swappedInput = result.translation;
      const nextTarget: TargetLanguageOption = isSupportedLanguage(previousDetected)
        ? previousDetected
        : 'Auto';

      setInputText(swappedInput);
      setTargetLanguage(nextTarget);
      setResult(null);
      setError(null);
      setReportOpen(false);
      setReportSavedMessage(false);
      return;
    }

    if (targetLanguage === 'Auto' || targetLanguage === 'Luganda') {
      setTargetLanguage('English');
    } else {
      setTargetLanguage('Luganda');
    }
  }

  async function handleCopy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => {
        setCopiedId((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard fallback ignored quietly
    }
  }

  function handleSaveReport(e: React.FormEvent) {
    e.preventDefault();
    if (!result || !suggestedFix.trim()) return;

    const report: BadTranslationReport = {
      id: `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      input: lastInput || inputText.trim(),
      output: result.translation,
      suggestedFix: suggestedFix.trim(),
      languagePair: `${result.detected_language} → ${result.target_language}`,
      domain: lastDomain,
      model_used: result.model_used,
    };

    onSubmitReport(report);
    setSuggestedFix('');
    setReportOpen(false);
    setReportSavedMessage(true);
  }

  function handleRestoreHistory(item: HistoryItem) {
    setInputText(item.input);
    setDomain(item.domain);
    setTargetLanguage(item.requestedTarget);
    setLastInput(item.input);
    setLastDomain(item.domain);
    setResult({
      detected_language: item.detected_language,
      target_language: item.target_language,
      translation: item.translation,
      confidence: item.confidence,
      notes: item.notes,
      model_used: item.model_used,
    });
    setError(null);
    setReportOpen(false);
    setReportSavedMessage(false);
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
      {/* Primary Translator Column */}
      <section className="space-y-5 lg:col-span-7" aria-label="Translator">
        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
          {/* Top metadata / auto-detect bar */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2 text-stone-600 dark:text-stone-300">
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                {result ? `Detected: ${result.detected_language}` : 'Auto-detect input'}
              </span>
              <span aria-hidden="true">·</span>
              <span>Luganda, Swahili, or English</span>
            </div>

            {inputText.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setInputText('');
                  setError(null);
                }}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-emerald-950/60 dark:hover:text-stone-100 transition-colors"
                aria-label="Clear input text"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Clear
              </button>
            )}
          </div>

          {/* Textarea */}
          <div>
            <label htmlFor="source-text" className="sr-only">
              Text to translate
            </label>
            <textarea
              id="source-text"
              rows={4}
              maxLength={2000}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleTranslate();
                }
              }}
              placeholder="Type or paste Luganda, Swahili, or English text…"
              className="h-full min-h-[124px] w-full resize-y rounded-xl border border-stone-300 bg-[#FAF9F5] px-4 py-3.5 text-base leading-relaxed text-stone-900 placeholder:text-stone-400 focus:border-emerald-700 focus:bg-white focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-amber-400 dark:focus:bg-[#101814]"
            />
          </div>

          <div className="mt-2.5 flex items-center justify-end text-xs text-stone-500 dark:text-stone-400">
            <span className="font-mono tabular-nums">{inputText.length}/2000</span>
          </div>

          {/* Quick Starters */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-stone-100 pt-3 text-xs dark:border-emerald-950/70">
            <span className="font-medium text-stone-500 dark:text-stone-400">Try example:</span>
            {QUICK_STARTERS.map((starter) => (
              <button
                key={starter.label}
                type="button"
                onClick={() => {
                  setInputText(starter.text);
                  setDomain(starter.domain);
                  setTargetLanguage('Auto');
                  setError(null);
                }}
                className="min-h-[36px] py-1 font-medium text-emerald-800 underline decoration-emerald-700/40 underline-offset-4 hover:text-emerald-950 dark:text-amber-300 dark:decoration-amber-400/40 dark:hover:text-amber-200 whitespace-nowrap"
              >
                {starter.label}
              </button>
            ))}
          </div>

          {/* Controls: Target, Swap, Domain */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
            <div className="sm:col-span-5">
              <label
                htmlFor="target-language"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Target language
              </label>
              <select
                id="target-language"
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value as TargetLanguageOption)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2.5 text-sm font-medium text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:focus:border-amber-400"
              >
                {TARGET_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === 'Auto' ? 'Auto (En→Lg · Lg/Sw→En)' : opt}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-center sm:col-span-2">
              <button
                type="button"
                onClick={handleSwapLanguages}
                title="Swap languages"
                aria-label="Swap languages"
                className="inline-flex min-h-[44px] w-full sm:w-[44px] items-center justify-center gap-2 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm font-medium text-stone-700 hover:bg-amber-50 hover:border-amber-400 hover:text-amber-900 active:scale-[0.98] dark:border-emerald-900/80 dark:bg-[#19241E] dark:text-stone-200 dark:hover:border-amber-500/60 dark:hover:bg-amber-950/30 dark:hover:text-amber-200 transition-colors"
              >
                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                <span className="sm:sr-only">Swap languages</span>
              </button>
            </div>

            <div className="sm:col-span-5">
              <label
                htmlFor="domain-context"
                className="mb-1.5 block text-xs font-semibold text-stone-700 dark:text-stone-300"
              >
                Context / Domain
              </label>
              <select
                id="domain-context"
                value={domain}
                onChange={(e) => setDomain(e.target.value as DomainOption)}
                className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2.5 text-sm font-medium text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:focus:border-amber-400"
              >
                {DOMAIN_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Primary Translate CTA */}
          <div className="mt-5">
            <button
              type="button"
              disabled={loading}
              onClick={() => void handleTranslate()}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2.5 rounded-xl bg-emerald-800 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-emerald-900 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-65 dark:bg-emerald-600 dark:text-stone-950 dark:hover:bg-emerald-500 transition-all"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  <span>{loadingLabel}</span>
                </>
              ) : (
                <span>Translate text</span>
              )}
            </button>
          </div>
        </div>

        {/* Friendly Error State */}
        {error && (
          <div
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="leading-relaxed">{error}</p>
              {inputText.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleTranslate()}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-900 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100 dark:hover:bg-rose-900/70 whitespace-nowrap"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Retry
                </button>
              )}
            </div>
          </div>
        )}

        {/* Result Card */}
        {result && (
          <div
            aria-live="polite"
            className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 pb-3 dark:border-emerald-950/70">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-stone-600 dark:text-stone-300">
                <span>Detected: {result.detected_language}</span>
                <span aria-hidden="true">·</span>
                <span>To: {result.target_language}</span>
                <span aria-hidden="true">·</span>
                <span>{lastDomain}</span>
              </div>
              <ConfidenceBadge level={result.confidence} />
            </div>

            <div className="py-4">
              <p className="text-xl font-semibold leading-snug text-stone-900 dark:text-stone-50 sm:text-2xl">
                {result.translation}
              </p>
            </div>

            {/* Cultural / ambiguity notes */}
            <div className="rounded-xl bg-[#FAF9F5] px-4 py-3 text-sm text-stone-700 dark:bg-[#0D1310] dark:text-stone-300">
              <span className="font-semibold text-amber-800 dark:text-amber-300">
                Notes &amp; alternatives:{' '}
              </span>
              <span>
                {result.notes && result.notes.trim().length > 0
                  ? result.notes
                  : 'No ambiguity or extra cultural notes for this phrase.'}
              </span>
            </div>

            {result.model_used && (
              <p className="mt-2.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                Model: {result.model_used}
              </p>
            )}

            {/* Action buttons: Copy, Report */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleCopy(result.translation, 'current')}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 hover:bg-stone-50 active:scale-[0.98] dark:border-emerald-900/80 dark:bg-[#19241E] dark:text-stone-100 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                {copiedId === 'current' ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    <span>Copy translation</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setReportOpen((prev) => !prev);
                  setReportSavedMessage(false);
                }}
                className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50/70 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 active:scale-[0.98] dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50 whitespace-nowrap"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
                <span>Report bad translation</span>
              </button>
            </div>

            {/* Report Confirmation */}
            {reportSavedMessage && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-3 text-sm text-emerald-800 dark:border-emerald-950/70 dark:text-emerald-300">
                <span>Thank you. Your correction has been saved.</span>
                <button
                  type="button"
                  onClick={onNavigateToReports}
                  className="min-h-[36px] font-semibold underline underline-offset-4 hover:text-emerald-950 dark:hover:text-emerald-200"
                >
                  View saved reports
                </button>
              </div>
            )}

            {/* Inline Report Form */}
            {reportOpen && (
              <form
                onSubmit={handleSaveReport}
                className="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-emerald-950/80"
              >
                <label
                  htmlFor="better-translation-input"
                  className="block text-sm font-semibold text-stone-800 dark:text-stone-200"
                >
                  Type a better {result.target_language} translation
                </label>
                <textarea
                  id="better-translation-input"
                  rows={2}
                  required
                  value={suggestedFix}
                  onChange={(e) => setSuggestedFix(e.target.value)}
                  placeholder="How would a native speaker say this naturally?"
                  className="w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400"
                  >
                    Save report
                  </button>
                  <button
                    type="button"
                    onClick={() => setReportOpen(false)}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-emerald-950/60"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </section>

      {/* Last 10 History Column */}
      <aside className="lg:col-span-5" aria-label="Recent translations">
        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-stone-100 pb-3 dark:border-emerald-950/70">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
              <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                Recent translations ({history.length}/10)
              </h2>
            </div>

            {history.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-stone-600 hover:bg-stone-100 hover:text-rose-700 dark:text-stone-400 dark:hover:bg-emerald-950/60 dark:hover:text-rose-300 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Clear
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <p className="py-6 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
              Your last 10 translations will appear here in your browser for quick reuse offline or at the market.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100 dark:divide-emerald-950/70">
              {history.map((item) => (
                <li key={item.id} className="py-3 first:pt-1 last:pb-1">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handleRestoreHistory(item)}
                      className="min-h-[44px] flex-1 text-left group"
                    >
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                        <span>{item.detected_language} → {item.target_language}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.domain}</span>
                        <span aria-hidden="true">·</span>
                        <span className="capitalize">{item.confidence}</span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-stone-600 dark:text-stone-400">
                        {item.input}
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-stone-900 group-hover:text-emerald-800 dark:text-stone-100 dark:group-hover:text-amber-300">
                        {item.translation}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCopy(item.translation, item.id)}
                      aria-label={`Copy translation: ${item.translation}`}
                      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-emerald-950/60 dark:hover:text-stone-100"
                    >
                      {copiedId === item.id ? (
                        <Check className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                      ) : (
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
