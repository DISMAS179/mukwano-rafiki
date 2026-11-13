import type {
  ChatResponse,
  DomainOption,
  ModelChoice,
  TargetLanguageOption,
  TranslationResponse,
  UserProfile,
} from '../types';

export type ApiErrorCode =
  | 'HIGH_DEMAND'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'MODEL_NOT_FOUND'
  | 'NETWORK'
  | 'UNKNOWN';

export interface ServerHealthConfig {
  primaryModel: string;
  secondaryModel: string;
}

export const DEFAULT_MODEL_CONFIG: ServerHealthConfig = {
  primaryModel: 'gemini-3.1-flash-lite',
  secondaryModel: 'gemini-4-hydrogen',
};

export const TEST_MODE_REQUEST_DELAY_MS = 500;

export class TranslationApiError extends Error {
  code: ApiErrorCode;

  constructor(message: string, code: ApiErrorCode = 'UNKNOWN') {
    super(message);
    this.name = 'TranslationApiError';
    this.code = code;
  }
}

function mapCode(rawCode: string): ApiErrorCode {
  if (rawCode === 'HIGH_DEMAND' || rawCode === 'RATE_LIMITED') return 'HIGH_DEMAND';
  if (rawCode === 'QUOTA_EXCEEDED') return 'QUOTA_EXCEEDED';
  if (rawCode === 'TIMEOUT') return 'TIMEOUT';
  if (rawCode === 'MODEL_NOT_FOUND') return 'MODEL_NOT_FOUND';
  if (rawCode === 'ENDPOINT_UNREACHABLE') return 'NETWORK';
  return 'UNKNOWN';
}

function parseNdjsonLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Throw a user-friendly API error below
  }
  throw new TranslationApiError(
    'Received an incomplete or malformed response from the server. Please try again.',
    'UNKNOWN',
  );
}

async function readNdjsonOrJsonResponse<T>(
  response: Response,
  onStatus?: (message: string) => void,
): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/x-ndjson') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: T | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line) {
          const parsed = parseNdjsonLine(line);
          if (parsed.type === 'status' && typeof parsed.message === 'string') {
            onStatus?.(parsed.message);
          } else if (parsed.type === 'result') {
            finalResult = parsed.data as T;
          } else if (parsed.type === 'error') {
            const rawCode = typeof parsed.code === 'string' ? parsed.code : '';
            const errMsg =
              typeof parsed.error === 'string'
                ? parsed.error
                : 'The request could not be completed right now. Please try again.';
            throw new TranslationApiError(errMsg, mapCode(rawCode));
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }

    if (buffer.trim()) {
      const parsed = parseNdjsonLine(buffer.trim());
      if (parsed.type === 'result') {
        finalResult = parsed.data as T;
      } else if (parsed.type === 'error') {
        const rawCode = typeof parsed.code === 'string' ? parsed.code : '';
        const errMsg =
          typeof parsed.error === 'string'
            ? parsed.error
            : 'The request could not be completed right now. Please try again.';
        throw new TranslationApiError(errMsg, mapCode(rawCode));
      }
    }

    if (finalResult !== null) {
      return finalResult;
    }

    throw new TranslationApiError(
      'Server response ended unexpectedly. Please try again.',
      'UNKNOWN',
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TranslationApiError(
      `Server returned an unexpected response (HTTP ${response.status}). Please try again.`,
      'UNKNOWN',
    );
  }

  if (!response.ok) {
    const obj =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const rawCode = typeof obj.code === 'string' ? obj.code : '';
    const errMsg =
      typeof obj.error === 'string'
        ? obj.error
        : `Request failed (HTTP ${response.status}). Please try again.`;
    throw new TranslationApiError(errMsg, mapCode(rawCode));
  }

  return data as T;
}

export async function fetchHealthConfig(): Promise<ServerHealthConfig> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return DEFAULT_MODEL_CONFIG;
    const data = (await res.json()) as Partial<ServerHealthConfig>;
    return {
      primaryModel: data.primaryModel || DEFAULT_MODEL_CONFIG.primaryModel,
      secondaryModel: data.secondaryModel || DEFAULT_MODEL_CONFIG.secondaryModel,
    };
  } catch {
    return DEFAULT_MODEL_CONFIG;
  }
}

export async function sendChatMessage(params: {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  profile?: Partial<UserProfile>;
  modelChoice?: ModelChoice;
  onStatus?: (message: string) => void;
}): Promise<ChatResponse> {
  const { onStatus, ...payload } = params;

  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new TranslationApiError(
      'Unable to reach the server. Check your internet connection and try again.',
      'NETWORK',
    );
  }

  return readNdjsonOrJsonResponse<ChatResponse>(response, onStatus);
}

export async function translateText(params: {
  text: string;
  targetLanguage: TargetLanguageOption;
  domain: DomainOption;
  modelChoice?: ModelChoice;
  onStatus?: (message: string) => void;
}): Promise<TranslationResponse> {
  const { onStatus, ...payload } = params;

  let response: Response;
  try {
    response = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new TranslationApiError(
      'Unable to reach the translation server. Check your internet connection and try again.',
      'NETWORK',
    );
  }

  return readNdjsonOrJsonResponse<TranslationResponse>(response, onStatus);
}
