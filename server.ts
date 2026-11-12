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

interface VoiceTranslationApiResult extends TranslationApiResult {
  transcript: string;
}

interface ParsedAudioTranscript {
  transcript: string;
  detected_language: string;
  noise_status: 'ok' | 'no_speech' | 'background_noise';
  notes: string;
}

interface CacheEntry {
  result: TranslationApiResult;
  expiresAt: number;
}

type ModelChoice = 'primary' | 'alternative' | 'fallback';

const VALID_TARGETS = new Set(['Auto', 'Luganda', 'Swahili', 'English']);
const VALID_DOMAINS = new Set(['General', 'Health', 'Market', 'School']);
const VALID_MODEL_CHOICES = new Set(['primary', 'alternative', 'fallback']);

const DEFAULT_PRIMARY_MODEL = 'gemma-4-26b-a4b-it';
const DEFAULT_ALTERNATIVE_MODEL = 'gemma-4-31b-it';
const DEFAULT_FALLBACK_MODEL = 'gemini-4-hydrogen';
const DEFAULT_AUDIO_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const; // 3 retries: 1s, 2s, 4s
const MODEL_REQUEST_TIMEOUT_MS = 25000; // Prevent hung model calls from stalling UI forever
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute short-lived cache
const MAX_CACHE_ENTRIES = 200;
const MAX_AUDIO_BASE64_BYTES = 12 * 1024 * 1024; // ~9MB raw audio ceiling for 30s clips

const translationCache = new Map<string, CacheEntry>();

const DEPRECATED_OR_INVALID_FLASH_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking',
]);

let customEndpointUnavailableForSession = false;

function hasUsableGeminiKey(): boolean {
  const key = (process.env.GEMINI_API_KEY ?? '').trim();
  return Boolean(key) && key !== 'MY_GEMINI_API_KEY';
}

function normalizeTextFallbackModel(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned || DEPRECATED_OR_INVALID_FLASH_MODELS.has(cleaned.toLowerCase())) {
    return DEFAULT_FALLBACK_MODEL;
  }
  return cleaned;
}

function normalizeAudioTranscribeModel(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned || DEPRECATED_OR_INVALID_FLASH_MODELS.has(cleaned.toLowerCase())) {
    return DEFAULT_AUDIO_TRANSCRIBE_MODEL;
  }
  return cleaned;
}

function getConfiguredModels(): {
  primaryModel: string;
  alternativeModel: string;
  fallbackModel: string;
  audioTranscribeModel: string;
} {
  const primaryModel =
    (process.env.PRIMARY_MODEL ?? '').trim() ||
    (process.env.MODEL_NAME ?? '').trim() ||
    DEFAULT_PRIMARY_MODEL;
  const alternativeModel =
    (process.env.ALTERNATIVE_MODEL ?? '').trim() || DEFAULT_ALTERNATIVE_MODEL;
  const fallbackModel = normalizeTextFallbackModel(process.env.FALLBACK_MODEL ?? '');
  const audioTranscribeModel = normalizeAudioTranscribeModel(
    process.env.AUDIO_TRANSCRIBE_MODEL ?? '',
  );

  return { primaryModel, alternativeModel, fallbackModel, audioTranscribeModel };
}

function resolveRequestedModel(choice: ModelChoice): string {
  const { primaryModel, alternativeModel, fallbackModel } = getConfiguredModels();
  if (choice === 'alternative') {
    return alternativeModel;
  }
  if (choice === 'fallback') {
    return fallbackModel;
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

const AUDIO_TRANSCRIBE_INSTRUCTION = `You are a speech transcription helper for East African speakers using Luganda, Swahili, or English.
Listen carefully to the audio and transcribe exactly what was spoken in its original language (Luganda, Swahili, or English). Keep names, numbers, and currency amounts (UGX, TZS, KES) intact.
- If the audio is silent or has no intelligible speech, set "transcript": "", "noise_status": "no_speech".
- If loud background noise prevents understanding the spoken words, set "transcript": "", "noise_status": "background_noise".
- Otherwise set "noise_status": "ok" and provide the accurate transcript and detected_language ("Luganda", "Swahili", or "English").
Return only valid JSON: {"transcript":"","detected_language":"","noise_status":"ok|no_speech|background_noise","notes":""}`;

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

function parseAudioTranscriptJson(rawText: string): ParsedAudioTranscript {
  const trimmed = rawText.trim();
  const jsonText = extractJsonObject(trimmed);

  // Support both JSON responses and plain-text responses from transcription models
  if (jsonText.startsWith('{') && jsonText.endsWith('}')) {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Transcription response JSON is not an object.');
    }

    const transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
    const detectedLanguage =
      typeof parsed.detected_language === 'string' ? parsed.detected_language.trim() : '';
    const notes = typeof parsed.notes === 'string' ? parsed.notes.trim() : '';
    const rawNoise =
      typeof parsed.noise_status === 'string' ? parsed.noise_status.trim().toLowerCase() : 'ok';

    if (rawNoise === 'no_speech' || (!transcript && /no speech|silent|silence/i.test(notes))) {
      const err = new Error('No speech detected in audio recording.');
      err.name = 'NO_SPEECH';
      throw err;
    }

    if (
      rawNoise === 'background_noise' ||
      (!transcript && /background noise|noisy|inaudible/i.test(notes))
    ) {
      const err = new Error('Background noise prevented clear transcription.');
      err.name = 'BACKGROUND_NOISE';
      throw err;
    }

    if (!transcript) {
      throw new Error('No speech transcript returned from audio transcription.');
    }

    return {
      transcript,
      detected_language: detectedLanguage || 'Unknown',
      noise_status: 'ok',
      notes,
    };
  }

  // Plain-text transcription fallback
  if (!trimmed || /^(\[?(no speech|silence|silent)\]?)$/i.test(trimmed)) {
    const err = new Error('No speech detected in audio recording.');
    err.name = 'NO_SPEECH';
    throw err;
  }
  if (/^(\[?(inaudible|background noise|noise)\]?)$/i.test(trimmed)) {
    const err = new Error('Background noise prevented clear transcription.');
    err.name = 'BACKGROUND_NOISE';
    throw err;
  }

  return {
    transcript: trimmed,
    detected_language: 'Unknown',
    noise_status: 'ok',
    notes: '',
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

function isRetryableOverloadError(err: unknown): boolean {
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

function isGemmaOrNonJsonModeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /json mode|response_mime_type|response_schema|developer instruction|system instruction|not enabled|not supported/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
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
  invoke: (modelName: string) => Promise<T>;
  onStatus?: (message: string) => void;
}): Promise<{
  data: T;
  modelUsed: string;
}> {
  let lastErr: unknown;

  // Attempt requested model: initial try + up to 3 retries (1s, 2s, 4s) on transient 503/429
  for (let retryIdx = 0; retryIdx <= RETRY_DELAYS_MS.length; retryIdx++) {
    try {
      const data = await withTimeout(
        params.invoke(params.modelName),
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

      if (
        isModelNotFoundError(err) ||
        !isRetryableOverloadError(err) ||
        retryIdx >= RETRY_DELAYS_MS.length
      ) {
        break;
      }

      const waitMs = RETRY_DELAYS_MS[retryIdx];
      params.onStatus?.('The translator is busy, trying again...');
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

async function callGenAiTextModel(userMessage: string, modelName: string): Promise<string> {
  const ai = getGeminiClient();
  const isGemma = modelName.toLowerCase().startsWith('gemma');

  if (isGemma) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: userMessage,
        config: {
          systemInstruction: SYSTEM_PROMPT,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error(`Empty response returned from ${modelName}.`);
      }
      return text;
    } catch (err) {
      if (isGemmaOrNonJsonModeError(err)) {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: `${SYSTEM_PROMPT}\n\n${userMessage}`,
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

  const lowerModel = modelName.toLowerCase();
  const supportsThinkingLevel =
    (lowerModel.startsWith('gemini-4') || lowerModel.startsWith('gemini-3')) &&
    !lowerModel.includes('transcribe');

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: userMessage,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        ...(supportsThinkingLevel ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
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
    if (isGemmaOrNonJsonModeError(err)) {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: userMessage,
        config: {
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

async function callGeminiAudioTranscribe(
  audioBase64: string,
  mimeType: string,
  domain: string,
  modelName: string,
): Promise<string> {
  const ai = getGeminiClient();
  const audioPart = {
    inlineData: {
      mimeType,
      data: audioBase64,
    },
  };

  // Specialized transcription models (e.g. gemini-3.5-transcribe) work best with direct multimodal parts
  if (modelName.toLowerCase().includes('transcribe')) {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          audioPart,
          {
            text: `Domain context: ${domain}. ${AUDIO_TRANSCRIBE_INSTRUCTION}`,
          },
        ],
      },
    });
    const text = response.text;
    if (!text) {
      throw new Error(`Empty transcription returned from ${modelName}.`);
    }
    return text;
  }

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          audioPart,
          {
            text: `Domain context: ${domain}. Transcribe this speech accurately in its original language (Luganda, Swahili, or English) and return only valid JSON.`,
          },
        ],
      },
      config: {
        systemInstruction: AUDIO_TRANSCRIBE_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: {
              type: Type.STRING,
              description: 'Exact transcript in the original spoken language.',
            },
            detected_language: {
              type: Type.STRING,
              description: 'Luganda, Swahili, or English.',
            },
            noise_status: {
              type: Type.STRING,
              description: 'ok, no_speech, or background_noise.',
            },
            notes: {
              type: Type.STRING,
              description: 'Optional notes about audio clarity.',
            },
          },
          required: ['transcript', 'detected_language', 'noise_status', 'notes'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error(`Empty transcription returned from ${modelName}.`);
    }
    return text;
  } catch (err) {
    if (isGemmaOrNonJsonModeError(err)) {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: {
          parts: [
            audioPart,
            {
              text: `Domain context: ${domain}. ${AUDIO_TRANSCRIBE_INSTRUCTION}`,
            },
          ],
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error(`Empty transcription returned from ${modelName}.`);
      }
      return text;
    }
    throw err;
  }
}

async function callCustomEndpoint(
  endpoint: string,
  modelName: string,
  userMessage: string,
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const customApiKey = process.env.MODEL_API_KEY;
  if (customApiKey) {
    headers['Authorization'] = `Bearer ${customApiKey}`;
  }

  const normalizedUrl = endpoint.trim();
  const isOllamaNativeChat = normalizedUrl.endsWith('/api/chat');
  const isOllamaGenerate = normalizedUrl.endsWith('/api/generate');

  let payload: Record<string, unknown>;
  if (isOllamaGenerate) {
    payload = {
      model: modelName,
      system: SYSTEM_PROMPT,
      prompt: userMessage,
      stream: false,
      format: 'json',
    };
  } else if (isOllamaNativeChat) {
    payload = {
      model: modelName,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    };
  } else {
    payload = {
      model: modelName,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    };
  }

  const res = await fetch(normalizedUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(
      `Model server returned HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  const data = (await res.json()) as Record<string, unknown>;
  return extractCustomEndpointText(data);
}

function extractCustomEndpointText(data: Record<string, unknown>): string {
  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const first = data.choices[0] as Record<string, unknown>;
    const msg = first.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.content === 'string') {
      return msg.content;
    }
    if (typeof first.text === 'string') {
      return first.text;
    }
  }

  if (typeof data.message === 'object' && data.message !== null) {
    const msg = data.message as Record<string, unknown>;
    if (typeof msg.content === 'string') {
      return msg.content;
    }
  }

  if (typeof data.response === 'string') {
    return data.response;
  }
  if (typeof data.text === 'string') {
    return data.text;
  }
  if (typeof data.translation === 'string') {
    return JSON.stringify(data);
  }

  throw new Error('Unrecognized response format from custom MODEL_ENDPOINT.');
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

  const customEndpoint = (process.env.MODEL_ENDPOINT ?? '').trim();
  const useCustomEndpoint =
    !customEndpointUnavailableForSession &&
    customEndpoint.length > 0 &&
    customEndpoint.toLowerCase() !== 'gemini' &&
    customEndpoint !== 'MY_MODEL_ENDPOINT';
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
      invoke: async (modelName) => {
        if (!useCustomEndpoint || customEndpointUnavailableForSession) {
          return callGenAiTextModel(userMessage + retryHint, modelName);
        }
        try {
          return await callCustomEndpoint(customEndpoint, modelName, userMessage + retryHint);
        } catch (customErr) {
          const details = extractApiErrorDetails(customErr);
          const isUnreachableOrMissing =
            isModelNotFoundError(customErr) ||
            /fetch failed|ECONNREFUSED|ENOTFOUND|Invalid URL|ERR_INVALID_URL/i.test(
              customErr instanceof Error ? customErr.message : String(customErr),
            );
          if (isUnreachableOrMissing && hasUsableGeminiKey()) {
            console.log(
              `[translate] CUSTOM_ENDPOINT_UNAVAILABLE model=${modelName} error_code=${details.errorCode} -> using @google/genai`,
            );
            customEndpointUnavailableForSession = true;
            return callGenAiTextModel(userMessage + retryHint, modelName);
          }
          throw customErr;
        }
      },
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

async function requestAudioTranscription(params: {
  audioBase64: string;
  mimeType: string;
  domain: string;
  onStatus?: (message: string) => void;
}): Promise<{ parsed: ParsedAudioTranscript; transcribeModel: string }> {
  const { audioTranscribeModel } = getConfiguredModels();

  let lastParseError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data: rawOutput, modelUsed } = await callWithResilience({
      operationName: 'transcribe-audio',
      modelName: audioTranscribeModel,
      onStatus: params.onStatus,
      invoke: (modelName) =>
        callGeminiAudioTranscribe(params.audioBase64, params.mimeType, params.domain, modelName),
    });

    try {
      const parsed = parseAudioTranscriptJson(rawOutput);
      console.log(
        `[transcribe-audio] model=${modelUsed} detected=${parsed.detected_language}`,
      );
      return { parsed, transcribeModel: modelUsed };
    } catch (err) {
      if (err instanceof Error && (err.name === 'NO_SPEECH' || err.name === 'BACKGROUND_NOISE')) {
        throw err;
      }
      lastParseError =
        err instanceof Error ? err : new Error('Invalid JSON returned by transcription model.');
      console.log(
        `[transcribe-audio] FAILED model=${modelUsed} error_code=INVALID_JSON attempt=${attempt} message="${lastParseError.message}"`,
      );
    }
  }

  throw new Error(
    `Audio transcription returned an unreadable format (${lastParseError?.message ?? 'invalid JSON'}). Please try again.`,
  );
}

async function requestVoiceModelTranslation(params: {
  audioBase64: string;
  mimeType: string;
  targetLanguage: string;
  domain: string;
  modelChoice: ModelChoice;
  onStatus?: (message: string) => void;
}): Promise<VoiceTranslationApiResult> {
  // Step 1: Transcribe audio using audio-capable Gemini model (Gemma 4 26B/31B do not accept audio)
  const { parsed: audioTranscript, transcribeModel } = await requestAudioTranscription({
    audioBase64: params.audioBase64,
    mimeType: params.mimeType,
    domain: params.domain,
    onStatus: params.onStatus,
  });

  // Step 2: Send transcript to the selected translation model
  const translated = await requestModelTranslation({
    text: audioTranscript.transcript,
    targetLanguage: params.targetLanguage,
    domain: params.domain,
    modelChoice: params.modelChoice,
    extraNotes: audioTranscript.notes,
    onStatus: params.onStatus,
  });

  console.log(
    `[translate-voice] transcribe=${transcribeModel} translate=${translated.model_used} pair=${translated.detected_language}->${translated.target_language}`,
  );

  return {
    transcript: audioTranscript.transcript,
    detected_language: translated.detected_language || audioTranscript.detected_language,
    target_language: translated.target_language,
    translation: translated.translation,
    confidence: translated.confidence,
    notes: translated.notes,
    model_used: translated.model_used,
  };
}

function classifyModelError(err: unknown): {
  status: number;
  code: string;
  error: string;
} {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : 'Unable to complete translation.';

  if (name === 'AUDIO_UNSUPPORTED') {
    return {
      status: 422,
      code: 'AUDIO_UNSUPPORTED',
      error: 'The configured model does not support audio input.',
    };
  }

  if (name === 'NO_SPEECH') {
    return {
      status: 422,
      code: 'NO_SPEECH',
      error: 'No speech was detected in your recording. Please try speaking clearly.',
    };
  }

  if (name === 'BACKGROUND_NOISE') {
    return {
      status: 422,
      code: 'BACKGROUND_NOISE',
      error: 'Too much background noise to understand clearly. Try again closer to the phone.',
    };
  }

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

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const endpoint = (process.env.MODEL_ENDPOINT ?? '').trim();
    const usingCustom =
      !customEndpointUnavailableForSession &&
      endpoint.length > 0 &&
      endpoint.toLowerCase() !== 'gemini' &&
      endpoint !== 'MY_MODEL_ENDPOINT';
    const models = getConfiguredModels();
    res.json({
      ok: true,
      provider: usingCustom ? 'custom' : 'gemini',
      hasGeminiKey: hasUsableGeminiKey(),
      primaryModel: models.primaryModel,
      alternativeModel: models.alternativeModel,
      fallbackModel: models.fallbackModel,
      audioTranscribeModel: models.audioTranscribeModel,
      examplesLoaded: startupExamples.length,
      cacheEntries: translationCache.size,
    });
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

  app.post('/api/translate-voice', async (req: Request, res: Response) => {
    let audioBase64 = '';
    const streamMode = wantsProgressStream(req);

    try {
      const body = req.body as Record<string, unknown> | undefined;
      audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';
      const rawMimeType =
        typeof body?.mimeType === 'string' && body.mimeType.trim()
          ? body.mimeType.trim()
          : 'audio/webm';
      const mimeType = rawMimeType.split(';')[0].trim() || 'audio/webm';
      const targetLanguage =
        typeof body?.targetLanguage === 'string' && VALID_TARGETS.has(body.targetLanguage)
          ? body.targetLanguage
          : 'Auto';
      const domain =
        typeof body?.domain === 'string' && VALID_DOMAINS.has(body.domain)
          ? body.domain
          : 'General';
      const modelChoice = parseModelChoice(body?.modelChoice);

      if (!audioBase64 || audioBase64.length < 200) {
        res.status(400).json({
          code: 'NO_SPEECH',
          error: 'No speech was captured in that recording. Please try speaking again.',
        });
        return;
      }

      if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        res.status(413).json({
          code: 'AUDIO_TOO_LARGE',
          error: 'Audio clip is too large. Please keep recordings under 30 seconds.',
        });
        return;
      }

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

      const result = await requestVoiceModelTranslation({
        audioBase64,
        mimeType,
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
      console.error('[translate-voice] failed:', err instanceof Error ? err.message : err);
      if (streamMode && res.headersSent) {
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
    } finally {
      // Do not retain audio in memory or store to disk after processing
      audioBase64 = '';
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
      `Mukwano-Rafiki server listening on http://localhost:${port} (primary=${models.primaryModel}, alternative=${models.alternativeModel}, fallback=${models.fallbackModel}, transcribe=${models.audioTranscribeModel})`,
    );
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
