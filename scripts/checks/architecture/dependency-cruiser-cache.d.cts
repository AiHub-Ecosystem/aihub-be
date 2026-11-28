declare const cacheHelpers: {
  dependencyCruiserCacheDirectory(
    root: string,
    inputs: readonly string[],
  ): string;
  generatedPrismaClientFingerprint(root: string): string;
  pruneDependencyCruiserCache(root: string, keepPath: string): void;
};

export = cacheHelpers;
