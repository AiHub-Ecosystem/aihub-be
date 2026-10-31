declare const cacheHelpers: {
  dependencyCruiserCacheDirectory(
    root: string,
    inputs: readonly string[],
  ): string;
};

export = cacheHelpers;
