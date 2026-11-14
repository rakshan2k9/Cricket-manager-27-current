import { GoogleGenAI, Type } from '@google/genai';
import type { MatchResultSummary, PressConferenceQuestion } from '../db/schema.ts';

export interface PressConferenceContextInput {
  matchId: number;
  leagueName: string;
  competitionLabel: string;
  humanTeamId: number;
  humanTeamName: string;
  humanTeamShortCode: string;
  oppTeamName: string;
  oppTeamShortCode: string;
  managerName: string;
  summary: MatchResultSummary;
}

function extractMatchSignals(input: PressConferenceContextInput) {
  const { summary, humanTeamId } = input;
  const allBatters = [...(summary.innings1.batters || []), ...(summary.innings2.batters || [])];
  const allBowlers = [...(summary.innings1.bowlers || []), ...(summary.innings2.bowlers || [])];

  const myInn = summary.innings1.teamId === humanTeamId ? summary.innings1 : summary.innings2;
  const oppInn = summary.innings1.teamId === humanTeamId ? summary.innings2 : summary.innings1;

  const topScorer = [...allBatters].sort((a, b) => b.runs - a.runs)[0] || null;
  const myTopBatter = [...(myInn.batters || [])].sort((a, b) => b.runs - a.runs)[0] || topScorer;
  const myBowlers = [...(oppInn.bowlers || [])].filter((b) => parseFloat(b.overs) >= 1);
  const worstMyBowler =
    [...myBowlers].sort((a, b) => b.econ - a.econ || a.wickets - b.wickets)[0] ||
    [...allBowlers].sort((a, b) => b.econ - a.econ)[0] ||
    null;

  const myWon = summary.winnerTeamId === humanTeamId;
  const droppedCatches = summary.droppedCatches || [];
  const turningPoints = summary.turningPoints || [];

  return {
    myWon,
    myInn,
    oppInn,
    topScorer,
    myTopBatter,
    worstMyBowler,
    droppedCatches,
    turningPoints,
  };
}

function buildFallbackQuestions(input: PressConferenceContextInput): PressConferenceQuestion[] {
  const {
    myWon,
    myInn,
    oppInn,
    myTopBatter,
    worstMyBowler,
    droppedCatches,
    turningPoints,
  } = extractMatchSignals(input);

  const q1Target = myTopBatter;
  const q1 = myWon
    ? `${input.managerName}, ${input.humanTeamShortCode} sealed a statement result (${input.summary.marginText}) at ${input.summary.venue}. How crucial was ${q1Target ? `${q1Target.name}'s ${q1Target.runs} (${q1Target.balls}b)` : 'your top-order execution'} on a ${input.summary.pitchCondition.split('·')[0].trim()} surface?`
    : `${input.managerName}, ${input.humanTeamShortCode} fell short (${input.summary.marginText}) despite ${q1Target ? `${q1Target.name}'s ${q1Target.runs} runs` : 'fighting moments'}. Where did the tactical plan unravel against ${input.oppTeamShortCode}?`;

  const q2Target = worstMyBowler;
  const q2 =
    droppedCatches.length > 0
      ? `Fielding lapses proved expensive tonight — notably ${droppedCatches[0]}. Is dressing-room intensity dipping during high-pressure overs?`
      : q2Target && q2Target.econ >= 9.0
        ? `${q2Target.name} conceded ${q2Target.runs} runs at ${q2Target.econ} RPO in a tight contest. Do you back him to retain his role in the next fixture, or are bowling changes coming?`
        : `${oppInn.teamShortCode} posted ${oppInn.runs}/${oppInn.wickets} (${oppInn.overs} ov). Were you satisfied with your bowlers' execution in the death overs?`;

  const q3 =
    turningPoints.length > 0
      ? `With ${turningPoints[0]} shaping the contest and ${input.oppTeamShortCode} looming on the schedule, what message are you sending to rival dugouts ahead of the next round?`
      : `Looking ahead to the rest of the ${input.competitionLabel} campaign after ${myInn.runs}/${myInn.wickets} today, will ${input.humanTeamShortCode} play an even bolder brand of cricket?`;

  return [
    {
      id: `pc-${input.matchId}-1`,
      journalist: 'Vikram Deshmukh',
      outlet: 'CricWire Chronicle',
      question: q1,
      targetPlayerId: q1Target?.playerId ?? null,
      targetPlayerName: q1Target?.name ?? null,
    },
    {
      id: `pc-${input.matchId}-2`,
      journalist: 'Eleanor Finch',
      outlet: 'The Pavilion Post',
      question: q2,
      targetPlayerId: q2Target?.playerId ?? null,
      targetPlayerName: q2Target?.name ?? null,
    },
    {
      id: `pc-${input.matchId}-3`,
      journalist: 'Rohan Malhotra',
      outlet: 'Broadcast Desk Live',
      question: q3,
      targetPlayerId: null,
      targetPlayerName: null,
    },
  ];
}

export async function generatePressConferenceQuestions(
  input: PressConferenceContextInput
): Promise<PressConferenceQuestion[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildFallbackQuestions(input);
  }

  const signals = extractMatchSignals(input);
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const compactMatchPayload = {
    competition: input.competitionLabel,
    venue: input.summary.venue,
    pitch: input.summary.pitchCondition,
    result: input.summary.marginText,
    manOfTheMatch: input.summary.manOfTheMatch,
    humanClub: `${input.humanTeamName} (${input.humanTeamShortCode})`,
    opponentClub: `${input.oppTeamName} (${input.oppTeamShortCode})`,
    humanWon: signals.myWon,
    innings1: {
      team: signals.myInn.teamShortCode,
      score: `${signals.myInn.runs}/${signals.myInn.wickets} (${signals.myInn.overs} ov)`,
      topScorer: signals.myInn.topScorer,
      topBowler: signals.myInn.topBowler,
    },
    innings2: {
      team: signals.oppInn.teamShortCode,
      score: `${signals.oppInn.runs}/${signals.oppInn.wickets} (${signals.oppInn.overs} ov)`,
      topScorer: signals.oppInn.topScorer,
      topBowler: signals.oppInn.topBowler,
    },
    notableDroppedCatches: signals.droppedCatches.slice(0, 2),
    turningPoints: signals.turningPoints.slice(0, 3),
    spotlightPlayers: [
      signals.myTopBatter
        ? {
            id: signals.myTopBatter.playerId,
            name: signals.myTopBatter.name,
            stat: `${signals.myTopBatter.runs} (${signals.myTopBatter.balls}b)`,
          }
        : null,
      signals.worstMyBowler
        ? {
            id: signals.worstMyBowler.playerId,
            name: signals.worstMyBowler.name,
            stat: `${signals.worstMyBowler.wickets}/${signals.worstMyBowler.runs} (econ ${signals.worstMyBowler.econ})`,
          }
        : null,
    ].filter(Boolean),
  };

  const prompt = `You are a sharp, authentic international cricket sports journalist moderating a post-match press conference for manager ${input.managerName} (${input.humanTeamName}).
Analyze this exact match JSON summary and generate 3 pointed, realistic sports journalism questions referencing specific match events, scores, dropped catches, or player performances.
Question 1 should focus on batting / tactical result.
Question 2 should probe a specific pressure point (e.g. an expensive bowling spell, dropped catch, or middle-over collapse) and include targetPlayerId/targetPlayerName from spotlightPlayers if relevant.
Question 3 should invite a statement about the rivalry with ${input.oppTeamShortCode} or next-match mindset.
Keep tone mature, broadcast-authentic (like ESPNcricinfo / Cricbuzz). Concise 1-2 sentence questions.

MATCH SUMMARY:
${JSON.stringify(compactMatchPayload)}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      questions: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            journalist: { type: Type.STRING },
            outlet: { type: Type.STRING },
            question: { type: Type.STRING },
            targetPlayerId: { type: Type.INTEGER, nullable: true },
            targetPlayerName: { type: Type.STRING, nullable: true },
          },
          required: ['journalist', 'outlet', 'question'],
        },
      },
    },
    required: ['questions'],
  };

  for (const modelName of ['gemini-2.5-flash', 'gemini-4-hydrogen']) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema,
          temperature: 0.7,
        },
      });
      const text = response.text?.trim();
      if (!text) continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.questions) && parsed.questions.length >= 3) {
        return parsed.questions.slice(0, 3).map((q: any, idx: number) => ({
          id: `pc-${input.matchId}-${idx + 1}`,
          journalist: String(q.journalist || 'Senior Correspondent'),
          outlet: String(q.outlet || 'League Press Pool'),
          question: String(q.question || ''),
          targetPlayerId: typeof q.targetPlayerId === 'number' ? q.targetPlayerId : null,
          targetPlayerName: q.targetPlayerName ? String(q.targetPlayerName) : null,
        }));
      }
    } catch (err) {
      console.warn(`Gemini press conference call failed on ${modelName}:`, (err as Error)?.message);
    }
  }

  return buildFallbackQuestions(input);
}

export function buildPressQuoteText(
  stance: 'measured' | 'assertive' | 'critical',
  managerName: string,
  teamShortCode: string,
  oppShortCode: string,
  targetPlayerName?: string | null
): string {
  if (stance === 'measured') {
    return `"We stay level whether we win or lose. Every player in the ${teamShortCode} dressing room knows the process, and we take the lessons straight into training." — ${managerName}`;
  }
  if (stance === 'assertive') {
    return `"${teamShortCode} won't take a backward step against ${oppShortCode} or anyone in this competition. We back our match-winners to dominate the big moments." — ${managerName}`;
  }
  return targetPlayerName
    ? `"At this level there is no hiding place — ${targetPlayerName} and the senior group know those numbers aren't acceptable for ${teamShortCode}. Selection places have to be earned." — ${managerName}`
    : `"Standards slipped today and the dressing room knows it. If players don't execute under pressure for ${teamShortCode}, we will make tough selection calls." — ${managerName}`;
}
