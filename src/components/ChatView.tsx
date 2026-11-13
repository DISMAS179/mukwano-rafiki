import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Eraser,
  Flag,
  HelpCircle,
  Languages,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  BadReplyReport,
  ChatMessage,
  LanguageName,
  ProfileAgeGroup,
  ProfileInterest,
  UserProfile,
} from '../types';
import { sendChatMessage } from '../utils/api';

interface ChatViewProps {
  profile: UserProfile;
  messages: ChatMessage[];
  onSaveProfile: (profile: UserProfile) => void;
  onAddMessages: (newMessages: ChatMessage[]) => void;
  onNewConversation: () => void;
  onClearPersonalData: () => void;
  onSubmitBadReplyReport: (report: BadReplyReport) => void;
  onTranslateReply: (text: string) => void;
  onNavigateToResults: () => void;
}

const LANGUAGE_OPTIONS: Array<{ value: '' | LanguageName; label: string }> = [
  { value: '', label: 'Match what I type' },
  { value: 'Luganda', label: 'Luganda' },
  { value: 'Swahili', label: 'Swahili' },
  { value: 'English', label: 'English' },
];

const AGE_GROUPS: Array<{ value: ProfileAgeGroup; label: string }> = [
  { value: 'Youth (Under 18)', label: 'Under 18' },
  { value: 'Young adult (18–30)', label: '18–30' },
  { value: 'Adult (31–55)', label: '31–55' },
  { value: 'Elder (55+)', label: '55+' },
];

const INTEREST_OPTIONS: Array<{ value: ProfileInterest; label: string }> = [
  { value: 'Health', label: 'Health' },
  { value: 'School', label: 'School' },
  { value: 'Farming', label: 'Farming' },
  { value: 'Business/Money', label: 'Business / Money' },
];

const STARTERS_BY_INTEREST: Record<string, Array<{ label: string; text: string }>> = {
  Health: [
    {
      label: 'Mixed health worry',
      text: 'Nina headache since jana na nina work leo ku market.',
    },
    {
      label: 'Child fever (Luganda)',
      text: 'Omwana wange alina omusujja okuva akawungeezi, nkole ki?',
    },
    {
      label: 'Feeling stressed',
      text: 'Nimechoka sana na akili yangu ina wasiwasi mwingi siku hizi.',
    },
  ],
  School: [
    {
      label: 'Math exam stress',
      text: 'Ssebo nina exam enkya naye simanyi how to revisa maths bulungi.',
    },
    {
      label: 'Remembering notes (Swahili)',
      text: 'Nasoma lakini nasahau haraka nikifika kwenye mtihani.',
    },
    {
      label: 'Study schedule',
      text: 'How can I make a simple evening study timetable at home?',
    },
  ],
  Farming: [
    {
      label: 'Yellowing maize (Luganda)',
      text: 'Ebikoola bya kasooli wange bitandise okukyuka kyenvu, kyandiba ki?',
    },
    {
      label: 'Dry season watering',
      text: 'Msimu wa jua kali umefika, nitunzeje mboga zangu za wiki?',
    },
    {
      label: 'Storing harvest',
      text: 'What are safe ways to store dried beans without weevils?',
    },
  ],
  'Business/Money': [
    {
      label: 'Slow market week (Swahili)',
      text: 'Bana biashara iko down sana hii wiki, customers hawana pesa.',
    },
    {
      label: 'Tracking daily profit',
      text: 'Ntunda matooke naye buli wiiki ssente zibulawo. Nkole ntya?',
    },
    {
      label: 'Saving safely',
      text: 'How can I separate household spending from my stall capital?',
    },
  ],
  Default: [
    {
      label: 'Mixed Luganda/Swahili',
      text: 'Nina headache since jana na nina work leo ku market.',
    },
    {
      label: 'Market business (Swahili)',
      text: 'Bana biashara iko down sana hii wiki, customers hawana pesa.',
    },
    {
      label: 'Study tip (Luganda)',
      text: 'Ssebo nina exam enkya naye simanyi how to revisa maths bulungi.',
    },
  ],
};


export function ChatView({
  profile,
  messages,
  onSaveProfile,
  onAddMessages,
  onNewConversation,
  onClearPersonalData,
  onSubmitBadReplyReport,
  onTranslateReply,
  onNavigateToResults,
}: ChatViewProps) {
  const [editingProfile, setEditingProfile] = useState(!profile.onboarded);
  const [draftName, setDraftName] = useState(profile.name);
  const [draftLang, setDraftLang] = useState<'' | LanguageName>(profile.preferredLanguage);
  const [draftAge, setDraftAge] = useState<'' | ProfileAgeGroup>(profile.ageGroup);
  const [draftInterest, setDraftInterest] = useState<'' | ProfileInterest>(profile.interest);

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLabel, setStatusLabel] = useState('Thinking…');
  const [error, setError] = useState<string | null>(null);
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);
  const [confirmClearData, setConfirmClearData] = useState(false);

  // Per-message expanded UI state
  const [openWhyIds, setOpenWhyIds] = useState<Record<string, boolean>>({});
  const [reportingMsgId, setReportingMsgId] = useState<string | null>(null);
  const [betterReplyDraft, setBetterReplyDraft] = useState('');
  const [reportedSavedId, setReportedSavedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Sync draft form whenever stored profile changes (e.g. after Clear my data)
  useEffect(() => {
    setDraftName(profile.name);
    setDraftLang(profile.preferredLanguage);
    setDraftAge(profile.ageGroup);
    setDraftInterest(profile.interest);
    if (!profile.onboarded) {
      setEditingProfile(true);
    }
  }, [profile]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  const starterPrompts = useMemo(() => {
    return STARTERS_BY_INTEREST[profile.interest || 'Default'] ?? STARTERS_BY_INTEREST.Default;
  }, [profile.interest]);

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  function handleSaveOnboarding(e: React.FormEvent) {
    e.preventDefault();
    onSaveProfile({
      name: draftName.trim(),
      preferredLanguage: draftLang,
      ageGroup: draftAge,
      interest: draftInterest,
      onboarded: true,
    });
    setEditingProfile(false);
  }

  function handleSkipOnboarding() {
    onSaveProfile({
      ...profile,
      onboarded: true,
    });
    setEditingProfile(false);
  }

  async function handleSendText(overrideText?: string) {
    const clean = (overrideText ?? inputText).trim();
    if (!clean || sending) return;

    setError(null);
    setLastFailedText(null);
    setSending(true);
    setStatusLabel('Thinking…');

    const userMsg: ChatMessage = {
      id: `chat-u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      text: clean,
      timestamp: new Date().toISOString(),
    };

    const recentHistory = messages.slice(-10).map((m) => ({
      role: m.role,
      text: m.text,
    }));

    if (!overrideText) {
      setInputText('');
    }

    try {
      const res = await sendChatMessage({
        message: clean,
        history: recentHistory,
        profile,
        onStatus: (msg) => setStatusLabel(msg),
      });

      const botMsg: ChatMessage = {
        id: `chat-a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        text: res.reply,
        timestamp: new Date().toISOString(),
        detected_language: res.detected_language,
        detected_emotion: res.detected_emotion,
        why_this_advice: res.why_this_advice,
        suggestions: res.suggestions,
        confidence: res.confidence,
        model_used: res.model_used,
      };

      onAddMessages([userMsg, botMsg]);
    } catch (err) {
      if (!overrideText) {
        setInputText(clean);
      }
      setLastFailedText(clean);
      setError(
        err instanceof Error ? err.message : 'The translator is busy, please try again.',
      );
    } finally {
      setSending(false);
    }
  }

  function handleSubmitReport(e: React.FormEvent, botMsg: ChatMessage, msgIndex: number) {
    e.preventDefault();
    if (!betterReplyDraft.trim()) return;

    let pairedUserMsg = '';
    for (let i = msgIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        pairedUserMsg = messages[i].text;
        break;
      }
    }

    onSubmitBadReplyReport({
      id: `creply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      userMessage: pairedUserMsg,
      botReply: botMsg.text,
      suggestedBetterReply: betterReplyDraft.trim(),
      detectedLanguage: botMsg.detected_language ?? 'Unknown',
      detectedEmotion: botMsg.detected_emotion ?? 'neutral',
      model_used: botMsg.model_used,
    });

    setBetterReplyDraft('');
    setReportingMsgId(null);
    setReportedSavedId(botMsg.id);
  }

  const greetingName = profile.name ? ` ${profile.name}` : '';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
      {/* Primary Chat Column */}
      <section className="space-y-4 lg:col-span-8" aria-label="Mukwano-Rafiki chat">
        {/* Skippable Onboarding / Edit Profile Panel */}
        {editingProfile && (
          <form
            onSubmit={handleSaveOnboarding}
            className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-900/80 dark:bg-[#141D18] sm:p-6 space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-emerald-950 dark:text-amber-300">
                  Personalize Mukwano-Rafiki (optional)
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                  Share a few details so examples fit your daily life. Saved in your browser only—never stored on a server.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSkipOnboarding}
                className="min-h-[40px] rounded-xl px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                Skip for now
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="profile-name"
                  className="mb-1 block text-xs font-semibold text-stone-700 dark:text-stone-300"
                >
                  First name or nickname
                </label>
                <input
                  id="profile-name"
                  type="text"
                  maxLength={50}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. Amina or Kato"
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100"
                />
              </div>

              <div>
                <label
                  htmlFor="profile-lang"
                  className="mb-1 block text-xs font-semibold text-stone-700 dark:text-stone-300"
                >
                  Preferred language
                </label>
                <select
                  id="profile-lang"
                  value={draftLang}
                  onChange={(e) => setDraftLang(e.target.value as '' | LanguageName)}
                  className="min-h-[44px] w-full rounded-xl border border-stone-300 bg-[#FAF9F5] px-3.5 py-2 text-sm text-stone-900 focus:border-emerald-700 focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100"
                >
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                Age group
              </span>
              <div className="flex flex-wrap gap-2">
                {AGE_GROUPS.map((age) => (
                  <button
                    key={age.value}
                    type="button"
                    onClick={() =>
                      setDraftAge((prev) => (prev === age.value ? '' : age.value))
                    }
                    className={`min-h-[44px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                      draftAge === age.value
                        ? 'border-emerald-800 bg-emerald-800 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-stone-950'
                        : 'border-stone-300 bg-[#FAF9F5] text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-300'
                    }`}
                  >
                    {age.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-semibold text-stone-700 dark:text-stone-300">
                Main interest
              </span>
              <div className="flex flex-wrap gap-2">
                {INTEREST_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() =>
                      setDraftInterest((prev) => (prev === item.value ? '' : item.value))
                    }
                    className={`min-h-[44px] rounded-xl border px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                      draftInterest === item.value
                        ? 'border-amber-600 bg-amber-500 text-stone-950 dark:border-amber-400 dark:bg-amber-400 dark:text-stone-950'
                        : 'border-stone-300 bg-[#FAF9F5] text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-300'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-emerald-800 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-900 dark:bg-emerald-600 dark:text-stone-950 dark:hover:bg-emerald-500 whitespace-nowrap"
              >
                Save preferences
              </button>
              <button
                type="button"
                onClick={handleSkipOnboarding}
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-300 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                Skip
              </button>
            </div>
          </form>
        )}

        {/* Chat Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-stone-200/90 bg-white px-4 py-3 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18]">
          <div className="text-xs text-stone-600 dark:text-stone-300">
            <span className="font-semibold text-emerald-900 dark:text-emerald-300">
              {profile.name ? `Chatting as ${profile.name}` : 'Friendly Multilingual Chat'}
            </span>
            {(profile.preferredLanguage || profile.interest || profile.ageGroup) && (
              <>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>
                  {[profile.preferredLanguage, profile.interest, profile.ageGroup]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  onNewConversation();
                }}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-200 dark:hover:bg-emerald-950/60 whitespace-nowrap"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>New chat</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setEditingProfile((prev) => !prev)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:text-stone-200 dark:hover:bg-emerald-950/60 whitespace-nowrap"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{editingProfile ? 'Hide profile' : 'Profile'}</span>
            </button>
          </div>
        </div>

        {/* Conversation Feed */}
        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-6 space-y-5">
          {messages.length === 0 ? (
            <div className="space-y-4 py-2">
              <div>
                <h2 className="text-xl font-bold text-stone-900 dark:text-stone-50">
                  Oli otya / Habari / Hello{greetingName}!
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
                  Ask me anything in Luganda, Swahili, English, or mix languages freely. I can help with everyday health questions, school study, farming, or small business and money.
                </p>
              </div>

              <div className="space-y-2 pt-1">
                <p className="text-xs font-semibold text-stone-500 dark:text-stone-400">
                  Tap a starter or type below:
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {starterPrompts.map((starter) => (
                    <button
                      key={starter.label}
                      type="button"
                      disabled={sending}
                      onClick={() => void handleSendText(starter.text)}
                      className="min-h-[44px] rounded-xl border border-stone-300 bg-[#FAF9F5] px-4 py-2.5 text-left text-xs font-semibold text-emerald-950 hover:border-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-amber-200 dark:hover:border-amber-500/70"
                    >
                      {starter.text}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-5" aria-live="polite">
              {messages.map((msg, idx) => {
                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[88%] sm:max-w-[78%] rounded-2xl rounded-br-sm bg-emerald-800 px-4 py-3 text-sm leading-relaxed text-white shadow-sm dark:bg-emerald-700 dark:text-stone-50">
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      </div>
                    </div>
                  );
                }

                const isLatest = msg.id === latestAssistantId;
                const whyOpen = Boolean(openWhyIds[msg.id]);
                const reportOpen = reportingMsgId === msg.id;
                const reportSaved = reportedSavedId === msg.id;

                return (
                  <div key={msg.id} className="flex flex-col items-start space-y-2.5">
                    <div className="max-w-[95%] sm:max-w-[85%] rounded-2xl rounded-bl-sm border border-stone-200/90 bg-[#FAF9F5] px-4 py-3.5 text-stone-900 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 space-y-3">
                      {/* Unboxed Metadata Line */}
                      {(msg.detected_language || msg.detected_emotion || msg.confidence) && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-stone-500 dark:text-stone-400">
                          {msg.detected_language && (
                            <span className="text-emerald-900 dark:text-emerald-300 font-semibold">
                              {msg.detected_language}
                            </span>
                          )}
                          {msg.detected_emotion && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="capitalize">Tone: {msg.detected_emotion}</span>
                            </>
                          )}
                          {msg.confidence && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span
                                className={
                                  msg.confidence === 'low'
                                    ? 'font-semibold text-rose-700 dark:text-rose-300'
                                    : ''
                                }
                              >
                                {msg.confidence === 'high'
                                  ? 'High confidence'
                                  : msg.confidence === 'medium'
                                    ? 'Medium confidence'
                                    : 'Low confidence'}
                              </span>
                            </>
                          )}
                        </div>
                      )}

                      {/* Reply Body */}
                      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-stone-900 dark:text-stone-100">
                        {msg.text}
                      </p>

                      {/* Why This Advice? Panel */}
                      {whyOpen && msg.why_this_advice && (
                        <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/25 dark:text-amber-200">
                          <span className="font-semibold">Why this advice: </span>
                          {msg.why_this_advice}
                        </div>
                      )}

                      {/* Bubble Action Row */}
                      <div className="flex flex-wrap items-center gap-2 border-t border-stone-200/80 pt-2.5 dark:border-emerald-950/80">
                        {msg.why_this_advice && (
                          <button
                            type="button"
                            onClick={() =>
                              setOpenWhyIds((prev) => ({
                                ...prev,
                                [msg.id]: !prev[msg.id],
                              }))
                            }
                            aria-expanded={whyOpen}
                            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100 dark:border-emerald-900/80 dark:bg-[#141D18] dark:text-stone-200 dark:hover:bg-emerald-950/60 whitespace-nowrap"
                          >
                            <HelpCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                            <span>Why this advice?</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onTranslateReply(msg.text)}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-emerald-50 hover:border-emerald-700 dark:border-emerald-900/80 dark:bg-[#141D18] dark:text-stone-200 dark:hover:bg-emerald-950/60 whitespace-nowrap"
                        >
                          <Languages className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                          <span>Translate this reply</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setReportingMsgId((prev) => (prev === msg.id ? null : msg.id));
                            setBetterReplyDraft('');
                          }}
                          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50/70 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200 whitespace-nowrap"
                        >
                          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Report bad reply</span>
                        </button>
                      </div>

                      {msg.model_used && (
                        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                          Model: {msg.model_used}
                        </p>
                      )}

                      {reportSaved && (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                          <span>Thank you. Report saved in your browser.</span>
                          <button
                            type="button"
                            onClick={onNavigateToResults}
                            className="font-semibold underline underline-offset-4"
                          >
                            View reports
                          </button>
                        </div>
                      )}

                      {reportOpen && (
                        <form
                          onSubmit={(e) => handleSubmitReport(e, msg, idx)}
                          className="space-y-2.5 border-t border-stone-200 pt-3 dark:border-emerald-950/80"
                        >
                          <label
                            htmlFor={`bad-reply-${msg.id}`}
                            className="block text-xs font-semibold text-stone-700 dark:text-stone-300"
                          >
                            What should Mukwano-Rafiki have said instead?
                          </label>
                          <textarea
                            id={`bad-reply-${msg.id}`}
                            rows={2}
                            required
                            value={betterReplyDraft}
                            onChange={(e) => setBetterReplyDraft(e.target.value)}
                            placeholder="Write a more natural, helpful, or safer reply…"
                            className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs text-stone-900 focus:border-amber-600 focus:outline-none dark:border-emerald-900/80 dark:bg-[#141D18] dark:text-stone-100"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="submit"
                              className="inline-flex min-h-[40px] items-center rounded-xl bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-stone-950"
                            >
                              Save report
                            </button>
                            <button
                              type="button"
                              onClick={() => setReportingMsgId(null)}
                              className="inline-flex min-h-[40px] items-center rounded-xl px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-200/60 dark:text-stone-300"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </div>

                    {/* 2-3 Quick Follow-Up Suggestions after the latest reply */}
                    {isLatest && !sending && msg.suggestions && msg.suggestions.length > 0 && (
                      <div className="flex flex-wrap gap-2 pl-1">
                        {msg.suggestions.slice(0, 3).map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => void handleSendText(suggestion)}
                            className="min-h-[44px] rounded-xl border border-emerald-700/30 bg-emerald-50/70 px-3.5 py-2 text-left text-xs font-semibold text-emerald-950 hover:bg-emerald-100 dark:border-emerald-800/80 dark:bg-emerald-950/40 dark:text-amber-200 dark:hover:bg-emerald-950/70"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Typing Indicator */}
              {sending && (
                <div className="flex items-start">
                  <div className="inline-flex items-center gap-3 rounded-2xl rounded-bl-sm border border-stone-200 bg-[#FAF9F5] px-4 py-3 text-xs font-medium text-stone-700 dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-300">
                    <span className="inline-flex items-center gap-1" aria-hidden="true">
                      <span className="h-2 w-2 rounded-full bg-emerald-700 dark:bg-amber-400 animate-bounce [animation-delay:-0.2s]" />
                      <span className="h-2 w-2 rounded-full bg-emerald-700 dark:bg-amber-400 animate-bounce [animation-delay:-0.1s]" />
                      <span className="h-2 w-2 rounded-full bg-emerald-700 dark:bg-amber-400 animate-bounce" />
                    </span>
                    <span>{statusLabel}</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Friendly Busy / Error Alert */}
          {error && (
            <div
              role="alert"
              className="space-y-3 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100"
            >
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                  <span className="leading-relaxed">{error}</span>
                </div>
                {lastFailedText && (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => void handleSendText(lastFailedText)}
                    className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-rose-300 bg-white px-3.5 py-1.5 font-semibold text-rose-900 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100 whitespace-nowrap"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Chat Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendText();
            }}
            className="border-t border-stone-100 pt-4 dark:border-emerald-950/70"
          >
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-stretch">
              <div className="flex-1 flex gap-2">
                <label htmlFor="chat-input" className="sr-only">
                  Ask Mukwano-Rafiki a question
                </label>
                <textarea
                  id="chat-input"
                  rows={2}
                  maxLength={2000}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendText();
                    }
                  }}
                  placeholder="Write in Luganda, Swahili, English, or mix languages…"
                  className="min-h-[64px] w-full resize-none rounded-xl border border-stone-300 bg-[#FAF9F5] px-4 py-3 text-sm leading-relaxed text-stone-900 placeholder:text-stone-400 focus:border-emerald-700 focus:bg-white focus:outline-none dark:border-emerald-900/80 dark:bg-[#0D1310] dark:text-stone-100 dark:placeholder:text-stone-500"
                />
              </div>

              <div className="flex items-stretch shrink-0">
                <button
                  type="submit"
                  disabled={sending || inputText.trim().length === 0}
                  className="inline-flex min-h-[48px] flex-1 sm:flex-none items-center justify-center gap-2 rounded-xl bg-emerald-800 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-55 dark:bg-emerald-600 dark:text-stone-950 dark:hover:bg-emerald-500 whitespace-nowrap"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span>Send</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>

      {/* Right Column: Topics, Personalization Summary & Clear Data Privacy Controls */}
      <aside className="space-y-4 lg:col-span-4" aria-label="Guidance topics and privacy">
        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-5 space-y-4">
          <h3 className="text-base font-bold text-stone-900 dark:text-stone-50">
            Topics I can help with
          </h3>
          <ul className="space-y-2 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
            <li>
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                General Health:
              </span>{' '}
              everyday self-care &amp; when to visit a clinic (never diagnoses or prescribes).
            </li>
            <li>
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                School &amp; Study:
              </span>{' '}
              revision plans, memory tips, and calm exam preparation.
            </li>
            <li>
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                Farming:
              </span>{' '}
              practical soil, crop, water, and harvest-storage checks.
            </li>
            <li>
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                Small Business &amp; Money:
              </span>{' '}
              stock tracking, fair pricing, and cautious saving habits.
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm dark:border-emerald-950/90 dark:bg-[#141D18] sm:p-5 space-y-3">
          <h3 className="text-sm font-bold text-stone-900 dark:text-stone-50">
            Your privacy on this device
          </h3>
          <p className="text-xs leading-relaxed text-stone-600 dark:text-stone-300">
            Your profile and chat history stay only in this browser. Details are sent only when needed to personalize your current reply.
          </p>

          {!confirmClearData ? (
            <button
              type="button"
              onClick={() => setConfirmClearData(true)}
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-rose-300 bg-rose-50/70 px-4 py-2 text-xs font-semibold text-rose-900 hover:bg-rose-100 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-200 dark:hover:bg-rose-950/50"
            >
              <Eraser className="h-4 w-4" aria-hidden="true" />
              <span>Clear my data</span>
            </button>
          ) : (
            <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900/70 dark:bg-rose-950/30">
              <p className="text-xs font-medium text-rose-900 dark:text-rose-200">
                Remove your saved profile and chat history from this browser?
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onClearPersonalData();
                    setConfirmClearData(false);
                    setError(null);
                  }}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-rose-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Yes, clear data</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearData(false)}
                  className="inline-flex min-h-[40px] items-center rounded-xl border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-stone-700 dark:border-emerald-900/80 dark:bg-[#141D18] dark:text-stone-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
