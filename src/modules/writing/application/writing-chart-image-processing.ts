let imageProcessingTail: Promise<void> = Promise.resolve();

export function serializeWritingChartImageProcessing<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = imageProcessingTail.then(operation, operation);
  imageProcessingTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
