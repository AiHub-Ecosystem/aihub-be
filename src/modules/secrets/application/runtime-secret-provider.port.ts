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

export interface RuntimeSecretSnapshot {
  readonly aiSpeaking: AiSpeakingRuntimeSecrets;
  readonly aiWriting: AiWritingRuntimeSecrets;
  readonly seaweedfs?: SeaweedFsRuntimeSecrets;
}

export interface RuntimeSecretProvider {
  getSnapshot(): RuntimeSecretSnapshot;
}

export const RUNTIME_SECRET_PROVIDER = Symbol('RUNTIME_SECRET_PROVIDER');
