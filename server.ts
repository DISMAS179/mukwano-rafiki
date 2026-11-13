import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExampleEntry {
  id?: string;
  status?: string;
  verified?: boolean;
  domain?: string;
  input: string;
  detected_language: string;
  target_language: string;
  translation: string;
  confidence: string;
  notes: string;
}

interface ParsedTranslation {
  detected_language: string;
  target_language: string;
  translation: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

interface TranslationApiResult extends ParsedTranslation {
  model_used: string;
}

interface ParsedChatReply {
  reply: string;
  detected_language: string;
  detected_emotion: string;
  why_this_advice: string;
  suggestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface ChatApiResult extends ParsedChatReply {
  model_used: string;
}

interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface ChatProfileInput {
  name?: string;
  preferredLanguage?: string;
  ageGroup?: string;
  interest?: string;
}

interface CacheEntry {
  result: TranslationApiResult;
  expiresAt: number;
}

type ModelChoice = 'primary' | 'secondary';

const VALID_TARGETS = new Set(['Auto', 'Luganda', 'Swahili', 'English']);
const VALID_DOMAINS = new Set(['General', 'Health', 'Market', 'School']);
const VALID_MODEL_CHOICES = new Set(['primary', 'secondary']);

const DEFAULT_PRIMARY_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_SECONDARY_MODEL = 'gemini-4-hydrogen';

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const; // 3 retries: 1s, 2s, 4s
const MODEL_REQUEST_TIMEOUT_MS = 45000; // Abort stalled model calls cleanly after 45s
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute short-lived cache
const MAX_CACHE_ENTRIES = 200;

const translationCache = new Map<string, CacheEntry>();

const DEPRECATED_OR_INVALID_GEMINI_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
]);

function hasUsableGeminiKey(): boolean {
  const key = (process.env.GEMINI_API_KEY ?? '').trim();
  return Boolean(key) && key !== 'MY_GEMINI_API_KEY';
}

function normalizeGeminiTextModel(raw: string, fallbackModel: string): string {
  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();
  if (!cleaned || !lower.startsWith('gemini-') || DEPRECATED_OR_INVALID_GEMINI_MODELS.has(lower)) {
    return fallbackModel;
  }
  return lower;
}

function getConfiguredModels(): {
  primaryModel: string;
  secondaryModel: string;
} {
  const primaryModel = normalizeGeminiTextModel(
    (process.env.PRIMARY_MODEL ?? '').trim() || (process.env.MODEL_NAME ?? '').trim(),
    DEFAULT_PRIMARY_MODEL,
  );
  const secondaryModel = normalizeGeminiTextModel(
    (process.env.SECONDARY_MODEL ?? '').trim(),
    DEFAULT_SECONDARY_MODEL,
  );

  return { primaryModel, secondaryModel };
}

function resolveRequestedModel(choice: ModelChoice): string {
  const { primaryModel, secondaryModel } = getConfiguredModels();
  if (choice === 'secondary') {
    return secondaryModel;
  }
  return primaryModel;
}

function getCacheKey(
  modelChoice: ModelChoice,
  text: string,
  targetLanguage: string,
  domain: string,
): string {
  return `${modelChoice}::${targetLanguage}::${domain}::${text.trim()}`;
}

function getCachedTranslation(key: string): TranslationApiResult | null {
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    translationCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedTranslation(key: string, result: TranslationApiResult): void {
  if (translationCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of translationCache.entries()) {
      if (now > v.expiresAt) {
        translationCache.delete(k);
      }
    }
    if (translationCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = translationCache.keys().next().value;
      if (oldestKey) translationCache.delete(oldestKey);
    }
  }

  translationCache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function loadExamplesAtStartup(): ExampleEntry[] {
  const examplesPath = path.join(__dirname, 'examples.json');
  try {
    const raw = fs.readFileSync(examplesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    console.warn('examples.json did not contain an array; using empty examples list.');
    return [];
  } catch (err) {
    console.warn(
      'Could not load examples.json at startup:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

const startupExamples = loadExamplesAtStartup();

function buildSystemPrompt(examples: ExampleEntry[]): string {
  const formattedExamples = JSON.stringify(
    examples.map((ex) => ({
      domain: ex.domain ?? 'General',
      status: ex.status ?? (ex.verified ? 'verified' : 'unverified'),
      input: ex.input,
      output: {
        detected_language: ex.detected_language,
        target_language: ex.target_language,
        translation: ex.translation,
        confidence: ex.confidence,
        notes: ex.notes,
      },
    })),
  );

  return `You are a translation helper for Luganda, Swahili, and English.
TASK: Detect the input language. If a target language is given, translate into it. If not: English goes to Luganda; Luganda or Swahili goes to English. Preserve meaning, tone, and politeness level, including respect forms such as 'Shikamoo' in Swahili. Use the given domain context (General, Health, Market, School) to choose vocabulary.
RULES: Translate naturally, like a native speaker, not word for word. Keep names, numbers, amounts (e.g. UGX, TZS, KES), and places unchanged. If a phrase is slang, idiomatic, or ambiguous, choose the most likely meaning and note the alternative. If you are not confident, say so and set confidence to low. Never invent words. Use standard Swahili unless told otherwise.
OUTPUT: Return only valid JSON: {"detected_language":"","target_language":"","translation":"","confidence":"high|medium|low","notes":""}
EXAMPLES: ${formattedExamples}`;
}

const SYSTEM_PROMPT = buildSystemPrompt(startupExamples);

const CHATBOT_SYSTEM_PROMPT = `You are Mukwano-Rafiki, a warm, respectful chatbot for people in East Africa. You understand Luganda, Swahili and English, including mixed language, slang and spelling mistakes. Reply in the user's language, in short, clear, natural sentences. Use the user's profile (name, language, age group, interest) to personalize examples and advice. Read the user's emotion and respond with empathy before giving advice. Give practical, step-by-step suggestions that fit local life. Ask one clarifying question if the message is unclear. For health, give general information only and recommend a clinic for anything serious; for emergencies tell the user to get urgent help. Never diagnose, never invent facts, and say when you are unsure.

ADDITIONAL SAFETY & QUALITY RULES:
- Emergency signs (severe chest pain, difficulty breathing, heavy bleeding, thoughts of self-harm): urgently tell the user to seek immediate medical/emergency help right away.
- Distress / self-harm risk: respond kindly, encourage talking to someone they trust or a local helpline/health worker, and never give harmful instructions.
- Money & business: give general guidance only, with no guarantees and no pushing risky financial products.
- Follow-up context: use the recent conversation history so follow-up questions make sense.
- "why_this_advice": explain in 1 or 2 short sentences what the advice is based on (e.g. user's profile/interest, local context, or general safety guidelines).
- "suggestions": provide 2 or 3 short natural follow-up phrases the user can tap next (written in the language of your reply).
Return JSON: {"reply":"","detected_language":"","detected_emotion":"","why_this_advice":"","suggestions":["","",""],"confidence":"high|medium|low"}`;

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const str = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (str === 'high' || str === 'medium' || str === 'low') {
    return str;
  }
  return 'medium';
}

function extractJsonObject(rawText: string): string {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }
  return candidate;
}

function parseModelJson(rawText: string): ParsedTranslation {
  const jsonText = extractJsonObject(rawText);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.translation !== 'string' ||
    parsed.translation.trim().length === 0 ||
    typeof parsed.detected_language !== 'string' ||
    typeof parsed.target_language !== 'string'
  ) {
    throw new Error('Model response JSON is missing required translation fields.');
  }

  return {
    detected_language: parsed.detected_language.trim(),
    target_language: parsed.target_language.trim(),
    translation: parsed.translation.trim(),
    confidence: normalizeConfidence(parsed.confidence),
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
  };
}

function parseChatJson(rawText: string): ParsedChatReply {
  const jsonText = extractJsonObject(rawText);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.reply !== 'string' ||
    parsed.reply.trim().length === 0
  ) {
    throw new Error('Chatbot response JSON is missing required reply text.');
  }

  const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const suggestions = rawSuggestions
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 3);

  return {
    reply: parsed.reply.trim(),
    detected_language:
      typeof parsed.detected_language === 'string' && parsed.detected_language.trim()
        ? parsed.detected_language.trim()
        : 'English',
    detected_emotion:
      typeof parsed.detected_emotion === 'string' && parsed.detected_emotion.trim()
        ? parsed.detected_emotion.trim()
        : 'neutral',
    why_this_advice:
      typeof parsed.why_this_advice === 'string' ? parsed.why_this_advice.trim() : '',
    suggestions,
    confidence: normalizeConfidence(parsed.confidence),
  };
}

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

function getErrorStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (typeof rec.status === 'number') return rec.status;
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    if (typeof rec.code === 'number') return rec.code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const jsonCodeMatch = msg.match(/"code"\s*:\s*(\d{3})\b/);
  if (jsonCodeMatch) {
    return Number(jsonCodeMatch[1]);
  }
  return null;
}

function isAuthOrKeyError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 401 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /GEMINI_API_KEY/i.test(msg) ||
    /API_KEY_INVALID/i.test(msg) ||
    /PERMISSION_DENIED/i.test(msg) ||
    /UNAUTHENTICATED/i.test(msg)
  );
}

function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  return name === 'MODEL_TIMEOUT' || /timed out|timeout/i.test(msg);
}

function isModelNotFoundError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(msg) || /NOT_FOUND/i.test(msg) || /not found/i.test(msg);
}

function isDailyQuotaExceededError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/GenerateRequestsPerDay|RequestsPerDay|per day limit exceeded/i.test(msg)) {
    return true;
  }
  const retryMatch = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (retryMatch && Number(retryMatch[1]) > 60) {
    return true;
  }
  return false;
}

function isRetryableOverloadError(err: unknown): boolean {
  if (isDailyQuotaExceededError(err)) return false;

  const status = getErrorStatus(err);
  if (status === 503 || status === 429) return true;

  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b503\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /UNAVAILABLE/i.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /high demand/i.test(msg) ||
    /overloaded/i.test(msg) ||
    /too many requests/i.test(msg)
  );
}

function isNonJsonModeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /json mode|response_mime_type|response_schema|developer instruction|system instruction|not enabled|not supported/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  fn: (abortSignal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`);
          err.name = 'MODEL_TIMEOUT';
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractApiErrorDetails(err: unknown): {
  httpStatus: number | null;
  errorCode: string;
  shortMessage: string;
} {
  const httpStatus = getErrorStatus(err);
  const rawMsg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  let errorCode = '';
  const statusJsonMatch = rawMsg.match(/"status"\s*:\s*"([A-Z0-9_]+)"/);
  const reasonJsonMatch = rawMsg.match(/"reason"\s*:\s*"([A-Z0-9_]+)"/);
  if (statusJsonMatch) {
    errorCode = statusJsonMatch[1];
  } else if (reasonJsonMatch) {
    errorCode = reasonJsonMatch[1];
  } else if (name && name !== 'Error') {
    errorCode = name;
  } else if (isModelNotFoundError(err)) {
    errorCode = 'NOT_FOUND';
  } else if (isTimeoutError(err)) {
    errorCode = 'MODEL_TIMEOUT';
  } else if (/RESOURCE_EXHAUSTED|\b429\b/i.test(rawMsg)) {
    errorCode = 'RESOURCE_EXHAUSTED';
  } else if (/UNAVAILABLE|\b503\b|high demand|overloaded/i.test(rawMsg)) {
    errorCode = 'UNAVAILABLE';
  } else if (httpStatus !== null) {
    errorCode = `HTTP_${httpStatus}`;
  } else {
    errorCode = 'UNKNOWN_ERROR';
  }

  let shortMessage = rawMsg;
  const msgMatch = rawMsg.match(/"message"\s*:\s*"([^"]+)"/);
  if (msgMatch) {
    shortMessage = msgMatch[1];
  }

  return {
    httpStatus,
    errorCode,
    shortMessage: shortMessage.replace(/\s+/g, ' ').trim().slice(0, 220),
  };
}

async function callWithResilience<T>(params: {
  operationName: string;
  modelName: string;
  invoke: (modelName: string, abortSignal: AbortSignal) => Promise<T>;
  onStatus?: (message: string) => void;
}): Promise<{
  data: T;
  modelUsed: string;
}> {
  let lastErr: unknown;

  // Attempt requested model: initial try + up to 3 retries (1s, 2s, 4s) on timeout, 503, or transient 429
  for (let retryIdx = 0; retryIdx <= RETRY_DELAYS_MS.length; retryIdx++) {
    try {
      const data = await withTimeout(
        (abortSignal) => params.invoke(params.modelName, abortSignal),
        MODEL_REQUEST_TIMEOUT_MS,
        params.modelName,
      );
      return { data, modelUsed: params.modelName };
    } catch (err) {
      lastErr = err;
      const details = extractApiErrorDetails(err);
      console.log(
        `[${params.operationName}] FAILED model=${params.modelName} http_status=${details.httpStatus ?? 'none'} error_code=${details.errorCode} attempt=${retryIdx + 1} message="${details.shortMessage}"`,
      );

      const isRetryable =
        !isDailyQuotaExceededError(err) &&
        (isTimeoutError(err) || isRetryableOverloadError(err));
      if (isModelNotFoundError(err) || !isRetryable || retryIdx >= RETRY_DELAYS_MS.length) {
        break;
      }

      const waitMs = RETRY_DELAYS_MS[retryIdx];
      params.onStatus?.('The translator is busy, trying again...');
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

function getThinkingConfigForModel(modelName: string): { thinkingLevel: ThinkingLevel } | undefined {
  const lower = modelName.toLowerCase();
  if (lower.includes('flash-lite')) {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }
  if (lower.startsWith('gemini-4') || lower.startsWith('gemini-3')) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  return undefined;
}

async function callGenAiTextModel(
  userMessage: string,
  modelName: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const ai = getGeminiClient();
  const thinkingConfig = getThinkingConfigForModel(modelName);

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: userMessage,
      config: {
        ...(abortSignal ? { abortSignal } : {}),
        systemInstruction: SYSTEM_PROMPT,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            detected_language: {
              type: Type.STRING,
              description: 'Detected source language: Luganda, Swahili, or English.',
            },
            target_language: {
              type: Type.STRING,
              description: 'Target language translated into: Luganda, Swahili, or English.',
            },
            translation: {
              type: Type.STRING,
              description:
                'Natural translation preserving tone, politeness, numbers, names, and currency amounts.',
            },
            confidence: {
              type: Type.STRING,
              description: 'Confidence level: high, medium, or low.',
            },
            notes: {
              type: Type.STRING,
              description: 'Ambiguity notes, alternative meanings, or politeness context.',
            },
          },
          required: ['detected_language', 'target_language', 'translation', 'confidence', 'notes'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error(`Empty response returned from ${modelName}.`);
    }
    return text;
  } catch (err) {
    if (!abortSignal?.aborted && isNonJsonModeError(err)) {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: userMessage,
        config: {
          ...(abortSignal ? { abortSignal } : {}),
          systemInstruction: SYSTEM_PROMPT,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error(`Empty response returned from ${modelName}.`);
      }
      return text;
    }
    throw err;
  }
}

async function callGenAiChatModel(
  userPrompt: string,
  modelName: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const ai = getGeminiClient();
  const thinkingConfig = getThinkingConfigForModel(modelName);

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        ...(abortSignal ? { abortSignal } : {}),
        systemInstruction: CHATBOT_SYSTEM_PROMPT,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: {
              type: Type.STRING,
              description: 'Warm, empathetic, clear reply in the user’s language.',
            },
            detected_language: {
              type: Type.STRING,
              description: 'Language(s) detected, e.g. Luganda, Swahili, English, or Mixed.',
            },
            detected_emotion: {
              type: Type.STRING,
              description: 'Emotion detected, e.g. worried, stressed, frustrated, happy, calm.',
            },
            why_this_advice: {
              type: Type.STRING,
              description: '1-2 short sentences explaining what this advice is based on.',
            },
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 or 3 short follow-up prompt suggestions in the reply language.',
            },
            confidence: {
              type: Type.STRING,
              description: 'high, medium, or low.',
            },
          },
          required: [
            'reply',
            'detected_language',
            'detected_emotion',
            'why_this_advice',
            'suggestions',
            'confidence',
          ],
        },
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error(`Empty response returned from ${modelName}.`);
    }
    return text;
  } catch (err) {
    if (!abortSignal?.aborted && isNonJsonModeError(err)) {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: userPrompt,
        config: {
          ...(abortSignal ? { abortSignal } : {}),
          systemInstruction: CHATBOT_SYSTEM_PROMPT,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error(`Empty response returned from ${modelName}.`);
      }
      return text;
    }
    throw err;
  }
}

async function requestModelTranslation(params: {
  text: string;
  targetLanguage: string;
  domain: string;
  modelChoice: ModelChoice;
  extraNotes?: string;
  onStatus?: (message: string) => void;
}): Promise<TranslationApiResult> {
  const { text, targetLanguage, domain, modelChoice, extraNotes, onStatus } = params;

  const cacheKey = getCacheKey(modelChoice, text, targetLanguage, domain);
  if (!extraNotes) {
    const cached = getCachedTranslation(cacheKey);
    if (cached) {
      console.log(
        `[translate] cache=hit model=${cached.model_used} pair=${cached.detected_language}->${cached.target_language}`,
      );
      return cached;
    }
  }

  const requestedModel = resolveRequestedModel(modelChoice);

  const targetInstruction =
    targetLanguage === 'Auto'
      ? 'Auto (English -> Luganda; Luganda or Swahili -> English)'
      : targetLanguage;

  const userMessage = [
    `Domain context: ${domain}`,
    `Target language: ${targetInstruction}`,
    `Input text: ${text}`,
    'Return only valid JSON matching {"detected_language":"","target_language":"","translation":"","confidence":"high|medium|low","notes":""}.',
  ].join('\n');

  let lastParseError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint =
      attempt === 2
        ? '\nIMPORTANT: Your previous response was not valid JSON. Output ONLY a single raw JSON object with no extra text.'
        : '';

    const { data: rawOutput, modelUsed } = await callWithResilience({
      operationName: 'translate',
      modelName: requestedModel,
      onStatus,
      invoke: (modelName, abortSignal) =>
        callGenAiTextModel(userMessage + retryHint, modelName, abortSignal),
    });

    try {
      const parsed = parseModelJson(rawOutput);
      const sameLanguageUnderAuto =
        targetLanguage === 'Auto' &&
        parsed.detected_language.trim().toLowerCase() ===
          parsed.target_language.trim().toLowerCase();

      if (sameLanguageUnderAuto) {
        const resolvedAutoTarget =
          parsed.detected_language.trim().toLowerCase() === 'english' ? 'Luganda' : 'English';
        console.log(
          `[translate] AUTO_TARGET_RETRY detected=${parsed.detected_language} got=${parsed.target_language} -> retrying with target=${resolvedAutoTarget}`,
        );
        const resolvedResult = await requestModelTranslation({
          text,
          targetLanguage: resolvedAutoTarget,
          domain,
          modelChoice,
          extraNotes,
          onStatus,
        });
        if (!extraNotes) {
          setCachedTranslation(cacheKey, resolvedResult);
        }
        return resolvedResult;
      }

      const mergedNotes = [parsed.notes, extraNotes].filter(Boolean).join(' ').trim();
      const result: TranslationApiResult = {
        ...parsed,
        notes: mergedNotes,
        model_used: modelUsed,
      };
      if (!extraNotes) {
        setCachedTranslation(cacheKey, result);
      }
      console.log(
        `[translate] cache=miss model=${modelUsed} pair=${result.detected_language}->${result.target_language}`,
      );
      return result;
    } catch (err) {
      lastParseError = err instanceof Error ? err : new Error('Invalid JSON returned by model.');
      console.log(
        `[translate] FAILED model=${modelUsed} error_code=INVALID_JSON attempt=${attempt} message="${lastParseError.message}"`,
      );
    }
  }

  throw new Error(
    `Translation model returned an unreadable format after retrying (${lastParseError?.message ?? 'invalid JSON'}). Please try again.`,
  );
}

function sanitizeHistoryTurns(raw: unknown): ChatHistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: ChatHistoryTurn[] = [];
  for (const item of raw.slice(-12)) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const role = rec.role === 'assistant' ? 'assistant' : rec.role === 'user' ? 'user' : null;
    const text = typeof rec.text === 'string' ? rec.text.trim().slice(0, 1200) : '';
    if (role && text) {
      cleaned.push({ role, text });
    }
  }
  return cleaned;
}

function sanitizeProfile(raw: unknown): ChatProfileInput {
  if (typeof raw !== 'object' || raw === null) return {};
  const rec = raw as Record<string, unknown>;
  return {
    name: typeof rec.name === 'string' ? rec.name.trim().slice(0, 60) : '',
    preferredLanguage:
      typeof rec.preferredLanguage === 'string' ? rec.preferredLanguage.trim().slice(0, 40) : '',
    ageGroup: typeof rec.ageGroup === 'string' ? rec.ageGroup.trim().slice(0, 40) : '',
    interest: typeof rec.interest === 'string' ? rec.interest.trim().slice(0, 40) : '',
  };
}

async function requestChatReply(params: {
  message: string;
  history: ChatHistoryTurn[];
  profile: ChatProfileInput;
  modelChoice: ModelChoice;
  onStatus?: (message: string) => void;
}): Promise<ChatApiResult> {
  const { message, history, profile, modelChoice, onStatus } = params;
  const requestedModel = resolveRequestedModel(modelChoice);

  const profileLines = [
    profile.name ? `Name: ${profile.name}` : 'Name: not shared',
    profile.preferredLanguage
      ? `Preferred language: ${profile.preferredLanguage}`
      : 'Preferred language: match user message',
    profile.ageGroup ? `Age group: ${profile.ageGroup}` : 'Age group: not shared',
    profile.interest ? `Main interest: ${profile.interest}` : 'Main interest: General',
  ];

  const historyBlock =
    history.length > 0
      ? history
          .map((turn) => `${turn.role === 'user' ? 'User' : 'Mukwano-Rafiki'}: ${turn.text}`)
          .join('\n')
      : 'No prior messages in this conversation.';

  const userPrompt = [
    'USER PROFILE (use only to personalize tone, reading level, and East African examples):',
    profileLines.join(' | '),
    '',
    'RECENT CONVERSATION HISTORY:',
    historyBlock,
    '',
    'CURRENT USER MESSAGE:',
    message,
    '',
    'Reply in valid JSON matching {"reply":"","detected_language":"","detected_emotion":"","why_this_advice":"","suggestions":["","",""],"confidence":"high|medium|low"}.',
  ].join('\n');

  let lastParseError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryHint =
      attempt === 2
        ? '\nIMPORTANT: Your previous response was not valid JSON. Output ONLY a single raw JSON object matching the schema.'
        : '';

    const { data: rawOutput, modelUsed } = await callWithResilience({
      operationName: 'chat',
      modelName: requestedModel,
      onStatus,
      invoke: (modelName, abortSignal) =>
        callGenAiChatModel(userPrompt + retryHint, modelName, abortSignal),
    });

    try {
      const parsed = parseChatJson(rawOutput);
      console.log(
        `[chat] model=${modelUsed} lang=${parsed.detected_language} emotion=${parsed.detected_emotion}`,
      );
      return {
        ...parsed,
        model_used: modelUsed,
      };
    } catch (err) {
      lastParseError = err instanceof Error ? err : new Error('Invalid JSON returned by model.');
      console.log(
        `[chat] FAILED model=${modelUsed} error_code=INVALID_JSON attempt=${attempt} message="${lastParseError.message}"`,
      );
    }
  }

  throw new Error(
    `Chatbot returned an unreadable format after retrying (${lastParseError?.message ?? 'invalid JSON'}). Please try again.`,
  );
}

function classifyModelError(err: unknown): {
  status: number;
  code: string;
  error: string;
} {
  const message = err instanceof Error ? err.message : 'Unable to complete translation.';

  if (message.includes('GEMINI_API_KEY')) {
    return {
      status: 503,
      code: 'MISSING_KEY',
      error: 'Server translation key is not configured yet. Please check Settings > Secrets.',
    };
  }

  if (isAuthOrKeyError(err)) {
    return {
      status: 502,
      code: 'AUTH_FAILED',
      error: 'Translation service authentication failed. Please verify the configured API key.',
    };
  }

  if (isDailyQuotaExceededError(err)) {
    return {
      status: 429,
      code: 'QUOTA_EXCEEDED',
      error:
        'Daily free-tier request limit reached for this Gemini model. Please try again later, switch models in Test mode, or attach a billed API key in Settings > Secrets.',
    };
  }

  if (isTimeoutError(err) || isRetryableOverloadError(err)) {
    return {
      status: 503,
      code: 'HIGH_DEMAND',
      error: 'The translator is busy, please try again.',
    };
  }

  if (isModelNotFoundError(err)) {
    return {
      status: 502,
      code: 'MODEL_NOT_FOUND',
      error: 'The translator is temporarily unavailable. Please try again.',
    };
  }

  if (message.includes('unreadable format') || message.includes('JSON')) {
    return {
      status: 502,
      code: 'INVALID_FORMAT',
      error: 'The translator returned an unexpected response. Please try again.',
    };
  }

  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    return {
      status: 502,
      code: 'ENDPOINT_UNREACHABLE',
      error: 'Could not reach the translation server. Please try again.',
    };
  }

  return {
    status: 500,
    code: 'TRANSLATION_FAILED',
    error: 'The translator is busy, please try again.',
  };
}

function wantsProgressStream(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('application/x-ndjson') || req.query.progress === '1';
}

function parseModelChoice(raw: unknown): ModelChoice {
  if (typeof raw === 'string' && VALID_MODEL_CHOICES.has(raw)) {
    return raw as ModelChoice;
  }
  return 'primary';
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const models = getConfiguredModels();
    res.json({
      ok: true,
      provider: 'gemini',
      hasGeminiKey: hasUsableGeminiKey(),
      primaryModel: models.primaryModel,
      secondaryModel: models.secondaryModel,
      examplesLoaded: startupExamples.length,
      cacheEntries: translationCache.size,
    });
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = sanitizeHistoryTurns(body?.history);
    const profile = sanitizeProfile(body?.profile);
    const modelChoice = parseModelChoice(body?.modelChoice);

    if (!message) {
      res.status(400).json({ error: 'Please write a message first.' });
      return;
    }

    if (message.length > 2000) {
      res.status(400).json({
        error: 'Message is too long. Please keep messages under 2,000 characters.',
      });
      return;
    }

    const streamMode = wantsProgressStream(req);
    if (streamMode) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders?.();
    }

    const emitStatus = (msg: string) => {
      if (streamMode && !res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'status', message: msg })}\n`);
      }
    };

    try {
      const result = await requestChatReply({
        message,
        history,
        profile,
        modelChoice,
        onStatus: emitStatus,
      });
      if (streamMode) {
        res.write(`${JSON.stringify({ type: 'result', data: result })}\n`);
        res.end();
      } else {
        res.json(result);
      }
    } catch (err) {
      const classified = classifyModelError(err);
      console.error('[chat] failed:', err instanceof Error ? err.message : err);
      if (streamMode) {
        res.write(
          `${JSON.stringify({
            type: 'error',
            status: classified.status,
            code: classified.code,
            error: classified.error,
          })}\n`,
        );
        res.end();
      } else {
        res.status(classified.status).json({ code: classified.code, error: classified.error });
      }
    }
  });

  app.post('/api/translate', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const targetLanguage =
      typeof body?.targetLanguage === 'string' && VALID_TARGETS.has(body.targetLanguage)
        ? body.targetLanguage
        : 'Auto';
    const domain =
      typeof body?.domain === 'string' && VALID_DOMAINS.has(body.domain)
        ? body.domain
        : 'General';
    const modelChoice = parseModelChoice(body?.modelChoice);

    if (!text) {
      res.status(400).json({ error: 'Please enter some text to translate.' });
      return;
    }

    if (text.length > 2000) {
      res.status(400).json({
        error: 'Text is too long. Please keep inputs under 2,000 characters.',
      });
      return;
    }

    const streamMode = wantsProgressStream(req);
    if (streamMode) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders?.();
    }

    const emitStatus = (message: string) => {
      if (streamMode && !res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'status', message })}\n`);
      }
    };

    try {
      const result = await requestModelTranslation({
        text,
        targetLanguage,
        domain,
        modelChoice,
        onStatus: emitStatus,
      });
      if (streamMode) {
        res.write(`${JSON.stringify({ type: 'result', data: result })}\n`);
        res.end();
      } else {
        res.json(result);
      }
    } catch (err) {
      const classified = classifyModelError(err);
      console.error('[translate] failed:', err instanceof Error ? err.message : err);
      if (streamMode) {
        res.write(
          `${JSON.stringify({
            type: 'error',
            status: classified.status,
            code: classified.code,
            error: classified.error,
          })}\n`,
        );
        res.end();
      } else {
        res.status(classified.status).json({ code: classified.code, error: classified.error });
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    const models = getConfiguredModels();
    console.log(
      `Mukwano-Rafiki server listening on http://localhost:${port} (primary=${models.primaryModel}, secondary=${models.secondaryModel})`,
    );
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
