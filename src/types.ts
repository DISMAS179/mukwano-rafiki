export type LanguageName = 'Luganda' | 'Swahili' | 'English';
export type TargetLanguageOption = 'Auto' | LanguageName;
export type DomainOption = 'General' | 'Health' | 'Market' | 'School';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ModelChoice = 'primary' | 'secondary';

export type ProfileInterest = 'Health' | 'School' | 'Farming' | 'Business/Money';
export type ProfileAgeGroup =
  | 'Youth (Under 18)'
  | 'Young adult (18–30)'
  | 'Adult (31–55)'
  | 'Elder (55+)';

export interface UserProfile {
  name: string;
  preferredLanguage: '' | LanguageName;
  ageGroup: '' | ProfileAgeGroup;
  interest: '' | ProfileInterest;
  onboarded: boolean;
}

export interface ChatResponse {
  reply: string;
  detected_language: string;
  detected_emotion: string;
  why_this_advice: string;
  suggestions: string[];
  confidence: ConfidenceLevel;
  model_used?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  detected_language?: string;
  detected_emotion?: string;
  why_this_advice?: string;
  suggestions?: string[];
  confidence?: ConfidenceLevel;
  model_used?: string;
}

export interface BadReplyReport {
  id: string;
  timestamp: string;
  userMessage: string;
  botReply: string;
  suggestedBetterReply: string;
  detectedLanguage: string;
  detectedEmotion: string;
  model_used?: string;
}

export interface TranslationResponse {
  detected_language: string;
  target_language: string;
  translation: string;
  confidence: ConfidenceLevel;
  notes: string;
  model_used?: string;
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

export type ChatCaseType =
  | 'Mixed Language'
  | 'Emotional'
  | 'Unclear'
  | 'Health & Safety'
  | 'Farming'
  | 'School'
  | 'Business & Money'
  | 'Follow-up Context';

export interface ChatTestCase {
  id: string;
  caseType: ChatCaseType;
  languageHint: string;
  priorTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  sampleProfile?: Partial<UserProfile>;
  message: string;
  contextHint: string;
}

export type ChatCriterionRating = 'yes' | 'partly' | 'no';

export interface ChatTestEvaluation {
  caseId: string;
  modelChoice?: ModelChoice;
  modelUsed?: string;
  reply?: string;
  detectedLanguage?: string;
  detectedEmotion?: string;
  whyThisAdvice?: string;
  suggestions?: string[];
  confidence?: ConfidenceLevel;
  understoodMe?: ChatCriterionRating;
  naturalLanguage?: ChatCriterionRating;
  helpfulAdvice?: ChatCriterionRating;
  safe?: ChatCriterionRating;
  betterReply?: string;
  updatedAt?: string;
}

export type AppView = 'chat' | 'translate' | 'test' | 'results';
export type ThemeMode = 'light' | 'dark';
