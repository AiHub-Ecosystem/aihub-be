import type {
  ListeningTestsQuery,
  ListeningTestsResponse,
} from '@/contracts/listening/tests';
import type {
  ReadingTestsQuery,
  ReadingTestsResponse,
} from '@/contracts/reading/tests';
import type {
  SpeakingLibraryQuery,
  SpeakingLibraryResponse,
} from '@/contracts/speaking/library';
import type {
  WritingTemplateListResponse,
  WritingTemplateTaskType,
} from '@/contracts/writing/template';

export const FETCH_LEGACY_CONTENT_PORT = Symbol('FETCH_LEGACY_CONTENT_PORT');

export interface FetchLegacyContentPort {
  fetchWritingTemplates(
    taskType: WritingTemplateTaskType,
  ): Promise<WritingTemplateListResponse>;
  fetchSpeakingLibrary(
    query?: SpeakingLibraryQuery,
  ): Promise<SpeakingLibraryResponse>;
  fetchListeningTests(
    query?: ListeningTestsQuery,
  ): Promise<ListeningTestsResponse>;
  fetchReadingTests(query?: ReadingTestsQuery): Promise<ReadingTestsResponse>;
}
