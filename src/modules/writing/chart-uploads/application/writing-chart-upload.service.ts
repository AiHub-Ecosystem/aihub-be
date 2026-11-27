import type { RequestContext } from '@/common/request-context/request-context';
import type { UploadSessionServicePort } from '@/modules/uploads/public';
import type {
  WritingChartAsset,
  WritingChartContentType,
  WritingChartEnvironment,
} from '@/modules/writing/chart-uploads/domain/writing-chart-upload';
import type { WritingChartUploadServicePort } from './writing-chart-upload.port';

/** Maps Writing's vocabulary onto the shared core; no lifecycle logic here. */
export class WritingChartUploadService
  implements WritingChartUploadServicePort
{
  constructor(
    private readonly core: UploadSessionServicePort<
      WritingChartContentType,
      WritingChartEnvironment,
      WritingChartAsset
    >,
  ) {}

  async create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): ReturnType<WritingChartUploadServicePort['create']> {
    return this.core.create(input);
  }

  async refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): ReturnType<WritingChartUploadServicePort['refresh']> {
    return this.core.refresh(input);
  }

  async complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<WritingChartAsset> {
    return this.core.complete(input);
  }
}
