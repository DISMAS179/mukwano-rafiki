import type {
  BadTranslationReport,
  ModelChoice,
  TestPhrase,
  TestPhraseEvaluation,
  VoiceTestEvaluation,
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
  choice?: ModelChoice,
  modelConfig: ServerHealthConfig = DEFAULT_MODEL_CONFIG,
): string {
  if (choice === 'alternative') return modelConfig.alternativeModel;
  if (choice === 'fallback') return modelConfig.fallbackModel;
  return modelConfig.primaryModel;
}

export function buildCsvExport(
  phrases: TestPhrase[],
  evaluations: Record<string, TestPhraseEvaluation>,
  voiceEvaluations: Record<string, VoiceTestEvaluation>,
  reports: BadTranslationReport[],
  modelConfig: ServerHealthConfig = DEFAULT_MODEL_CONFIG,
): string {
  const phraseMap = new Map<string, TestPhrase>(phrases.map((p) => [p.id, p]));

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
    'transcript',
    'transcript_rating',
    'suggested_transcript_fix',
    'model_output',
    'translation_rating',
    'suggested_translation_fix',
    'confidence',
    'notes',
  ];

  const rows: string[][] = [headers];

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
      '',
      '',
      '',
      evalItem.output ?? '',
      evalItem.rating ?? '',
      evalItem.suggestedFix ?? '',
      evalItem.confidence ?? '',
      evalItem.notes ?? '',
    ]);
  }

  for (const voiceItem of Object.values(voiceEvaluations)) {
    if (
      !voiceItem.transcript &&
      !voiceItem.output &&
      !voiceItem.transcriptRating &&
      !voiceItem.translationRating &&
      !voiceItem.suggestedTranscriptFix &&
      !voiceItem.suggestedTranslationFix
    ) {
      continue;
    }
    const phrase = phraseMap.get(voiceItem.phraseId);
    if (!phrase) continue;

    const resolvedTarget = voiceItem.resolvedTargetLanguage || phrase.targetLanguage;
    const pair = `${voiceItem.detectedLanguage || phrase.sourceLanguage} -> ${resolvedTarget}`;
    const modelName =
      voiceItem.modelUsed || defaultModelLabelForChoice(voiceItem.modelChoice, modelConfig);

    rows.push([
      'voice_test_rating',
      phrase.id,
      voiceItem.updatedAt ?? '',
      modelName,
      phrase.category,
      phrase.domain,
      voiceItem.detectedLanguage || phrase.sourceLanguage,
      resolvedTarget,
      pair,
      phrase.phrase,
      voiceItem.transcript ?? '',
      voiceItem.transcriptRating ?? '',
      voiceItem.suggestedTranscriptFix ?? '',
      voiceItem.output ?? '',
      voiceItem.translationRating ?? '',
      voiceItem.suggestedTranslationFix ?? '',
      voiceItem.confidence ?? '',
      voiceItem.notes ?? '',
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
      '',
      '',
      '',
      report.output,
      'wrong',
      report.suggestedFix,
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
