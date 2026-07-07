export interface ScriptOptions {
  reset: boolean;
  verbose: boolean;
  autoNgrok: boolean;
  publicUrl?: string;
  /**
   * Skip building the local worker release archive.
   * Use this when you want to reuse an existing archive in ./releases.
   */
  skipWorkerReleaseBuild: boolean;
  /**
   * Use GitHub release artifacts instead of local builds where supported.
   */
  useRelease: boolean;
  /**
   * Worker GitHub release channel to use when --use-release is enabled.
   */
  workerReleaseChannel: 'stable' | 'preview';
  /**
   * Optional worker GitHub release version to pin when --use-release is enabled.
   */
  workerReleaseVersion?: string;
}
