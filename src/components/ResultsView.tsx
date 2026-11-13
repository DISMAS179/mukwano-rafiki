import { useMemo } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { CHAT_TEST_CASES } from '../data/chatTestCases';
import { TEST_PHRASES } from '../data/testPhrases';
import type {
  BadReplyReport,
  BadTranslationReport,
  ChatCriterionRating,
  ChatTestEvaluation,
  LanguageName,
  ModelChoice,
  TestPhraseEvaluation,
} from '../types';
import { DEFAULT_MODEL_CONFIG, type ServerHealthConfig } from '../utils/api';
import { buildCsvExport, downloadCsv } from '../utils/csv';

interface ResultsViewProps {
  chatEvaluations: Record<string, ChatTestEvaluation>;
  badReplyReports: BadReplyReport[];
  evaluations: Record<string, TestPhraseEvaluation>;
  reports: BadTranslationReport[];
  modelConfig?: ServerHealthConfig;
  onDeleteBadReplyReport: (id: string) => void;
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

interface ChatCriterionBucket {
  yes: number;
  partly: number;
  no: number;
  totalRated: number;
  yesPct: number | null;
}

interface LanguageStats {
  language: LanguageName;
  textTranslation: ScoreBucket;
}

interface ModelComparisonRow {
  choice: ModelChoice;
  label: string;
  modelId: string;
  overall: ScoreBucket;
  byLanguage: Record<LanguageName, ScoreBucket>;
  chatUnderstood: ChatCriterionBucket;
  chatSafe: ChatCriterionBucket;
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

function emptyChatBucket(): ChatCriterionBucket {
  return {
    yes: 0,
    partly: 0,
    no: 0,
    totalRated: 0,
    yesPct: null,
  };
}

function recordScore(bucket: ScoreBucket, rating: string | undefined) {
  if (!rating) return;
  bucket.totalRated += 1;
  if (rating === 'correct') bucket.correct += 1;
  else if (rating === 'understandable') bucket.understandable += 1;
  else if (rating === 'wrong') bucket.wrong += 1;
}

function recordChatCriterion(
  bucket: ChatCriterionBucket,
  rating: ChatCriterionRating | undefined,
) {
  if (!rating) return;
  bucket.totalRated += 1;
  if (rating === 'yes') bucket.yes += 1;
  else if (rating === 'partly') bucket.partly += 1;
  else if (rating === 'no') bucket.no += 1;
}

function finalizeBucket(bucket: ScoreBucket): ScoreBucket {
  return {
    ...bucket,
    accuracyPct:
      bucket.totalRated > 0 ? Math.round((bucket.correct / bucket.totalRated) * 100) : null,
  };
}

function finalizeChatBucket(bucket: ChatCriterionBucket): ChatCriterionBucket {
  return {
    ...bucket,
    yesPct: bucket.totalRated > 0 ? Math.round((bucket.yes / bucket.totalRated) * 100) : null,
  };
}

function formatScoreCell(bucket: ScoreBucket): string {
  if (bucket.totalRated === 0 || bucket.accuracyPct === null) return '—';
  return `${bucket.accuracyPct}% (${bucket.correct}/${bucket.totalRated})`;
}

function formatChatCell(bucket: ChatCriterionBucket): string {
  if (bucket.totalRated === 0 || bucket.yesPct === null) return '—';
  return `${bucket.yesPct}% (${bucket.yes}/${bucket.totalRated})`;
}

export function ResultsView({
  chatEvaluations,
  badReplyReports,
  evaluations,
  reports,
  modelConfig = DEFAULT_MODEL_CONFIG,
  onDeleteBadReplyReport,
  onDeleteReport,
  onNavigateToTest,
}: ResultsViewProps) {
  const phraseMap = useMemo(() => new Map(TEST_PHRASES.map((p) => [p.id, p])), []);
  const chatCaseMap = useMemo(() => new Map(CHAT_TEST_CASES.map((c) => [c.id, c])), []);

  const modelMeta = useMemo<Array<{ choice: ModelChoice; label: string; modelId: string }>>(
    () => [
      { choice: 'primary', label: 'Gemini Primary', modelId: modelConfig.primaryModel },
      { choice: 'secondary', label: 'Gemini Secondary', modelId: modelConfig.secondaryModel },
    ],
    [modelConfig],
  );

  const {
    perLanguage,
    overallText,
    modelComparison,
    chatCriteriaOverall,
    totalChatRatedScenarios,
  } = useMemo(() => {
    const map: Record<LanguageName, LanguageStats> = {
      Luganda: {
        language: 'Luganda',
        textTranslation: emptyBucket(),
      },
      Swahili: {
        language: 'Swahili',
        textTranslation: emptyBucket(),
      },
      English: {
        language: 'English',
        textTranslation: emptyBucket(),
      },
    };

    const modelBuckets: Record<
      ModelChoice,
      {
        overall: ScoreBucket;
        byLanguage: Record<LanguageName, ScoreBucket>;
        chatUnderstood: ChatCriterionBucket;
        chatSafe: ChatCriterionBucket;
      }
    > = {
      primary: {
        overall: emptyBucket(),
        byLanguage: {
          Luganda: emptyBucket(),
          Swahili: emptyBucket(),
          English: emptyBucket(),
        },
        chatUnderstood: emptyChatBucket(),
        chatSafe: emptyChatBucket(),
      },
      secondary: {
        overall: emptyBucket(),
        byLanguage: {
          Luganda: emptyBucket(),
          Swahili: emptyBucket(),
          English: emptyBucket(),
        },
        chatUnderstood: emptyChatBucket(),
        chatSafe: emptyChatBucket(),
      },
    };

    const chatBuckets = {
      understoodMe: emptyChatBucket(),
      naturalLanguage: emptyChatBucket(),
      helpfulAdvice: emptyChatBucket(),
      safe: emptyChatBucket(),
    };
    let ratedChatCount = 0;

    for (const chatEv of Object.values(chatEvaluations)) {
      const testCase = chatCaseMap.get(chatEv.caseId);
      if (!testCase) continue;
      if (
        chatEv.understoodMe ||
        chatEv.naturalLanguage ||
        chatEv.helpfulAdvice ||
        chatEv.safe
      ) {
        ratedChatCount += 1;
      }
      recordChatCriterion(chatBuckets.understoodMe, chatEv.understoodMe);
      recordChatCriterion(chatBuckets.naturalLanguage, chatEv.naturalLanguage);
      recordChatCriterion(chatBuckets.helpfulAdvice, chatEv.helpfulAdvice);
      recordChatCriterion(chatBuckets.safe, chatEv.safe);

      const choice: ModelChoice = chatEv.modelChoice === 'secondary' ? 'secondary' : 'primary';
      recordChatCriterion(modelBuckets[choice].chatUnderstood, chatEv.understoodMe);
      recordChatCriterion(modelBuckets[choice].chatSafe, chatEv.safe);
    }

    for (const textEv of Object.values(evaluations)) {
      if (!textEv.rating) continue;
      const phrase = phraseMap.get(textEv.phraseId);
      if (!phrase) continue;

      recordScore(map[phrase.sourceLanguage].textTranslation, textEv.rating);

      const choice: ModelChoice | null =
        textEv.modelChoice === 'secondary'
          ? 'secondary'
          : !textEv.modelChoice || textEv.modelChoice === 'primary'
            ? 'primary'
            : null;
      if (choice) {
        recordScore(modelBuckets[choice].overall, textEv.rating);
        recordScore(modelBuckets[choice].byLanguage[phrase.sourceLanguage], textEv.rating);
      }
    }

    const list = LANGUAGES.map((lang) => ({
      language: lang,
      textTranslation: finalizeBucket(map[lang].textTranslation),
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
      byLanguage: {
        Luganda: finalizeBucket(modelBuckets[meta.choice].byLanguage.Luganda),
        Swahili: finalizeBucket(modelBuckets[meta.choice].byLanguage.Swahili),
        English: finalizeBucket(modelBuckets[meta.choice].byLanguage.English),
      },
      chatUnderstood: finalizeChatBucket(modelBuckets[meta.choice].chatUnderstood),
      chatSafe: finalizeChatBucket(modelBuckets[meta.choice].chatSafe),
    }));

    return {
      perLanguage: list,
      overallText: sumBuckets((s) => s.textTranslation),
      modelComparison: comparisonRows,
      chatCriteriaOverall: {
        understoodMe: finalizeChatBucket(chatBuckets.understoodMe),
        naturalLanguage: finalizeChatBucket(chatBuckets.naturalLanguage),
        helpfulAdvice: finalizeChatBucket(chatBuckets.helpfulAdvice),
        safe: finalizeChatBucket(chatBuckets.safe),
      },
      totalChatRatedScenarios: ratedChatCount,
    };
  }, [chatEvaluations, evaluations, phraseMap, chatCaseMap, modelMeta]);

  const chatBetterReplies = useMemo(() => {
    return Object.values(chatEvaluations)
      .filter((ev) => Boolean(ev.betterReply && ev.betterReply.trim().length > 0))
      .map((ev) => ({
        testCase: chatCaseMap.get(ev.caseId),
        evaluation: ev,
      }))
      .filter(
        (item): item is { testCase: NonNullable<typeof item.testCase>; evaluation: ChatTestEvaluation } =>
          Boolean(item.testCase),
      );
  }, [chatEvaluations, chatCaseMap]);

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

  const hasExportableData =
    totalChatRatedScenarios > 0 ||
    badReplyReports.length > 0 ||
    Object.values(chatEvaluations).some((ev) => Boolean(ev.reply || ev.betterReply)) ||
    overallText.totalRated > 0 ||
    reports.length > 0 ||
    Object.values(evaluations).some((ev) => Boolean(ev.output || ev.suggestedFix));

  function handleExportCsv() {
    const csv = buildCsvExport({
      chatCases: CHAT_TEST_CASES,
      chatEvaluations,
      badReplyReports,
      phrases: TEST_PHRASES,
      evaluations,
      reports,
      modelConfig,
    });
    const dateStamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`mukwano-rafiki-feedback-${dateStamp}.csv`, csv);
  }

  const chatCriteriaCards = [
    { key: 'understoodMe', title: 'Understood me', bucket: chatCriteriaOverall.understoodMe },
    { key: 'naturalLanguage', title: 'Natural language', bucket: chatCriteriaOverall.naturalLanguage },
    { key: 'helpfulAdvice', title: 'Helpful advice', bucket: chatCriteriaOverall.helpfulAdvice },
    { key: 'safe', title: 'Safe', bucket: chatCriteriaOverall.safe },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Header & CSV Export */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-stone-900 dark:text-stone-50">
              Quality &amp; Feedback Results
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              Chatbot evaluation scores ({' '}
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Yes ÷ Total rated
              </span>{' '}
              ) alongside Translator accuracy across models and languages.
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

        {/* Chatbot Quality Scores */}
        <div className="mt-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold text-stone-800 dark:text-stone-200">
              Chatbot test quality scores
            </h3>
            <span className="text-xs text-stone-500 dark:text-stone-400 tabular-nums">
              {totalChatRatedScenarios} scenario evaluation{totalChatRatedScenarios === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {chatCriteriaCards.map((item) => (
              <div
                key={item.key}
                className={`rounded-2xl border p-4 ${
                  item.key === 'safe'
                    ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/70 dark:bg-emerald-950/30'
                    : 'border-stone-200 bg-[#FAF9F5] dark:border-emerald-950/80 dark:bg-[#0D1310]'
                }`}
              >
                <p className="text-xs font-semibold text-stone-700 dark:text-stone-200">
                  {item.title}
                </p>
                <p className="mt-2 font-mono text-3xl font-bold tabular-nums text-stone-900 dark:text-stone-50">
                  {item.bucket.yesPct !== null ? `${item.bucket.yesPct}%` : '—'}
                </p>
                <p className="mt-1 text-xs text-stone-600 dark:text-stone-400 tabular-nums">
                  {item.bucket.yes} / {item.bucket.totalRated} rated Yes
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-stone-200/80 pt-2 text-[11px] text-stone-500 dark:border-emerald-950/70 dark:text-stone-400 tabular-nums">
                  <span>Partly: {item.bucket.partly}</span>
                  <span aria-hidden="true">·</span>
                  <span>No: {item.bucket.no}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Accuracy Per Model & Per Language Comparison */}
        <div className="mt-7 border-t border-stone-100 pt-6 dark:border-emerald-950/70">
          <h3 className="mb-3 text-sm font-bold text-stone-800 dark:text-stone-200">
            Model comparison (chatbot &amp; translator)
          </h3>
          <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-emerald-950/80">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-[#FAF9F5] text-xs font-semibold text-stone-600 dark:border-emerald-950/80 dark:bg-[#0D1310] dark:text-stone-300">
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Chat understood</th>
                  <th className="px-4 py-3">Chat safe</th>
                  <th className="px-4 py-3">Text translation</th>
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
                      {formatChatCell(row.chatUnderstood)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-emerald-900 dark:text-emerald-300">
                      {formatChatCell(row.chatSafe)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-stone-800 dark:text-stone-200">
                      {formatScoreCell(row.overall)}
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
            Translator text accuracy
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

        {totalChatRatedScenarios === 0 && overallText.totalRated === 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-[#FAF9F5] px-4 py-3 text-sm text-stone-700 dark:border-emerald-950/80 dark:bg-[#0D1310] dark:text-stone-300">
            <span>No chatbot scenarios or translator phrases have been rated yet.</span>
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

      {/* Saved Bad Reply Reports from Chat */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="border-b border-stone-100 pb-3 dark:border-emerald-950/70">
          <h3 className="text-lg font-bold text-stone-900 dark:text-stone-50">
            Saved bad reply reports ({badReplyReports.length})
          </h3>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            Feedback submitted directly from the Mukwano-Rafiki chatbot.
          </p>
        </div>

        {badReplyReports.length === 0 ? (
          <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
            No bad reply reports saved yet. Use “Report bad reply” under any assistant bubble in Chat to log what would have helped more.
          </p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-emerald-950/70">
            {badReplyReports.map((item) => (
              <li key={item.id} className="py-4 first:pt-3 last:pb-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                      <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                        {item.detectedLanguage || 'Mixed'}
                      </span>
                      {item.detectedEmotion && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Tone: {item.detectedEmotion}</span>
                        </>
                      )}
                      {item.model_used && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{item.model_used}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(item.timestamp).toLocaleDateString()}
                      </span>
                    </div>
                    {item.userMessage && (
                      <p className="text-stone-800 dark:text-stone-200">
                        <span className="font-semibold text-stone-500 dark:text-stone-400">
                          User:{' '}
                        </span>
                        {item.userMessage}
                      </p>
                    )}
                    <p className="text-stone-600 dark:text-stone-400">
                      <span className="font-semibold text-rose-700 dark:text-rose-400">
                        Chatbot reply:{' '}
                      </span>
                      {item.botReply}
                    </p>
                    <p className="font-medium text-emerald-900 dark:text-emerald-300">
                      <span className="font-semibold">Suggested better reply: </span>
                      {item.suggestedBetterReply}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onDeleteBadReplyReport(item.id)}
                    aria-label="Delete bad reply report"
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

      {/* Saved Bad Translation Reports */}
      <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
        <div className="border-b border-stone-100 pb-3 dark:border-emerald-950/70">
          <h3 className="text-lg font-bold text-stone-900 dark:text-stone-50">
            Saved bad translation reports ({reports.length})
          </h3>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            Corrections submitted from the Translator tab.
          </p>
        </div>

        {reports.length === 0 ? (
          <p className="py-6 text-sm text-stone-500 dark:text-stone-400">
            No bad translation reports saved yet. Use “Report bad translation” on any translator result card to log a better phrasing.
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

      {/* Native Speaker Better Versions from Test Mode */}
      {(chatBetterReplies.length > 0 || testSuggestions.length > 0) && (
        <section className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6">
          <div className="border-b border-stone-100 pb-3 dark:border-emerald-950/70">
            <h3 className="text-lg font-bold text-stone-900 dark:text-stone-50">
              Test mode native speaker corrections (
              {chatBetterReplies.length + testSuggestions.length})
            </h3>
          </div>
          <ul className="divide-y divide-stone-100 dark:divide-emerald-950/70">
            {chatBetterReplies.map(({ testCase, evaluation }) => (
              <li
                key={`chat-${evaluation.modelChoice ?? 'primary'}-${testCase.id}`}
                className="space-y-1 py-3.5 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                  <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                    Chatbot · {testCase.caseType}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{testCase.languageHint}</span>
                  {evaluation.modelUsed && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{evaluation.modelUsed}</span>
                    </>
                  )}
                </div>
                <p className="text-stone-800 dark:text-stone-200">{testCase.message}</p>
                {evaluation.reply && (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Chatbot reply: {evaluation.reply}
                  </p>
                )}
                <p className="font-medium text-emerald-900 dark:text-emerald-300">
                  Better reply: {evaluation.betterReply}
                </p>
              </li>
            ))}

            {testSuggestions.map(({ phrase, evaluation }) => (
              <li
                key={`txt-${evaluation.modelChoice ?? 'primary'}-${phrase.id}`}
                className="space-y-1 py-3.5 text-sm"
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
          </ul>
        </section>
      )}
    </div>
  );
}
