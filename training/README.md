# Training scaffold

This directory is reserved for future dataset builders and weight export scripts for the browser move ranker.

Planned files:
- parseKifu.ts
- extractFeatures.ts
- buildDataset.ts
- exportWeights.ts

Current runtime integration reads `models/move-ranker.json` through `src/moveRanker.ts` and `src/featureExtractor.ts`.
