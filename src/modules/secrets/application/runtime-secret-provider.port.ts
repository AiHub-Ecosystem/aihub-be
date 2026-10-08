export interface AiSpeakingRuntimeSecrets {
  readonly clientId: string;
  readonly secretKey: string;
}

export interface AiWritingRuntimeSecrets {
  readonly token: string;
}

export interface SeaweedFsRuntimeSecrets {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface ResendRuntimeSecrets {
  readonly apiKey: string;
}

export interface EmailOutboxRuntimeSecrets {
  readonly currentKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export interface UserAccessJwtRuntimeSecrets {
  readonly privateKeyPem: string;
  readonly keyId: string;
}

/**
 * The Customer Web BFF client secret. Absent in a local environment that never
 * provisioned one, which is not the same as "no caller": the Web Session routes
 * read the absence and refuse rather than serve an open route.
 */
export interface WebSessionRuntimeSecrets {
  readonly clientSecret: string;
}

export interface RuntimeSecretSnapshot {
  readonly aiSpeaking: AiSpeakingRuntimeSecrets;
  readonly aiWriting: AiWritingRuntimeSecrets;
  readonly resend: ResendRuntimeSecrets;
  readonly userAccessJwt: UserAccessJwtRuntimeSecrets;
  readonly seaweedfs?: SeaweedFsRuntimeSecrets;
  readonly emailOutbox: EmailOutboxRuntimeSecrets;
  readonly webSession?: WebSessionRuntimeSecrets;
}

export interface RuntimeSecretProvider {
  getSnapshot(): RuntimeSecretSnapshot;
}

export const RUNTIME_SECRET_PROVIDER = Symbol('RUNTIME_SECRET_PROVIDER');
