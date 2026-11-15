import { assertStatus } from './postman-scenarios';

export const PRACTICE_V2_FOLDER_NAME = 'Public API /v2 (Practice content)';

export function practiceV2Folder(): Record<string, unknown> {
  return {
    name: PRACTICE_V2_FOLDER_NAME,
    description:
      'Unauthenticated Listening and Reading practice test lists with cursor pagination (ADR-0130, ADR-0167).',
    item: [
      {
        name: '1. List Listening tests',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: '{{baseUrl}}/v2/ielts/listening/tests',
          description: 'Lists Listening practice tests with cursor pagination.',
        },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [assertStatus(200)],
            },
          },
        ],
      },
      {
        name: '2. List Reading tests',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: '{{baseUrl}}/v2/ielts/reading/tests',
          description: 'Lists Reading practice tests with cursor pagination.',
        },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [assertStatus(200)],
            },
          },
        ],
      },
    ],
  };
}
