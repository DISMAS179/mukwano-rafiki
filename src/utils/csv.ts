import type {
  BadReplyReport,
  BadTranslationReport,
  ChatTestCase,
  ChatTestEvaluation,
  ModelChoice,
  TestPhrase,
  TestPhraseEvaluation,
} from '../types';

import { DEFAULT_MODEL_CONFIG, type ServerHealthConfig } from './api';

function escapeCsvCell(value: string | undefined | null): string {
  const str = (value ?? '').replace(/\r?\n/g, ' ');
  if (str.includes('"') || str.includes(',') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function defaultModelLabelForChoice(
  choice?: ModelChoice | string,
  modelConfig: ServerHealthConfig = DEFAULT_MODEL_CONFIG,
): string {
  if (choice === 'secondary') return modelConfig.secondaryModel;
  return modelConfig.primaryModel;
}

export function buildCsvExport(params: {
  chatCases: ChatTestCase[];
  chatEvaluations: Record<string, ChatTestEvaluation>;
  badReplyReports: BadReplyReport[];
  phrases: TestPhrase[];
  evaluations: Record<string, TestPhraseEvaluation>;
  reports: BadTranslationReport[];
  modelConfig?: ServerHealthConfig;
}): string {
  const {
    chatCases,
    chatEvaluations,
    badReplyReports,
    phrases,
    evaluations,
    reports,
    modelConfig = DEFAULT_MODEL_CONFIG,
  } = params;

  const phraseMap = new Map<string, TestPhrase>(phrases.map((p) => [p.id, p]));
  const chatCaseMap = new Map<string, ChatTestCase>(chatCases.map((c) => [c.id, c]));

  const headers = [
    'record_type',
    'id',
    'timestamp',
    'model_name',
    'category',
    'domain',
    'source_language',
    'target_language',
    'language_pair',
    'input_text',
    'model_output',
    'translation_rating',
    'suggested_translation_fix',
    'confidence',
    'notes',
    'detected_emotion',
    'understood_me',
    'natural_language',
    'helpful_advice',
    'safe',
    'better_reply',
  ];

  const rows: string[][] = [headers];

  for (const chatEval of Object.values(chatEvaluations)) {
    if (
      !chatEval.reply &&
      !chatEval.understoodMe &&
      !chatEval.naturalLanguage &&
      !chatEval.helpfulAdvice &&
      !chatEval.safe &&
      !chatEval.betterReply
    ) {
      continue;
    }
    const testCase = chatCaseMap.get(chatEval.caseId);
    if (!testCase) continue;
    const modelName =
      chatEval.modelUsed || defaultModelLabelForChoice(chatEval.modelChoice, modelConfig);

    rows.push([
      'chatbot_test_rating',
      testCase.id,
      chatEval.updatedAt ?? '',
      modelName,
      testCase.caseType,
      'Chatbot',
      chatEval.detectedLanguage || testCase.languageHint,
      '',
      '',
      testCase.message,
      chatEval.reply ?? '',
      '',
      '',
      chatEval.confidence ?? '',
      chatEval.whyThisAdvice ?? '',
      chatEval.detectedEmotion ?? '',
      chatEval.understoodMe ?? '',
      chatEval.naturalLanguage ?? '',
      chatEval.helpfulAdvice ?? '',
      chatEval.safe ?? '',
      chatEval.betterReply ?? '',
    ]);
  }

  for (const badReply of badReplyReports) {
    rows.push([
      'bad_reply_report',
      badReply.id,
      badReply.timestamp,
      badReply.model_used ?? '',
      'Chat Report',
      'Chatbot',
      badReply.detectedLanguage,
      '',
      '',
      badReply.userMessage,
      badReply.botReply,
      '',
      '',
      '',
      '',
      badReply.detectedEmotion,
      'no',
      '',
      'no',
      '',
      badReply.suggestedBetterReply,
    ]);
  }

  for (const evalItem of Object.values(evaluations)) {
    if (!evalItem.output && !evalItem.rating && !evalItem.suggestedFix) continue;
    const phrase = phraseMap.get(evalItem.phraseId);
    if (!phrase) continue;

    const resolvedTarget = evalItem.resolvedTargetLanguage || phrase.targetLanguage;
    const pair = `${evalItem.detectedLanguage || phrase.sourceLanguage} -> ${resolvedTarget}`;
    const modelName =
      evalItem.modelUsed || defaultModelLabelForChoice(evalItem.modelChoice, modelConfig);

    rows.push([
      'text_test_rating',
      phrase.id,
      evalItem.updatedAt ?? '',
      modelName,
      phrase.category,
      phrase.domain,
      evalItem.detectedLanguage || phrase.sourceLanguage,
      resolvedTarget,
      pair,
      phrase.phrase,
      evalItem.output ?? '',
      evalItem.rating ?? '',
      evalItem.suggestedFix ?? '',
      evalItem.confidence ?? '',
      evalItem.notes ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  }

  for (const report of reports) {
    const parts = report.languagePair.split('→').map((s) => s.trim());
    rows.push([
      'bad_translation_report',
      report.id,
      report.timestamp,
      report.model_used ?? '',
      'User Report',
      report.domain,
      parts[0] ?? '',
      parts[1] ?? '',
      report.languagePair,
      report.input,
      report.output,
      'wrong',
      report.suggestedFix,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  }

  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
