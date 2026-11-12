import { useMemo } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { TEST_PHRASES } from '../data/testPhrases';
import type {
  BadTranslationReport,
  LanguageName,
  ModelChoice,
  TestPhraseEvaluation,
  VoiceTestEvaluation,
} from '../types';
import { DEFAULT_MODEL_CONFIG, type ServerHealthConfig } from '../utils/api';
import { buildCsvExport, downloadCsv } from '../utils/csv';

interface ResultsViewProps {
  evaluations: Record<string, TestPhraseEvaluation>;
  voiceEvaluations: Record<string, VoiceTestEvaluation>;
  reports: BadTranslationReport[];
  modelConfig?: ServerHealthConfig;
  onDeleteReport: (id: string) => void;
  onNavigateToTest: () => void;
}

interface ScoreBucket {
  correct: number;
  understandable: number;
  wrong: number;
  totalRated: number;
  accuracyPct: number | null;
}

interface LanguageStats {
  language: LanguageName;
  textTranslation: ScoreBucket;
  voiceTranscript: ScoreBucket;
  voiceTranslation: ScoreBucket;
}

interface ModelComparisonRow {
  choice: ModelChoice;
  label: string;
  modelId: string;
  overall: ScoreBucket;
  voiceOverall: ScoreBucket;
  byLanguage: Record<LanguageName, ScoreBucket>;
}

const LANGUAGES: LanguageName[] = ['Luganda', 'Swahili', 'English'];

function emptyBucket(): ScoreBucket {
  return {
    correct: 0,
    understandable: 0,
    wrong: 0,
    totalRated: 0,
    accuracyPct: null,
  };
}

function recordScore(bucket: ScoreBucket, rating: string | undefined) {
  if (!rating) return;
  bucket.totalRated += 1;
  if (rating === 'correct') bucket.correct += 1;
  else if (rating === 'understandable') bucket.understandable += 1;
  else if (rating === 'wrong') bucket.wrong += 1;
}

function finalizeBucket(bucket: ScoreBucket): ScoreBucket {
  return {
    ...bucket,
    accuracyPct:
      bucket.totalRated > 0 ? Math.round((bucket.correct / bucket.totalRated) * 100) : null,
  };
}

function formatScoreCell(bucket: ScoreBucket): string {
  if (bucket.totalRated === 0 || bucket.accuracyPct === null) return '—';
  return `${bucket.accuracyPct}% (${bucket.correct}/${bucket.totalRated})`;
}

export function ResultsView({
  evaluations,
  voiceEvaluations,
  reports,
  modelConfig = DEFAULT_MODEL_CONFIG,
  onDeleteReport,
  onNavigateToTest,
}: ResultsViewProps) {
  const phraseMap = useMemo(() => new Map(TEST_PHRASES.map((p) => [p.id, p])), []);

  const modelMeta = useMemo<Array<{ choice: ModelChoice; label: string; modelId: string }>>(
    () => [
      { choice: 'primary', label: 'Gemma 26B', modelId: modelConfig.primaryModel },
      { choice: 'alternative', label: 'Gemma 31B', modelId: modelConfig.alternativeModel },
      { choice: 'fallback', label: 'Gemini Flash', modelId: modelConfig.fallbackModel },
    ],
    [modelConfig],
  );

  const {
    perLanguage,
    overallText,
    overallVoiceTranscript,
    overallVoiceTranslation,
    modelComparison,
  } = useMemo(() => {
    const map: Record<LanguageName, LanguageStats> = {
      Luganda: {
        language: 'Luganda',
        textTranslation: emptyBucket(),
        voiceTranscript: emptyBucket(),
        voiceTranslation: emptyBucket(),
      },
      Swahili: {
        language: 'Swahili',
        textTranslation: emptyBucket(),
        voiceTranscript: emptyBucket(),
        voiceTranslation: emptyBucket(),
      },
      English: {
        language: 'English',
        textTranslation: emptyBucket(),
        voiceTranscript: emptyBucket(),
        voiceTranslation: emptyBucket(),
      },
    };

    const modelBuckets: Record<
      ModelChoice,
      {
        overall: ScoreBucket;
        voiceOverall: ScoreBucket;
        byLanguage: Record<LanguageName, ScoreBucket>;
      }
    > = {
      primary: {
        overall: emptyBucket(),
        voiceOverall: emptyBucket(),
        byLanguage: {
          Luganda: emptyBucket(),
          Swahili: emptyBucket(),
          English: emptyBucket(),
        },
      },
      alternative: {
        overall: emptyBucket(),
        voiceOverall: emptyBucket(),
        byLanguage: {
          Luganda: emptyBucket(),
          Swahili: emptyBucket(),
          English: emptyBucket(),
        },
      },
      fallback: {
        overall: emptyBucket(),
        voiceOverall: emptyBucket(),
        byLanguage: {
          Luganda: emptyBucket(),
          Swahili: emptyBucket(),
          English: emptyBucket(),
        },
      },
    };

    for (const textEv of Object.values(evaluations)) {
      if (!textEv.rating) continue;
      const phrase = phraseMap.get(textEv.phraseId);
      if (!phrase) continue;

      recordScore(map[phrase.sourceLanguage].textTranslation, textEv.rating);

      const choice: ModelChoice = textEv.modelChoice ?? 'primary';
      recordScore(modelBuckets[choice].overall, textEv.rating);
      recordScore(modelBuckets[choice].byLanguage[phrase.sourceLanguage], textEv.rating);
    }

    for (const voiceEv of Object.values(voiceEvaluations)) {
      const phrase = phraseMap.get(voiceEv.phraseId);
      if (!phrase) continue;

      if (voiceEv.transcriptRating) {
        recordScore(map[phrase.sourceLanguage].voiceTranscript, voiceEv.transcriptRating);
      }
      if (voiceEv.translationRating) {
        recordScore(map[phrase.sourceLanguage].voiceTranslation, voiceEv.translationRating);
        const choice: ModelChoice = voiceEv.modelChoice ?? 'primary';
        recordScore(modelBuckets[choice].voiceOverall, voiceEv.translationRating);
      }
    }

    const list = LANGUAGES.map((lang) => ({
      language: lang,
      textTranslation: finalizeBucket(map[lang].textTranslation),
      voiceTranscript: finalizeBucket(map[lang].voiceTranscript),
      voiceTranslation: finalizeBucket(map[lang].voiceTranslation),
    }));

    const sumBuckets = (picker: (s: LanguageStats) => ScoreBucket): ScoreBucket => {
      const acc = emptyBucket();
      for (const item of list) {
        const b = picker(item);
        acc.correct += b.correct;
        acc.understandable += b.understandable;
        acc.wrong += b.wrong;
        acc.totalRated += b.totalRated;
      }
      return finalizeBucket(acc);
    };

    const comparisonRows: ModelComparisonRow[] = modelMeta.map((meta) => ({
      choice: meta.choice,
      label: meta.label,
      modelId: meta.modelId,
      overall: finalizeBucket(modelBuckets[meta.choice].overall),
      voiceOverall: finalizeBucket(modelBuckets[meta.choice].voiceOverall),
      byLanguage: {
        Luganda: finalizeBucket(modelBuckets[meta.choice].byLanguage.Luganda),
        Swahili: finalizeBucket(modelBuckets[meta.choice].byLanguage.Swahili),
        English: finalizeBucket(modelBuckets[meta.choice].byLanguage.English),
      },
    }));

    return {
      perLanguage: list,
      overallText: sumBuckets((s) => s.textTranslation),
      overallVoiceTranscript: sumBuckets((s) => s.voiceTranscript),
      overallVoiceTranslation: sumBuckets((s) => s.voiceTranslation),
      modelComparison: comparisonRows,
    };
  }, [evaluations, voiceEvaluations, phraseMap, modelMeta]);

  const testSuggestions = useMemo(() => {
    return Object.values(evaluations)
      .filter((ev) => Boolean(ev.suggestedFix && ev.suggestedFix.trim().length > 0))
      .map((ev) => ({
        phrase: phraseMap.get(ev.phraseId),
        evaluation: ev,
      }))
      .filter((item): item is { phrase: NonNullable<typeof item.phrase>; evaluation: TestPhraseEvaluation } =>
        Boolean(item.phrase),
      );
  }, [evaluations, phraseMap]);

  const voiceSuggestions = useMemo(() => {
    return Object.values(voiceEvaluations)
      .filter(
        (ev) =>
          Boolean(ev.suggestedTranscriptFix && ev.suggestedTranscriptFix.trim().length > 0) ||
          Boolean(ev.suggestedTranslationFix && ev.suggestedTranslationFix.trim().length > 0),
      )
      .map((ev) => ({
        phrase: phraseMap.get(ev.phraseId),
        evaluation: ev,
      }))
      .filter((item): item is { phrase: NonNullable<typeof item.phrase>; evaluation: VoiceTestEvaluation } =>
        Boolean(item.phrase),
      );
  }, [voiceEvaluations, phraseMap]);

  const hasExportableData =
    overallText.totalRated > 0 ||
    overallVoiceTranscript.totalRated > 0 ||
    overallVoiceTranslation.totalRated > 0 ||
    reports.length > 0 ||
    Object.values(evaluations).some((ev) => Boolean(ev.output || ev.suggestedFix)) ||
    Object.values(voiceEvaluations).some((ev) =>
      Boolean(
        ev.transcript ||
          ev.output ||
          ev.suggestedTranscriptFix ||
          ev.suggestedTranslationFix,
      ),
    );

  function handleExportCsv() {
    const csv = buildCsvExport(TEST_PHRASES, evaluations, voiceEvaluations, reports, modelConfig);
    const dateStamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`mukwano-rafiki-feedback-${dateStamp}.csv`, csv);
  }

  return (
    <div className="space-y-6">
      {/* Summary Header & CSV Export */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-stone-900 dark:text-stone-50">
              Accuracy &amp; Feedback Results
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              Accuracy score is calculated as{' '}
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Correct ÷ Total rated
              </span>{' '}
              across models and languages.
            </p>
          </div>

          <button
            type="button"
            disabled={!hasExportableData}
            onClick={handleExportCsv}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-500 dark:text-stone-950 dark:hover:bg-amber-400 whitespace-nowrap"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span>Export ratings &amp; reports (CSV)</span>
          </button>
        </div>

        {/* Accuracy Per Model & Per Language Comparison */}
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-bold text-stone-800 dark:text-stone-200">
            Model comparison (per model &amp; per language)
          </h3>
          <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-emerald-950/80">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-[#FAF9F5] text-xs font-semibold text-stone-600 dark:border-emerald-950/80 dark:bg-[#0D1310] dark:text-stone-300">
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Text overall</th>
                  <th className="px-4 py-3">Voice translation</th>
                  <th className="px-4 py-3">Luganda</th>
                  <th className="px-4 py-3">Swahili</th>
                  <th className="px-4 py-3">English</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-emerald-950/70 tabular-nums">
                {modelComparison.map((row) => (
                  <tr key={row.choice} className="hover:bg-stone-50/70 dark:hover:bg-[#18231D]/50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-stone-900 dark:text-stone-100">
                        {row.label}
                      </div>
                      <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                        {row.modelId}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-emerald-900 dark:text-emerald-300">
                      {formatScoreCell(row.overall)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-amber-800 dark:text-amber-300">
                      {formatScoreCell(row.voiceOverall)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-stone-700 dark:text-stone-300">
                      {formatScoreCell(row.byLanguage.Luganda)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-stone-700 dark:text-stone-300">
                      {formatScoreCell(row.byLanguage.Swahili)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-stone-700 dark:text-stone-300">
                      {formatScoreCell(row.byLanguage.English)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Text Test Combined Accuracy Cards */}
        <div className="mt-7 border-t border-stone-100 pt-6 dark:border-emerald-950/70">
          <h3 className="mb-3 text-sm font-bold text-stone-800 dark:text-stone-200">
            Combined text translation accuracy
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/70 dark:bg-emerald-950/30">
              <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-300">
                Overall text accuracy
              </p>
              <p className="mt-2 font-mono text-3xl font-bold tabular-nums text-emerald-950 dark:text-emerald-100">
                {overallText.accuracyPct !== null ? `${overallText.accuracyPct}%` : '—'}
              </p>
              <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300/90 tabular-nums">
                {overallText.correct} / {overallText.totalRated} rated correct
              </p>
            </div>

            {perLanguage.map((stat) => (
              <div
                key={`text-${stat.language}`}
                className="rounded-2xl border border-stone-200 bg-[#FAF9F5] p-4 dark:border-emerald-950/80 dark:bg-[#0D1310]"
              >
                <p className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                  {stat.language} input
                </p>
                <p className="mt-2 font-mono text-3xl font-bold tabular-nums text-stone-900 dark:text-stone-50">
                  {stat.textTranslation.accuracyPct !== null
                    ? `${stat.textTranslation.accuracyPct}%`
                    : '—'}
                </p>
                <p className="mt-1 text-xs text-stone-600 dark:text-stone-400 tabular-nums">
                  {stat.textTranslation.correct} / {stat.textTranslation.totalRated} correct
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-stone-200/80 pt-2 text-[11px] text-stone-500 dark:border-emerald-950/70 dark:text-stone-400 tabular-nums">
                  <span>Unnatural: {stat.textTranslation.understandable}</span>
                  <span aria-hidden="true">·</span>
                  <span>Wrong: {stat.textTranslation.wrong}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Voice Test Accuracy Cards (Separate Transcript & Translation Scores) */}
        <div className="mt-7 border-t border-stone-100 pt-6 dark:border-emerald-950/70">
          <h3 className="mb-3 text-sm font-bold text-stone-800 dark:text-stone-200">
            Voice test accuracy (transcript vs. translation)
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-300">
                Overall voice scores
              </p>
              <div className="mt-3 space-y-2 tabular-nums">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-stone-600 dark:text-stone-300">Transcript:</span>
                  <span className="font-mono text-lg font-bold text-stone-900 dark:text-stone-50">
                    {overallVoiceTranscript.accuracyPct !== null
                      ? `${overallVoiceTranscript.accuracyPct}%`
                      : '—'}{' '}
                    <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                      ({overallVoiceTranscript.correct}/{overallVoiceTranscript.totalRated})
                    </span>
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-stone-600 dark:text-stone-300">Translation:</span>
                  <span className="font-mono text-lg font-bold text-stone-900 dark:text-stone-50">
                    {overallVoiceTranslation.accuracyPct !== null
                      ? `${overallVoiceTranslation.accuracyPct}%`
                      : '—'}{' '}
                    <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                      ({overallVoiceTranslation.correct}/{overallVoiceTranslation.totalRated})
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {perLanguage.map((stat) => (
              <div
                key={`voice-${stat.language}`}
                className="rounded-2xl border border-stone-200 bg-[#FAF9F5] p-4 dark:border-emerald-950/80 dark:bg-[#0D1310]"
              >
                <p className="text-xs font-semibold text-stone-600 dark:text-stone-300">
                  {stat.language} voice
                </p>
                <div className="mt-3 space-y-2 tabular-nums">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-stone-500 dark:text-stone-400">Transcript:</span>
                    <span className="font-mono text-lg font-bold text-stone-900 dark:text-stone-50">
                      {stat.voiceTranscript.accuracyPct !== null
                        ? `${stat.voiceTranscript.accuracyPct}%`
                        : '—'}{' '}
                      <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                        ({stat.voiceTranscript.correct}/{stat.voiceTranscript.totalRated})
                      </span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-stone-500 dark:text-stone-400">Translation:</span>
                    <span className="font-mono text-lg font-bold text-stone-900 dark:text-stone-50">
                      {stat.voiceTranslation.accuracyPct !== null
                        ? `${stat.voiceTranslation.accuracyPct}%`
                        : '—'}{' '}
                      <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                        ({stat.voiceTranslation.correct}/{stat.voiceTranslation.totalRated})
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {overallText.totalRated === 0 &&
          overallVoiceTranscript.totalRated === 0 &&
          overallVoiceTranslation.totalRated === 0 && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-[#FAF9F5] px-4 py-3 text-sm text-stone-700 dark:border-emerald-950/80 dark:bg-[#0D1310] dark:text-stone-300">
              <span>No test phrases (text or voice) have been rated yet.</span>
              <button
                type="button"
                onClick={onNavigateToTest}
                className="min-h-[36px] font-semibold text-emerald-800 underline underline-offset-4 hover:text-emerald-950 dark:text-amber-300"
              >
                Go to Test mode
              </button>
            </div>
          )}
      </section>

      {/* Saved Bad Translation Reports */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="border-b border-stone-100 pb-3 dark:border-emerald-950/70">
          <h3 className="text-lg font-bold text-stone-900 dark:text-stone-50">
            Saved bad translation reports ({reports.length})
          </h3>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            Corrections submitted from the main translator.
          </p>
        </div>

        {reports.length === 0 ? (
          <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
            No bad translation reports saved yet. Use “Report bad translation” on any result card to log a better phrasing.
          </p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-emerald-950/70">
            {reports.map((report) => (
              <li key={report.id} className="py-4 first:pt-3 last:pb-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                        {report.languagePair}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{report.domain}</span>
                      {report.model_used && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{report.model_used}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(report.timestamp).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-stone-800 dark:text-stone-200">
                      <span className="font-semibold text-stone-500 dark:text-stone-400">
                        Input:{' '}
                      </span>
                      {report.input}
                    </p>
                    <p className="text-stone-600 dark:text-stone-400">
                      <span className="font-semibold text-rose-700 dark:text-rose-400">
                        Model output:{' '}
                      </span>
                      {report.output}
                    </p>
                    <p className="font-medium text-emerald-900 dark:text-emerald-300">
                      <span className="font-semibold">Suggested fix: </span>
                      {report.suggestedFix}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onDeleteReport(report.id)}
                    aria-label="Delete report"
                    className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-stone-400 hover:bg-stone-100 hover:text-rose-700 dark:hover:bg-emerald-950/60 dark:hover:text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Native Speaker Better Versions from Text & Voice Test Mode */}
      {(testSuggestions.length > 0 || voiceSuggestions.length > 0) && (
        <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
          <div className="border-b border-stone-100 pb-3 dark:border-emerald-950/70">
            <h3 className="text-lg font-bold text-stone-900 dark:text-stone-50">
              Test mode native speaker corrections ({testSuggestions.length + voiceSuggestions.length})
            </h3>
          </div>
          <ul className="divide-y divide-stone-100 dark:divide-emerald-950/70">
            {testSuggestions.map(({ phrase, evaluation }) => (
              <li
                key={`txt-${evaluation.modelChoice ?? 'primary'}-${phrase.id}`}
                className="py-3.5 text-sm space-y-1"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                  <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                    Text · {phrase.sourceLanguage} → {phrase.targetLanguage}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{phrase.category}</span>
                  {evaluation.modelUsed && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{evaluation.modelUsed}</span>
                    </>
                  )}
                </div>
                <p className="text-stone-800 dark:text-stone-200">{phrase.phrase}</p>
                {evaluation.output && (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Model output: {evaluation.output}
                  </p>
                )}
                <p className="font-medium text-emerald-900 dark:text-emerald-300">
                  Better version: {evaluation.suggestedFix}
                </p>
              </li>
            ))}

            {voiceSuggestions.map(({ phrase, evaluation }) => (
              <li
                key={`vc-${evaluation.modelChoice ?? 'primary'}-${phrase.id}`}
                className="py-3.5 text-sm space-y-1"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                  <span className="font-semibold text-amber-800 dark:text-amber-300">
                    Voice · {phrase.sourceLanguage} → {phrase.targetLanguage}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{phrase.category}</span>
                  {evaluation.modelUsed && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{evaluation.modelUsed}</span>
                    </>
                  )}
                </div>
                <p className="text-stone-800 dark:text-stone-200">{phrase.phrase}</p>
                {evaluation.transcript && (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Transcript: {evaluation.transcript}
                  </p>
                )}
                {evaluation.suggestedTranscriptFix && (
                  <p className="font-medium text-amber-900 dark:text-amber-300">
                    Better transcript: {evaluation.suggestedTranscriptFix}
                  </p>
                )}
                {evaluation.output && (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Translation: {evaluation.output}
                  </p>
                )}
                {evaluation.suggestedTranslationFix && (
                  <p className="font-medium text-emerald-900 dark:text-emerald-300">
                    Better translation: {evaluation.suggestedTranslationFix}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
