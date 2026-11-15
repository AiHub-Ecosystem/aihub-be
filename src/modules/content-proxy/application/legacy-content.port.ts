import type {
  ListeningTestsResponse,
  ReadingTestsResponse,
} from '@/contracts/practice/v2/tests';
import type { SpeakingLibraryResponse } from '@/contracts/speaking/v2/library';
import type {
  WritingTask1TemplatesResponse,
  WritingTask2TemplatesResponse,
} from '@/contracts/writing/v2/templates';

export const FETCH_LEGACY_CONTENT_PORT = Symbol('FETCH_LEGACY_CONTENT_PORT');

export interface FetchLegacyContentPort {
  fetchWritingTask1Templates(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<WritingTask1TemplatesResponse>;

  fetchWritingTask2Templates(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<WritingTask2TemplatesResponse>;

  fetchSpeakingLibrary(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<SpeakingLibraryResponse>;

  fetchListeningTests(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<ListeningTestsResponse>;

  fetchReadingTests(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<ReadingTestsResponse>;
}
