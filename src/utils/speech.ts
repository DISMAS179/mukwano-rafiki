export interface SpeechRecognitionEventLike {
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
}

export interface SpeechRecognitionErrorEventLike {
  error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function pickSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return 'audio/webm';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = res.indexOf(',');
      if (commaIdx === -1) {
        reject(new Error('Could not read recorded audio data.'));
        return;
      }
      resolve(res.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read recorded audio.'));
    reader.readAsDataURL(blob);
  });
}

export function getBrowserSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as Record<string, unknown>;
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as SpeechRecognitionCtor) : null;
}

export function isWebSpeechSupported(): boolean {
  return getBrowserSpeechRecognitionCtor() !== null;
}

export function recognizeBrowserSpeech(langCode: 'en-US' | 'sw-KE'): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = getBrowserSpeechRecognitionCtor();
    if (!Ctor) {
      reject(new Error('Browser speech recognition is not available on this device.'));
      return;
    }

    const recognition = new Ctor();
    recognition.lang = langCode;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let finished = false;

    recognition.onresult = (event) => {
      if (finished) return;
      finished = true;
      const firstResult = event.results?.[0]?.[0]?.transcript?.trim() ?? '';
      if (!firstResult) {
        reject(new Error('No speech was detected. Please speak clearly and try again.'));
      } else {
        resolve(firstResult);
      }
    };

    recognition.onerror = (event) => {
      if (finished) return;
      finished = true;
      const code = event.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        reject(new Error('Microphone permission was denied. Please allow microphone access in your browser settings.'));
      } else if (code === 'no-speech') {
        reject(new Error('No speech was detected. Please speak clearly closer to the phone.'));
      } else if (code === 'audio-capture') {
        reject(new Error('No microphone was found on this device.'));
      } else if (code === 'network') {
        reject(new Error('Network error during browser speech recognition.'));
      } else {
        reject(new Error('Could not hear speech clearly. Try again closer to the phone.'));
      }
    };

    recognition.onend = () => {
      if (!finished) {
        finished = true;
        reject(new Error('No speech was detected. Please try again.'));
      }
    };

    try {
      recognition.start();
    } catch {
      if (!finished) {
        finished = true;
        reject(new Error('Could not start browser speech recognition.'));
      }
    }
  });
}

function languagePrefixesFor(languageName: string): string[] {
  const normalized = languageName.trim().toLowerCase();
  if (normalized === 'english') return ['en'];
  if (normalized === 'swahili' || normalized === 'kiswahili') return ['sw'];
  if (normalized === 'luganda') return ['lg', 'lug'];
  return [];
}

export function findTtsVoiceForLanguage(
  voices: SpeechSynthesisVoice[],
  languageName: string,
): SpeechSynthesisVoice | null {
  const prefixes = languagePrefixesFor(languageName);
  if (prefixes.length === 0 || voices.length === 0) return null;

  for (const prefix of prefixes) {
    const exactOrRegional = voices.find((v) => {
      const lang = v.lang.toLowerCase();
      return lang === prefix || lang.startsWith(`${prefix}-`) || lang.startsWith(`${prefix}_`);
    });
    if (exactOrRegional) return exactOrRegional;
  }
  return null;
}
