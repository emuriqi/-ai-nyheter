export type PairScores = { precision: number; recall: number; f1: number; truePairs: number; predictedPairs: number };

/**
 * Parvis presisjon og dekning for en gruppering mot en fasit: for alle par av
 * elementer, ble de lagt i samme sak når fasiten sier samme sak (dekning), og
 * var de i samme sak i fasiten når de ble lagt sammen (presisjon)?
 */
export function pairwiseScores(truth: Map<string, string>, predicted: Map<string, string>): PairScores {
  const ids = [...truth.keys()];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const same = truth.get(ids[i]) === truth.get(ids[j]);
      const together = predicted.get(ids[i]) === predicted.get(ids[j]);
      if (same && together) tp++;
      else if (!same && together) fp++;
      else if (same && !together) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, truePairs: tp + fn, predictedPairs: tp + fp };
}
