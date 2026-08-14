/** Progress weights used while a remote workflow combines transport and local refresh phases. */
export const RemoteTransportWeight = 0.9;

export function aggregateRemoteProgress(
  remoteIndex: number,
  remoteCount: number,
  value: number,
  transportWeight = RemoteTransportWeight,
): number {
  if (remoteCount <= 0) {
    return transportWeight;
  }
  const weight = transportWeight / remoteCount;
  return remoteIndex * weight + value * weight;
}

export function aggregatePhaseProgress(
  offset: number,
  phaseWeight: number,
  value: number,
): number {
  return offset + value * phaseWeight;
}
