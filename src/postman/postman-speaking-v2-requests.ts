import { assertStatus } from './postman-scenarios';

/**
 * The Public API /v2 Speaking walkthrough: seven requests to run in order, each
 * feeding the next through collection variables. It is written by hand, not
 * converted from `openapi/v2.json`, because the converter leaves `<string>`
 * placeholders and no way to chain ids. The routes themselves are in the
 * OpenAPI document; the spec checks that this folder names every one.
 */
export const SPEAKING_V2_FOLDER_NAME = 'Public API /v2 (Speaking walkthrough)';

/** Collection variables the walkthrough reads and writes. */
export const SPEAKING_V2_VARIABLES = [
  {
    key: 'v2TestId',
    value: '',
    description:
      'Your id for the Test being graded. The folder fills it on first use. Clear it, v2PartResultId and v2ResponseIds to start a new run.',
  },
  {
    key: 'v2PartResultId',
    value: '',
    description: 'Your id for the Part being graded. The folder fills it.',
  },
  {
    key: 'v2ResponseIds',
    value: '[]',
    description:
      'JSON list of the question response ids graded so far in this run.',
  },
  {
    key: 'v2ResponseId',
    value: '',
    description: 'Response id of the last graded question.',
  },
  {
    key: 'v2QuestionId',
    value: 'p1_do-you-enjoy-living-in-your-city-or-hometown',
    description: 'Question graded in step 1. Step 0 replaces it.',
  },
  {
    key: 'v2PromptText',
    value: 'Do you enjoy living in your city or hometown?',
    description: 'Prompt of the question in v2QuestionId. Step 0 replaces it.',
  },
] as const;

const JSON_BODY_HEADER = { key: 'Content-Type', value: 'application/json' };
const IDENTITY_HEADER = { key: 'X-User-Identity', value: '{{declaredUserId}}' };
const IDEMPOTENCY_HEADER = { key: 'Idempotency-Key', value: '{{$guid}}' };

// Postman has no per-folder variable block, so the folder makes its own ids.
const PREPARE_IDS = [
  'const stamp = Date.now().toString(36);',
  "if (!pm.collectionVariables.get('v2TestId')) pm.collectionVariables.set('v2TestId', 'test_' + stamp);",
  "if (!pm.collectionVariables.get('v2PartResultId')) pm.collectionVariables.set('v2PartResultId', 'part_' + stamp);",
];

interface V2Request {
  readonly name: string;
  readonly description: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly testScript: readonly string[];
  readonly noAuth?: boolean;
}

function item(request: V2Request): Record<string, unknown> {
  const writes = request.method === 'POST';
  const headers = request.noAuth
    ? []
    : [
        IDENTITY_HEADER,
        ...(writes && request.body?.['mode'] === 'raw'
          ? [JSON_BODY_HEADER]
          : []),
        ...(writes ? [IDEMPOTENCY_HEADER] : []),
      ];
  return {
    name: request.name,
    request: {
      method: request.method,
      header: headers,
      ...(request.noAuth ? { auth: { type: 'noauth' } } : {}),
      body: request.body,
      url: `{{baseUrl}}${request.path}`,
      description: request.description,
    },
    event: [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: request.testScript },
      },
    ],
  };
}

const jsonBody = (value: string): Record<string, unknown> => ({
  mode: 'raw',
  raw: value,
  options: { raw: { language: 'json' } },
});

export const SPEAKING_V2_REQUESTS: readonly V2Request[] = [
  {
    name: '0. Pick a sample question (public, no API key)',
    description:
      'Lists the published Part 1 sample questions and keeps the first as the question for step 1. Its `audio_url` is a signed link that lasts 15 minutes: open it from the response body, save the recording, and pick that file in step 1. Any recording of your own works too. This is the one request in the walkthrough that is not under /v2: the question list has no /v2 route.',
    method: 'GET',
    path: '/v1/ielts/speaking/questions?part=1',
    noAuth: true,
    testScript: [
      assertStatus(200),
      'const first = pm.response.json().data.questions[0];',
      "pm.collectionVariables.set('v2QuestionId', first.question_id);",
      "pm.collectionVariables.set('v2PromptText', first.prompt_text);",
    ],
  },
  {
    name: '1. Grade a question (upload audio)',
    description:
      'Grades one recording. Pick the `audio` file in the body. `test_code` and `part_result_id` tie the answer to the Part and Test graded in steps 3 and 5; run this request once per question you want in the Part. Each run adds its response id to `v2ResponseIds`. Uses a declared user id from `declaredUserId`, which works for an Organization without an active identity configuration.',
    method: 'POST',
    path: '/v2/ielts/speaking/questions/grade',
    body: {
      mode: 'formdata',
      formdata: [
        { key: 'audio', type: 'file', src: [] },
        { key: 'part', value: '1', type: 'text' },
        { key: 'question_id', value: '{{v2QuestionId}}', type: 'text' },
        { key: 'prompt_text', value: '{{v2PromptText}}', type: 'text' },
        { key: 'test_type', value: 'practice', type: 'text' },
        { key: 'test_code', value: '{{v2TestId}}', type: 'text' },
        { key: 'part_result_id', value: '{{v2PartResultId}}', type: 'text' },
      ],
    },
    testScript: [
      assertStatus(200),
      'const meta = pm.response.json().data.meta;',
      "pm.collectionVariables.set('v2ResponseId', meta.response_id);",
      "const ids = JSON.parse(pm.collectionVariables.get('v2ResponseIds') || '[]');",
      'if (!ids.includes(meta.response_id)) ids.push(meta.response_id);',
      "pm.collectionVariables.set('v2ResponseIds', JSON.stringify(ids));",
    ],
  },
  {
    name: '2. Read a question result back',
    description:
      'Reads the stored result of the question graded in step 1. A result may take a moment to appear after grading; a `404 NOT_FOUND` right away means retry.',
    method: 'GET',
    path: '/v2/ielts/speaking/responses/{{v2ResponseId}}',
    testScript: [assertStatus(200)],
  },
  {
    name: '3. Grade a Part',
    description:
      'Grades the Part from the question responses collected in step 1.',
    method: 'POST',
    path: '/v2/ielts/speaking/parts/grade',
    body: jsonBody(
      '{\n  "part_result_id": "{{v2PartResultId}}",\n  "part": 1,\n  "test_id": "{{v2TestId}}",\n  "test_type": "practice",\n  "response_ids": {{v2ResponseIds}}\n}',
    ),
    testScript: [assertStatus(200)],
  },
  {
    name: '4. Read a Part result back',
    description: 'Reads the stored result of the Part graded in step 3.',
    method: 'GET',
    path: '/v2/ielts/speaking/parts/{{v2PartResultId}}',
    testScript: [assertStatus(200)],
  },
  {
    name: '5. Grade a Test',
    description: 'Grades the Test from the Part and responses of this run.',
    method: 'POST',
    path: '/v2/ielts/speaking/tests/grade',
    body: jsonBody(
      '{\n  "test_id": "{{v2TestId}}",\n  "test_type": "practice",\n  "part_result_ids": ["{{v2PartResultId}}"],\n  "response_ids": {{v2ResponseIds}}\n}',
    ),
    testScript: [assertStatus(200)],
  },
  {
    name: '6. Read a Test result back',
    description: 'Reads the stored result of the Test graded in step 5.',
    method: 'GET',
    path: '/v2/ielts/speaking/tests/{{v2TestId}}',
    testScript: [assertStatus(200)],
  },
];

export function speakingV2Folder(): Record<string, unknown> {
  return {
    name: SPEAKING_V2_FOLDER_NAME,
    description:
      'Run the requests in order. Set `apiKey` and `baseUrl` first. Each step stores the ids the next one needs in collection variables (`v2*`). To grade another Test, clear `v2TestId`, `v2PartResultId` and `v2ResponseIds`.',
    event: [
      {
        listen: 'prerequest',
        script: { type: 'text/javascript', exec: PREPARE_IDS },
      },
    ],
    item: SPEAKING_V2_REQUESTS.map(item),
  };
}
