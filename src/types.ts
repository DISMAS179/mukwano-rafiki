export type LanguageName = 'Luganda' | 'Swahili' | 'English';
export type TargetLanguageOption = 'Auto' | LanguageName;
export type DomainOption = 'General' | 'Health' | 'Market' | 'School';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ModelChoice = 'primary' | 'alternative' | 'fallback';

export interface TranslationResponse {
  detected_language: string;
  target_language: string;
  translation: string;
  confidence: ConfidenceLevel;
  notes: string;
  model_used?: string;
}

export interface VoiceTranslationResponse extends TranslationResponse {
  transcript: string;
}

export interface HistoryItem {
  id: string;
  timestamp: string;
  input: string;
  domain: DomainOption;
  requestedTarget: TargetLanguageOption;
  detected_language: string;
  target_language: string;
  translation: string;
  confidence: ConfidenceLevel;
  notes: string;
  model_used?: string;
  sourceMode?: 'text' | 'voice';
}

export interface BadTranslationReport {
  id: string;
  timestamp: string;
  input: string;
  output: string;
  suggestedFix: string;
  languagePair: string;
  domain: DomainOption;
  model_used?: string;
}

export type TestCategory =
  | 'Greetings'
  | 'Market'
  | 'Health'
  | 'School'
  | 'Numbers & Money'
  | 'Idioms';

export interface TestPhrase {
  id: string;
  category: TestCategory;
  domain: DomainOption;
  sourceLanguage: LanguageName;
  targetLanguage: TargetLanguageOption;
  phrase: string;
  contextHint: string;
}

export type TestRatingValue = 'correct' | 'understandable' | 'wrong';

export interface TestPhraseEvaluation {
  phraseId: string;
  modelChoice?: ModelChoice;
  modelUsed?: string;
  output?: string;
  detectedLanguage?: string;
  resolvedTargetLanguage?: string;
  confidence?: ConfidenceLevel;
  notes?: string;
  rating?: TestRatingValue;
  suggestedFix?: string;
  updatedAt?: string;
}

export interface VoiceTestEvaluation {
  phraseId: string;
  modelChoice?: ModelChoice;
  modelUsed?: string;
  transcript?: string;
  output?: string;
  detectedLanguage?: string;
  resolvedTargetLanguage?: string;
  confidence?: ConfidenceLevel;
  notes?: string;
  transcriptRating?: TestRatingValue;
  translationRating?: TestRatingValue;
  suggestedTranscriptFix?: string;
  suggestedTranslationFix?: string;
  updatedAt?: string;
}

export type AppView = 'translate' | 'test' | 'results';
export type ThemeMode = 'light' | 'dark';
