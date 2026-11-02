import {
  TASK1_GRADE_BODY,
  TASK2_GRADE_BODY,
  assertEnvelope,
  assertStatus,
} from './postman-scenarios';

/**
 * The Public API /v2 Writing requests. Written by hand like the Speaking
 * walkthrough: the sample bodies are the same ones the /v1 requests use, so the
 * only difference a reader sees is the route and the response. The routes are in
 * the OpenAPI document; the spec checks that a /v2 folder names every one.
 */
export const WRITING_V2_FOLDER_NAME = 'Public API /v2 (Writing)';

const HEADERS = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'X-User-Identity', value: '{{declaredUserId}}' },
  { key: 'Idempotency-Key', value: '{{$guid}}' },
];

function gradeRequest(
  name: string,
  description: string,
  path: string,
  body: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  return {
    name,
    request: {
      method: 'POST',
      header: HEADERS,
      body: {
        mode: 'raw',
        raw: JSON.stringify(body, null, 2),
        options: { raw: { language: 'json' } },
      },
      url: `{{baseUrl}}${path}`,
      description,
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            assertStatus(200),
            ...assertEnvelope(operation),
            "pm.test('response has the /v2 shape', function () {",
            '  const data = pm.response.json().data;',
            '  pm.expect(data.criteria).to.have.length(4);',
            '  pm.expect(data.overall_assessment.progress).to.have.property("status");',
            '  pm.expect(data).to.have.property("data_micro");',
            '});',
          ],
        },
      },
    ],
  };
}

function exerciseRequest(
  name: string,
  description: string,
  path: string,
  body: Record<string, unknown>,
  operation: string,
  assertion: string,
): Record<string, unknown> {
  return {
    name,
    request: {
      method: 'POST',
      header: HEADERS,
      body: {
        mode: 'raw',
        raw: JSON.stringify(body, null, 2),
        options: { raw: { language: 'json' } },
      },
      url: `{{baseUrl}}${path}`,
      description,
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            assertStatus(200),
            ...assertEnvelope(operation),
            ...assertion.split('\n'),
          ],
        },
      },
    ],
  };
}

const MICRO_EXERCISE_BODY = {
  topic: 'education',
  writing_task: 2,
  criterion: 'grammatical_range_accuracy',
  error_code: 'GRA01',
  prompt: 'Use the target form.',
  question_type: 'grammar',
  comments: [
    { quote: 'She go to school.', explanation: 'Use third-person agreement.' },
  ],
  exercise_type: 'short_writing',
};

const LONG_WRITING_EXERCISE_BODY = {
  topic: 'education',
  writing_task: 2,
  errors: [
    {
      criterion: 'grammatical_range_accuracy',
      error_code: 'GRA01',
      prompt: 'Use the target form.',
      question_type: 'grammar',
      comments: [
        {
          quote: 'She go to school.',
          explanation: 'Use third-person agreement.',
        },
      ],
    },
    {
      criterion: 'coherence_cohesion',
      error_code: 'CC01',
      prompt: 'Connect related ideas.',
      question_type: 'cohesion',
      comments: [
        { quote: 'Also,', explanation: 'Link the clauses more clearly.' },
      ],
    },
  ],
};

const MICRO_EXERCISE_GRADE_BODY = {
  exercise_type: 'short_writing',
  instruction: 'Write one sentence.',
  question_no: 1,
  question_text: 'Use a conjunction.',
  question_image: null,
  hint: [],
  sample_answer: 'I stayed home because it rained.',
  ai_grading_rubric: 'Uses a correct conjunction.',
  note: null,
  user_answer: 'I stayed home because it rained.',
};

export function writingV2Folder(): Record<string, unknown> {
  return {
    name: WRITING_V2_FOLDER_NAME,
    description:
      'Writing grading uses the v3 pipeline; exercises use the AI Writing exercise endpoints. Set `apiKey` with `writing.grade` for grading or `writing.exercise` for exercise routes, and set `baseUrl`. Grading calls can take up to 120 seconds: raise the request timeout in Postman to at least 160 seconds (Settings, General, Request timeout). An essay of more than 1,000 words is refused with `400 INVALID_REQUEST`. Task 1 takes its `image_url` from the chart upload routes in the /v1 folder.',
    item: [
      gradeRequest(
        '1. Grade a Task 1 essay',
        'Grades a Task 1 essay against a chart. `chart_type` is case-sensitive; `image_url` is an HTTPS link to the chart image. Uses a declared user id from `declaredUserId`, which works for an Organization without an active identity configuration.',
        '/v2/ielts/writing/task1/grade',
        TASK1_GRADE_BODY,
        'writing.v2.task1.grade',
      ),
      gradeRequest(
        '2. Grade a Task 2 essay',
        'Grades a Task 2 essay. Repeating the call with the same `Idempotency-Key` and body returns the stored result without a new charge.',
        '/v2/ielts/writing/task2/grade',
        TASK2_GRADE_BODY,
        'writing.v2.task2.grade',
      ),
      exerciseRequest(
        '3. Create a micro exercise',
        'Creates one exercise from a selected Task 2 error. `exercise_type` may be omitted or null to let the provider choose a compatible type. The returned `meta.type` identifies the exercise.',
        '/v2/ielts/writing/micro-exercises',
        MICRO_EXERCISE_BODY,
        'writing.v2.micro-exercises.create',
        `pm.test('response contains a nonempty exercise', function () {
  const data = pm.response.json().data;
  pm.expect(data.exercise.length).to.be.above(0);
  pm.expect(data.meta.number_of_questions).to.equal(data.exercise.length);
});`,
      ),
      exerciseRequest(
        '4. Create a long-writing exercise',
        'Creates a long-writing exercise from two to four selected Task 2 errors. Each error includes its criterion, code, prompt, question type, and comments.',
        '/v2/ielts/writing/long-writing-exercises',
        LONG_WRITING_EXERCISE_BODY,
        'writing.v2.long-writing-exercises.create',
        `pm.test('response is a long-writing exercise', function () {
  const data = pm.response.json().data;
  pm.expect(data.meta.type).to.equal('long_writing');
  pm.expect(data.meta.number_of_questions).to.equal(data.exercise.length);
});`,
      ),
      exerciseRequest(
        '5. Grade a writing exercise',
        'Grades one short-writing answer. The result is a practice score from 1 to 10, not an IELTS band score.',
        '/v2/ielts/writing/micro-exercises/grade',
        MICRO_EXERCISE_GRADE_BODY,
        'writing.v2.micro-exercises.grade',
        `pm.test('response contains a practice score', function () {
  const data = pm.response.json().data;
  pm.expect(data.score).to.be.within(1, 10);
  pm.expect(data.comment).to.be.a('string');
});`,
      ),
    ],
  };
}
