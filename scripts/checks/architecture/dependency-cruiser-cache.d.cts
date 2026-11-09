declare const cacheHelpers: {
  dependencyCruiserCacheDirectory(
    root: string,
    inputs: readonly string[],
  ): string;
  generatedPrismaClientFingerprint(root: string): string;
};

export = cacheHelpers;
