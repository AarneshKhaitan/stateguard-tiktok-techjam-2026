export interface BaselineReferenceKey {
  baselineReleaseHash: string;
  generationId: string;
  taskHash: string;
  policyHash: string;
  arkModel: string;
  codexVersion: string;
}

/** Candidate release identity is intentionally absent: this cache is only a
 * reference for the active release under a fixed validation context. */
export function referenceCacheKey(input: BaselineReferenceKey): string {
  return JSON.stringify({
    baselineReleaseHash: input.baselineReleaseHash,
    generationId: input.generationId,
    taskHash: input.taskHash,
    policyHash: input.policyHash,
    arkModel: input.arkModel,
    codexVersion: input.codexVersion,
  });
}
