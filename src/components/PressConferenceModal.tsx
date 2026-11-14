import { useEffect, useState } from 'react';
import { CheckCircle2, Mic, Newspaper, ShieldAlert, Sparkles, X } from 'lucide-react';
import type { MatchRecord, PressConferenceQuestion } from '../types/game';
import { apiFetch } from '../lib/api';

type Stance = 'measured' | 'assertive' | 'critical';

const STANCE_OPTIONS: Array<{
  id: Stance;
  title: string;
  subtitle: string;
  effectText: string;
  accentClass: string;
}> = [
  {
    id: 'measured',
    title: 'Measured / Diplomatic',
    subtitle: 'Protect the dressing room and deflect controversy.',
    effectText: 'Squad Morale +2 · Board Reputation +1',
    accentClass: 'border-[#93E6EE]/45 hover:border-[#93E6EE]',
  },
  {
    id: 'assertive',
    title: 'Assertive / Mind Games',
    subtitle: 'Back your match-winners publicly and challenge rival dugouts.',
    effectText: 'Next-Match Press Edge · Sparks Opponent Rivalry Buff',
    accentClass: 'border-[#EAB308]/45 hover:border-[#EAB308]',
  },
  {
    id: 'critical',
    title: 'Publicly Critical',
    subtitle: 'Call out execution lapses and demand higher standards.',
    effectText: 'Board Reputation +2 · Target Player Morale -8 & Form -4',
    accentClass: 'border-rose-500/45 hover:border-rose-400',
  },
];

export function PressConferenceModal({
  leagueId,
  match,
  onClose,
  onCompleted,
  onToast,
}: {
  leagueId: number;
  match: MatchRecord;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  onToast?: (t: { tone: 'success' | 'error' | 'info' | 'warning'; title: string; body?: string }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [questions, setQuestions] = useState<PressConferenceQuestion[]>([]);
  const [choices, setChoices] = useState<Record<string, Stance>>({});
  const [impactSummary, setImpactSummary] = useState<string | null>(
    match.pressConferenceJson?.overallImpactSummary || null
  );
  const [completed, setCompleted] = useState(Boolean(match.pressConferenceCompleted));

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch<{
      pressConference: { questions: PressConferenceQuestion[]; overallImpactSummary?: string };
      completed: boolean;
    }>(`/api/leagues/${leagueId}/matches/${match.id}/press-conference`, {
      method: 'POST',
    })
      .then((res) => {
        if (!active) return;
        const qs = res.pressConference?.questions || [];
        setQuestions(qs);
        setCompleted(Boolean(res.completed));
        if (res.pressConference?.overallImpactSummary) {
          setImpactSummary(res.pressConference.overallImpactSummary);
        }
        const initial: Record<string, Stance> = {};
        for (const q of qs) {
          initial[q.id] = q.chosenStance || 'measured';
        }
        setChoices(initial);
      })
      .catch((err: any) => {
        onToast?.({
          tone: 'error',
          title: 'Press room unavailable',
          body: err.message,
        });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [leagueId, match.id]);

  const handleSubmit = async () => {
    if (questions.length === 0 || completed) return;
    setSubmitting(true);
    try {
      const res = await apiFetch<{
        pressConference: { questions: PressConferenceQuestion[]; overallImpactSummary?: string };
        impactSummary: string;
      }>(`/api/leagues/${leagueId}/matches/${match.id}/press-conference/answer`, {
        method: 'POST',
        body: JSON.stringify({
          answers: questions.map((q) => ({
            questionId: q.id,
            stance: choices[q.id] || 'measured',
          })),
        }),
      });
      setQuestions(res.pressConference?.questions || questions);
      setImpactSummary(res.impactSummary);
      setCompleted(true);
      await onCompleted();
      onToast?.({
        tone: 'success',
        title: 'Published to The League Gazette',
        body: res.impactSummary,
      });
    } catch (err: any) {
      onToast?.({
        tone: 'error',
        title: 'Could not submit press answers',
        body: err.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto cm27-view-enter">
      <div className="cm27-panel w-full max-w-3xl overflow-hidden shadow-2xl my-auto">
        <div className="px-6 py-4 bg-[#0B0F15] border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded bg-[#18202B] border border-[#93E6EE]/35 flex items-center justify-center shrink-0">
              <Mic className="w-4 h-4 text-[#93E6EE]" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-widest text-[#93E6EE]">
                POST-MATCH MEDIA BRIEFING · {match.competitionLabel}
              </div>
              <h2 className="font-condensed text-2xl font-extrabold text-white uppercase truncate">
                {match.marginText || 'Match Press Room'}
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer"
            aria-label="Close press conference"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {loading ? (
            <div className="py-12 text-center space-y-2">
              <Sparkles className="w-6 h-6 text-[#93E6EE] mx-auto animate-pulse" />
              <div className="text-sm font-semibold text-white">
                Preparing Journalist Briefing...
              </div>
              <p className="text-xs text-slate-400">
                Correspondents are reviewing match scorecards, turning points, and fielding telemetry.
              </p>
            </div>
          ) : (
            <>
              {impactSummary && (
                <div className="p-3.5 rounded bg-[#11241B] border border-emerald-500/35 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 text-xs text-emerald-200">
                    <CheckCircle2 className="w-4 h-4 text-[#4ADE80] shrink-0" />
                    <span>
                      <strong>Gazette Impact:</strong> {impactSummary}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono uppercase text-[#4ADE80] shrink-0">
                    ON RECORD
                  </span>
                </div>
              )}

              {questions.map((q, idx) => {
                const selected = choices[q.id] || 'measured';
                return (
                  <div key={q.id} className="cm27-panel-inset p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
                      <span className="text-[#EAB308] font-bold">
                        Q{idx + 1} · {q.journalist} ({q.outlet})
                      </span>
                      {q.targetPlayerName && (
                        <span className="text-[#93E6EE]">Focus: {q.targetPlayerName}</span>
                      )}
                    </div>

                    <p className="text-sm text-white font-medium leading-relaxed">
                      “{q.question}”
                    </p>

                    {completed && q.chosenQuote ? (
                      <div className="p-3 rounded bg-[#0C1016] border border-white/10 text-xs text-slate-300 italic">
                        {q.chosenQuote}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1">
                        {STANCE_OPTIONS.map((opt) => {
                          const isSelected = selected === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setChoices((prev) => ({ ...prev, [q.id]: opt.id }))}
                              className={`p-3 rounded border text-left transition-all cursor-pointer space-y-1.5 ${
                                isSelected
                                  ? 'cm27-card-focus'
                                  : `bg-[#0D1117] ${opt.accentClass}`
                              }`}
                            >
                              <div className="text-xs font-bold text-white">{opt.title}</div>
                              <div className="text-[11px] text-slate-400 leading-snug">
                                {opt.subtitle}
                              </div>
                              <div className="text-[10px] font-mono text-[#93E6EE] pt-1">
                                {opt.effectText}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {!completed && (
                <div className="p-3 rounded bg-[#0C1016] border border-white/[0.07] flex items-center gap-2 text-[11px] text-slate-400">
                  <ShieldAlert className="w-4 h-4 text-[#EAB308] shrink-0" />
                  <span>
                    Quotes are syndicated immediately to <strong>The League Gazette</strong> and shape
                    squad morale &amp; opponent rivalries for the upcoming round.
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 bg-[#0B0F15] border-t border-white/[0.08] flex items-center justify-end gap-3">
          {completed ? (
            <button
              onClick={onClose}
              className="cm27-btn-3d px-6 py-2.5 rounded text-xs font-bold uppercase tracking-wider cursor-pointer"
            >
              Return to Matchday
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="cm27-btn-dark-3d px-4 py-2.5 rounded text-xs font-semibold text-slate-300 cursor-pointer"
              >
                Skip Briefing
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading || submitting || questions.length === 0}
                className="cm27-btn-3d px-6 py-2.5 rounded text-xs font-bold uppercase tracking-wider flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <Newspaper className="w-3.5 h-3.5" />
                <span>{submitting ? 'Publishing Quotes...' : 'Deliver Statements'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
