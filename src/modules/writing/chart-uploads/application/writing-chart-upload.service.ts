import type { RequestContext } from '@/common/request-context/request-context';
import type { UploadSessionServicePort } from '@/modules/uploads/public';
import type {
  WritingChartAsset,
  WritingChartContentType,
} from '@/modules/writing/chart-uploads/domain/writing-chart-upload';
import type { WritingChartUploadServicePort } from './writing-chart-upload.port';

/** Maps Writing's vocabulary onto the shared core; no lifecycle logic here. */
export class WritingChartUploadService
  implements WritingChartUploadServicePort
{
  constructor(private readonly core: UploadSessionServicePort) {}

  async create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): ReturnType<WritingChartUploadServicePort['create']> {
    const grant = await this.core.create(input);
    return {
      ...grant,
      contentType: grant.contentType as WritingChartContentType,
    };
  }

  async refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): ReturnType<WritingChartUploadServicePort['refresh']> {
    const grant = await this.core.refresh(input);
    return {
      ...grant,
      contentType: grant.contentType as WritingChartContentType,
    };
  }

  async complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<WritingChartAsset> {
    return (await this.core.complete(input)) as WritingChartAsset;
  }
}
