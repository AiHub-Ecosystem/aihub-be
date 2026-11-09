export function collectSourceTextFailures(options: {
  readonly root: string;
  readonly files?: readonly string[];
  readonly readSource?: (file: string) => string;
}): { readonly failures: string[]; readonly stoppedEarly: boolean };
