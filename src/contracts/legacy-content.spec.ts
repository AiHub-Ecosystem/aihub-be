import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';

import {
  ListeningTestsResponseSchema,
  ReadingTestsResponseSchema,
} from './practice/v2/tests';
import { SpeakingLibraryResponseSchema } from './speaking/v2/library';
import {
  WritingTask1TemplatesResponseSchema,
  WritingTask2TemplatesResponseSchema,
} from './writing/v2/templates';

function loadFixture(filename: string): unknown {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'test', 'fixtures', 'legacy-backend', filename),
      'utf8',
    ),
  );
}

interface RawTestItem {
  id: number;
  card_id: string;
  test_id: number;
  parts: number[];
  title: string;
  source: string;
  total_questions: number;
  estimated_minutes: number;
  difficulty: string;
  unit: string;
  question_types: string[];
}

function sampleTestItem(item: RawTestItem) {
  return {
    id: item.id,
    card_id: item.card_id,
    test_id: item.test_id,
    parts: item.parts,
    title: item.title,
    source: item.source,
    total_questions: item.total_questions,
    estimated_minutes: item.estimated_minutes,
    difficulty: item.difficulty,
    unit: item.unit,
    question_types: item.question_types,
  };
}

describe('Legacy content contracts for /v2', () => {
  it('validates WritingTask1TemplatesResponseSchema', () => {
    const raw = loadFixture('writing-template-task1.200.json') as Array<{
      id: number;
      question: string;
      typeId: number;
      typeName: string;
      sourceId: number;
      sourceName: string;
      imageAnalysisStatus: boolean;
      image?: string;
    }>;

    const mapped = {
      data: {
        templates: raw.slice(0, 5).map((item) => ({
          task_type: 'Task 1' as const,
          id: item.id,
          question: item.question,
          type_id: item.typeId,
          type_name: item.typeName,
          source_id: item.sourceId,
          source_name: item.sourceName,
          image_analysis_status: Boolean(item.imageAnalysisStatus),
          image_url: item.image ?? 'https://example.com/img.png',
        })),
        next_cursor: 'eyJwYWdlIjoyfQ',
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    };

    expect(Value.Check(WritingTask1TemplatesResponseSchema, mapped)).toBe(true);
  });

  it('validates WritingTask2TemplatesResponseSchema', () => {
    const raw = loadFixture('writing-template-task2.200.json') as Array<{
      id: number;
      question: string;
      typeId: number;
      typeName: string;
      sourceId: number;
      sourceName: string;
      imageAnalysisStatus: boolean;
    }>;

    const mapped = {
      data: {
        templates: raw.slice(0, 5).map((item) => ({
          task_type: 'Task 2' as const,
          id: item.id,
          question: item.question,
          type_id: item.typeId,
          type_name: item.typeName,
          source_id: item.sourceId,
          source_name: item.sourceName,
          image_analysis_status: Boolean(item.imageAnalysisStatus),
        })),
        next_cursor: null,
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    };

    expect(Value.Check(WritingTask2TemplatesResponseSchema, mapped)).toBe(true);
  });

  it('validates SpeakingLibraryResponseSchema', () => {
    const raw = loadFixture('speaking-library.200.json') as {
      items: Array<{
        id: number;
        originalId: number;
        topic: string;
        subtopic: string;
        part: number;
        difficulty: string;
        permanentTopic: boolean;
        source: string;
        questions: string[];
        createdAt: string;
      }>;
    };

    const mapped = {
      data: {
        topics: raw.items.slice(0, 5).map((item) => ({
          id: item.id,
          original_id: item.originalId,
          topic: item.topic,
          subtopic: item.subtopic,
          part: item.part,
          difficulty: item.difficulty,
          permanent_topic: Boolean(item.permanentTopic),
          source: item.source,
          questions: item.questions,
          created_at: item.createdAt,
        })),
        next_cursor: 'eyJwYWdlIjoyfQ',
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    };

    expect(Value.Check(SpeakingLibraryResponseSchema, mapped)).toBe(true);
  });

  it('validates ListeningTestsResponseSchema', () => {
    const raw = loadFixture('listening-tests.200.json') as {
      items: RawTestItem[];
    };

    const mapped = {
      data: {
        tests: raw.items.slice(0, 5).map(sampleTestItem),
        next_cursor: null,
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    };

    expect(Value.Check(ListeningTestsResponseSchema, mapped)).toBe(true);
  });

  it('validates ReadingTestsResponseSchema', () => {
    const raw = loadFixture('reading-tests.200.json') as {
      items: RawTestItem[];
    };

    const mapped = {
      data: {
        tests: raw.items.slice(0, 5).map(sampleTestItem),
        next_cursor: null,
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    };

    expect(Value.Check(ReadingTestsResponseSchema, mapped)).toBe(true);
  });
});
