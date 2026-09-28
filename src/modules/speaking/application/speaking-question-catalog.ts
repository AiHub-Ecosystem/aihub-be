import type { SpeakingPart } from '../../../contracts/speaking/questions';
import type { SpeakingAudioStoragePort } from './speaking-audio-storage.port';

type AudioExtension = 'mp3' | 'webm';

type SpeakingQuestionDefinition = {
  readonly part: SpeakingPart;
  readonly text: string;
  readonly extension: AudioExtension;
};

export interface SpeakingQuestionCatalogEntry {
  readonly id: string;
  readonly part: SpeakingPart;
  readonly promptText: string;
  readonly audioObjectKey: string;
}

export interface SpeakingQuestionWithAudio
  extends Omit<SpeakingQuestionCatalogEntry, 'audioObjectKey'> {
  readonly audioUrl: string;
}

const AUDIO_PREFIX = 'speaking-samples';

const SAMPLE_ANSWER_QUESTION: SpeakingQuestionDefinition = {
  part: 1,
  text: 'Do you enjoy living in your city or hometown',
  extension: 'webm',
};

const DEFINITIONS: readonly SpeakingQuestionDefinition[] = [
  SAMPLE_ANSWER_QUESTION,
  {
    part: 1,
    text: 'How often do you use public transport',
    extension: 'webm',
  },
  {
    part: 1,
    text: 'What do you usually do on weekends',
    extension: 'webm',
  },
  {
    part: 1,
    text: 'What kind of music do you like to listen to',
    extension: 'webm',
  },
  { part: 1, text: 'Do you have a favorite teacher', extension: 'mp3' },
  { part: 1, text: 'Do you think teachers should be strict', extension: 'mp3' },
  {
    part: 1,
    text: 'Do you want to be a teacher in the future',
    extension: 'mp3',
  },
  { part: 1, text: 'Do you make plans for your weekends', extension: 'mp3' },
  { part: 1, text: 'When did you start using the internet', extension: 'mp3' },
  {
    part: 1,
    text: 'Do you think you spend too much time online',
    extension: 'mp3',
  },
  { part: 1, text: 'How often do you go online', extension: 'mp3' },
  { part: 1, text: 'What would you do without the internet', extension: 'mp3' },
  {
    part: 1,
    text: 'What do you usually do on weekends, Do you study or work',
    extension: 'mp3',
  },
  { part: 1, text: 'What did you do last weekend', extension: 'mp3' },
  {
    part: 2,
    text: 'Describe a book you recently read that you found useful',
    extension: 'webm',
  },
  {
    part: 2,
    text: 'Describe a time that you showed something new to others',
    extension: 'mp3',
  },
  {
    part: 2,
    text: 'Describe a person who encouraged you to achieve your goal',
    extension: 'mp3',
  },
  {
    part: 2,
    text: 'Describe a subject or something that you would like to learn in the future',
    extension: 'mp3',
  },
  {
    part: 3,
    text: 'Do you agree that travel broadens peoples horizons and minds',
    extension: 'webm',
  },
  {
    part: 3,
    text: 'Do you think governments should continue to fund public libraries',
    extension: 'webm',
  },
  {
    part: 3,
    text: 'What makes some skills more difficult to learn than others',
    extension: 'webm',
  },
  {
    part: 3,
    text: 'Why do you think people read fewer books nowadays compared to the past',
    extension: 'webm',
  },
];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function catalogEntry(
  definition: SpeakingQuestionDefinition,
): SpeakingQuestionCatalogEntry {
  const normalized = slug(definition.text);
  return {
    id: `p${definition.part}_${normalized}`,
    part: definition.part,
    promptText: `${definition.text}?`,
    audioObjectKey: `${AUDIO_PREFIX}/part-${definition.part}/${normalized}.${definition.extension}`,
  };
}

const SAMPLE_ANSWER_CATALOG_ENTRY = catalogEntry(SAMPLE_ANSWER_QUESTION);

export const SPEAKING_SAMPLE_ANSWER = Object.freeze({
  audioUrl:
    'https://s3.wispace.app/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm',
  part: SAMPLE_ANSWER_CATALOG_ENTRY.part,
  questionId: SAMPLE_ANSWER_CATALOG_ENTRY.id,
  promptText: SAMPLE_ANSWER_CATALOG_ENTRY.promptText,
});

const CATALOG = Object.freeze(DEFINITIONS.map(catalogEntry));

export function speakingQuestionCatalog(
  part?: SpeakingPart,
): readonly SpeakingQuestionCatalogEntry[] {
  return part === undefined
    ? CATALOG
    : CATALOG.filter((question) => question.part === part);
}

export async function listSpeakingQuestions(
  storage: SpeakingAudioStoragePort,
  part?: SpeakingPart,
): Promise<readonly SpeakingQuestionWithAudio[]> {
  const questions = speakingQuestionCatalog(part);
  return Promise.all(
    questions.map(async (question) => ({
      id: question.id,
      part: question.part,
      promptText: question.promptText,
      audioUrl: await storage.getReadUrl(question.audioObjectKey),
    })),
  );
}

export function speakingQuestionCount(): number {
  return CATALOG.length;
}
