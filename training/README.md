# Training scaffold

## Current minimal dataset builder

`buildDataset.ts` reads positions from JSON and emits JSONL rows with extracted move features.

### Input format

```json
[
  {
    "sfen": "...",
    "bestMove": "7g7f",
    "candidateMoves": ["7g7f", "2g2f"]
  }
]
```

- `sfen`: position in SFEN
- `bestMove`: teacher move in USI format
- `candidateMoves`: optional candidate list. If omitted, all legal moves are generated.

### Run

```bash
node --experimental-strip-types training/buildDataset.ts
```

Optional custom paths:

```bash
node --experimental-strip-types training/buildDataset.ts training/sample-data/positions.json training/dataset.jsonl
```

### Output

JSONL rows like:

```json
{"sfen":"...","move":"7g7f","label":1,"features":{...}}
```

## Planned next steps

- Parse KIF / KI2 / CSA directly
- Add stronger candidate generation for training
- Add weight fitting / export scripts
- Feed learned weights back into `models/move-ranker.json`
