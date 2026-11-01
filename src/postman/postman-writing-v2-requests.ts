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

export function writingV2Folder(): Record<string, unknown> {
  return {
    name: WRITING_V2_FOLDER_NAME,
    description:
      'Writing grading on the v3 pipeline. Set `apiKey` and `baseUrl` first. These calls take 30 to 45 seconds and can take up to 120: raise the request timeout in Postman to at least 160 seconds (Settings, General, Request timeout). An essay of more than 1,000 words is refused with `400 INVALID_REQUEST`. Task 1 takes its `image_url` from the chart upload routes in the /v1 folder.',
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
    ],
  };
}
