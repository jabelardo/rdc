/** Timing for one application launch, matching desktop-plus's wire contract. */
export interface ILaunchStats {
  readonly mainReadyTime: number
  readonly loadTime: number
  readonly rendererReadyTime: number
}
