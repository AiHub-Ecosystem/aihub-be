import type { WritingChartEnvironment } from '@/modules/writing/domain/writing-chart-upload';

export const WRITING_CHART_UPLOAD_URL_TTL_SECONDS = 5 * 60;

export const WRITING_CHART_BUCKETS: Record<
  WritingChartEnvironment,
  { readonly staging: string; readonly public: string }
> = {
  production: {
    staging: 'aihub-writing-chart-staging',
    public: 'aihub-writing-charts',
  },
  sandbox: {
    staging: 'aihub-sandbox-writing-chart-staging',
    public: 'aihub-sandbox-writing-charts',
  },
};
