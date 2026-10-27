# Original 210-event catalogue reconciliation

The original legacy handbook/catalogue was not found in the available project trees. The checked-in v2 build specification explicitly says that its R01–R40 first-release matrix is not the missing catalogue and must not be used to invent the legacy IDs or copy variants. The source file needed is the client's original 210-event legacy handbook/catalogue (including its stable IDs and source page/row references), preferably the editable source or a lossless export.

Use [`210-event-reconciliation-template.csv`](210-event-reconciliation-template.csv) to preserve one row per original record. Keep source ID, source name, and page/row reference verbatim. Populate verified implementation mappings only from source evidence. Unknowns may remain blank and `source_status` may be `UNVERIFIED`; never infer event keys, deadlines, copy, destinations, ownership, channels, stop conditions, or QA results. This is a reconciliation worksheet, not an executable registry and must not be loaded into production.

Validate the empty worksheet header with `--template`, or a completed source import without the flag:

```sh
node scripts/validate-notification-catalogue.mjs docs/notification-orchestration/210-event-reconciliation-template.csv --template
```

The validator requires exactly 210 records, the exact header, unique original IDs, a source location for every row, and a known evidence status. It allows implementation fields to remain blank while evidence is gathered. Run its regression tests with `node --test scripts/validate-notification-catalogue.node-test.mjs`.

## Import workflow once the source is supplied

1. Preserve an untouched copy and record its checksum and file name.
2. Transcribe only source records and stable IDs into the worksheet; resolve OCR ambiguity against the original.
3. Validate the 210 unique source-backed rows.
4. Reconcile each record against actual backend state, producer transaction, recipient resolution, copy approval, route, eligibility, stop state, and test evidence. Leave unsupported mappings `UNVERIFIED` or `BLOCKED`.
5. Review proposed code/schema changes as a separate implementation. Do not convert the worksheet directly into enabled rules.
