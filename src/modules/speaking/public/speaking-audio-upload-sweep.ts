export { SpeakingAudioUploadSweep } from '@/modules/speaking/application/audio/speaking-audio-upload.sweep';
export type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
export {
  createOperatorSpeakingAudioAssetStorage,
  createOperatorSpeakingAudioUploadRepository,
} from '@/modules/speaking/speaking-operator.module';
