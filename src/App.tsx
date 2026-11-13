import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  ClipboardCheck,
  Languages,
  MessageCircle,
  Moon,
  Sun,
} from 'lucide-react';
import { ChatView } from './components/ChatView';
import { ResultsView } from './components/ResultsView';
import { TestModeView } from './components/TestModeView';
import { TranslatorView } from './components/TranslatorView';
import type {
  AppView,
  BadReplyReport,
  BadTranslationReport,
  ChatMessage,
  ChatTestEvaluation,
  HistoryItem,
  ModelChoice,
  TestPhraseEvaluation,
  ThemeMode,
  UserProfile,
} from './types';
import { DEFAULT_MODEL_CONFIG, fetchHealthConfig, type ServerHealthConfig } from './utils/api';
import {
  DEFAULT_USER_PROFILE,
  clearPersonalChatData,
  loadBadReplyReports,
  loadChatHistory,
  loadChatTestEvaluations,
  loadHistory,
  loadReports,
  loadTestEvaluations,
  loadTheme,
  loadUserProfile,
  mergeChatTestEvaluation,
  mergeTestEvaluation,
  persistBadReplyReports,
  persistChatHistory,
  persistChatTestEvaluations,
  persistHistory,
  persistReports,
  persistTestEvaluations,
  persistUserProfile,
  removeChatTestEvaluationsForModel,
  removeTestEvaluationsForModel,
  saveTheme,
} from './utils/storage';

export default function App() {
  const [view, setView] = useState<AppView>('chat');
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [profile, setProfile] = useState<UserProfile>(() => loadUserProfile());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => loadChatHistory());
  const [badReplyReports, setBadReplyReports] = useState<BadReplyReport[]>(() =>
    loadBadReplyReports(),
  );
  const [chatEvaluations, setChatEvaluations] = useState<Record<string, ChatTestEvaluation>>(() =>
    loadChatTestEvaluations(),
  );
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [reports, setReports] = useState<BadTranslationReport[]>(() => loadReports());
  const [evaluations, setEvaluations] = useState<Record<string, TestPhraseEvaluation>>(() =>
    loadTestEvaluations(),
  );
  const [pendingTranslateText, setPendingTranslateText] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ServerHealthConfig>(DEFAULT_MODEL_CONFIG);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    void fetchHealthConfig().then((cfg) => {
      if (active) setModelConfig(cfg);
    });
    return () => {
      active = false;
    };
  }, []);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  function handleSaveProfile(nextProfile: UserProfile) {
    setProfile(nextProfile);
    if (!persistUserProfile(nextProfile)) setStorageWarning(true);
  }

  function handleAddChatMessages(newMessages: ChatMessage[]) {
    setChatMessages((prev) => {
      const next = [...prev, ...newMessages].slice(-60);
      if (!persistChatHistory(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleNewConversation() {
    persistChatHistory([]);
    setChatMessages([]);
  }

  function handleClearPersonalData() {
    clearPersonalChatData();
    setProfile(DEFAULT_USER_PROFILE);
    setChatMessages([]);
  }

  function handleSubmitBadReplyReport(report: BadReplyReport) {
    setBadReplyReports((prev) => {
      const next = [report, ...prev];
      if (!persistBadReplyReports(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleDeleteBadReplyReport(id: string) {
    setBadReplyReports((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (!persistBadReplyReports(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleTranslateReply(text: string) {
    setPendingTranslateText(text);
    setView('translate');
  }

  function handleTranslationSuccess(item: HistoryItem) {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 10);
      if (!persistHistory(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleClearHistory() {
    persistHistory([]);
    setHistory([]);
  }

  function handleSubmitReport(report: BadTranslationReport) {
    setReports((prev) => {
      const next = [report, ...prev];
      if (!persistReports(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleDeleteReport(id: string) {
    setReports((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (!persistReports(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleUpdateChatEvaluation(
    modelChoice: ModelChoice,
    caseId: string,
    patch: Partial<ChatTestEvaluation>,
  ) {
    setChatEvaluations((prev) => {
      const next = mergeChatTestEvaluation(prev, modelChoice, caseId, patch);
      if (!persistChatTestEvaluations(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleResetChatEvaluations(modelChoice: ModelChoice) {
    setChatEvaluations((prev) => {
      const next = removeChatTestEvaluationsForModel(prev, modelChoice);
      if (!persistChatTestEvaluations(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleUpdateEvaluation(
    modelChoice: ModelChoice,
    phraseId: string,
    patch: Partial<TestPhraseEvaluation>,
  ) {
    setEvaluations((prev) => {
      const next = mergeTestEvaluation(prev, modelChoice, phraseId, patch);
      if (!persistTestEvaluations(next)) setStorageWarning(true);
      return next;
    });
  }

  function handleResetEvaluations(modelChoice: ModelChoice) {
    setEvaluations((prev) => {
      const next = removeTestEvaluationsForModel(prev, modelChoice);
      if (!persistTestEvaluations(next)) setStorageWarning(true);
      return next;
    });
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F7F2] text-[#1C1B18] dark:bg-[#0D1310] dark:text-[#F3F2EC] pb-20 md:pb-0">
      {/* Header (3-zone top bar) */}
      <header className="border-b border-stone-200/90 bg-white/95 dark:border-emerald-950/90 dark:bg-[#111915]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-emerald-950 dark:text-amber-300 sm:text-xl whitespace-nowrap">
              Mukwano-Rafiki
            </h1>
          </div>

          {/* Desktop Navigation */}
          <nav
            className="hidden md:flex items-center gap-6 text-sm font-semibold"
            aria-label="Primary navigation"
          >
            <button
              type="button"
              onClick={() => setView('chat')}
              className={`min-h-[44px] px-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                view === 'chat'
                  ? 'border-emerald-800 text-emerald-900 dark:border-amber-400 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white'
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setView('translate')}
              className={`min-h-[44px] px-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                view === 'translate'
                  ? 'border-emerald-800 text-emerald-900 dark:border-amber-400 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white'
              }`}
            >
              Translator
            </button>
            <button
              type="button"
              onClick={() => setView('test')}
              className={`min-h-[44px] px-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                view === 'test'
                  ? 'border-emerald-800 text-emerald-900 dark:border-amber-400 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white'
              }`}
            >
              Test mode
            </button>
            <button
              type="button"
              onClick={() => setView('results')}
              className={`min-h-[44px] px-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                view === 'results'
                  ? 'border-emerald-800 text-emerald-900 dark:border-amber-400 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white'
              }`}
            >
              Results
            </button>
          </nav>

          {/* Theme Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-xl border border-stone-300 bg-[#FAF9F5] px-3 text-xs font-semibold text-stone-800 hover:bg-amber-50 hover:border-amber-400 dark:border-emerald-900/80 dark:bg-[#16211B] dark:text-stone-100 dark:hover:border-amber-500/60"
          >
            {theme === 'dark' ? (
              <>
                <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
                <span className="hidden sm:inline">Light</span>
              </>
            ) : (
              <>
                <Moon className="h-4 w-4 text-emerald-800" aria-hidden="true" />
                <span className="hidden sm:inline">Dark</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 sm:py-8">
        {storageWarning && (
          <div
            role="status"
            className="mb-4 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Browser storage is full or disabled. Data remains active in this tab—export CSV before closing.
            </span>
          </div>
        )}

        {view === 'chat' && (
          <ChatView
            profile={profile}
            messages={chatMessages}
            onSaveProfile={handleSaveProfile}
            onAddMessages={handleAddChatMessages}
            onNewConversation={handleNewConversation}
            onClearPersonalData={handleClearPersonalData}
            onSubmitBadReplyReport={handleSubmitBadReplyReport}
            onTranslateReply={handleTranslateReply}
            onNavigateToResults={() => setView('results')}
          />
        )}

        {view === 'translate' && (
          <TranslatorView
            history={history}
            initialText={pendingTranslateText}
            onConsumeInitialText={() => setPendingTranslateText(null)}
            onTranslationSuccess={handleTranslationSuccess}
            onClearHistory={handleClearHistory}
            onSubmitReport={handleSubmitReport}
            onNavigateToReports={() => setView('results')}
          />
        )}

        {view === 'test' && (
          <TestModeView
            chatEvaluations={chatEvaluations}
            evaluations={evaluations}
            modelConfig={modelConfig}
            onUpdateChatEvaluation={handleUpdateChatEvaluation}
            onUpdateEvaluation={handleUpdateEvaluation}
            onResetChatEvaluations={handleResetChatEvaluations}
            onResetEvaluations={handleResetEvaluations}
            onNavigateToResults={() => setView('results')}
          />
        )}

        {view === 'results' && (
          <ResultsView
            chatEvaluations={chatEvaluations}
            badReplyReports={badReplyReports}
            evaluations={evaluations}
            reports={reports}
            modelConfig={modelConfig}
            onDeleteBadReplyReport={handleDeleteBadReplyReport}
            onDeleteReport={handleDeleteReport}
            onNavigateToTest={() => setView('test')}
          />
        )}
      </main>

      {/* Footer Note */}
      <footer className="border-t border-stone-200/80 bg-white/60 px-4 py-4 text-center text-xs text-stone-600 dark:border-emerald-950/80 dark:bg-[#111915]/60 dark:text-stone-400 sm:px-6">
        <p className="mx-auto max-w-3xl leading-relaxed">
          Mukwano-Rafiki gives general advice, not professional medical, legal or financial advice.
        </p>
      </footer>

      {/* Mobile Fixed Bottom Thumb Navigation (< md, 64px <= 15% mobile viewport cap) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-4 border-t border-stone-200 bg-white/95 backdrop-blur-md dark:border-emerald-950 dark:bg-[#111915]/95 md:hidden"
      >
        <button
          type="button"
          onClick={() => setView('chat')}
          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
            view === 'chat'
              ? 'text-emerald-800 dark:text-amber-300'
              : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          <span>Chat</span>
        </button>

        <button
          type="button"
          onClick={() => setView('translate')}
          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
            view === 'translate'
              ? 'text-emerald-800 dark:text-amber-300'
              : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          <Languages className="h-5 w-5" aria-hidden="true" />
          <span>Translator</span>
        </button>

        <button
          type="button"
          onClick={() => setView('test')}
          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
            view === 'test'
              ? 'text-emerald-800 dark:text-amber-300'
              : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          <span>Test mode</span>
        </button>

        <button
          type="button"
          onClick={() => setView('results')}
          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
            view === 'results'
              ? 'text-emerald-800 dark:text-amber-300'
              : 'text-stone-500 dark:text-stone-400'
          }`}
        >
          <BarChart3 className="h-5 w-5" aria-hidden="true" />
          <span>Results</span>
        </button>
      </nav>
    </div>
  );
}
