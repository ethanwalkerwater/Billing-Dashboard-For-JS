# Parent Report Web · Design QA

## Scope

- Reference: selected “guided split canvas” concept generated during design exploration.
- Implementation: `apps/parent-report/web/` at desktop 1440 × 1024 and mobile 390 × 844.
- Real-data flow: student billing CSV + `schedule.csv` + previous-month teacher scores.

## Visual comparison

- Layout hierarchy matches the reference: persistent progress rail, central editable ledger, right-side report preview.
- Typography, warm paper palette, brass actions, thin rules, and PDF-like preview cards are consistent with the selected direction.
- Desktop information density remains usable at 1440 px; mobile collapses the rail to a horizontal stepper and keeps the ledger horizontally scrollable.
- The final field semantics match the brief and reference: normal lessons show a 0% cancellation ratio.

## Issues found and resolved

- **P1 — payable column overflow:** the seven-column ledger exceeded the center panel and placed payable amounts over the preview divider. Reduced column minimums and gaps while preserving readable inputs.
- **P1 — wrong percentage semantics:** the editable percentage was initially implemented as a 100% billing ratio. Replaced it with cancellation percentage, preserving normal-course discount behavior and billing-core cancellation rules.
- **P2 — delayed numeric recalculation:** numeric fields originally updated only after a change event. They now recompute totals and the report preview immediately on input.
- **P2 — manual override validation:** a manually entered payable amount now disables PDF generation until a modification reason is supplied.
- **P1 — production PDF omitted all text:** `@sparticuz/chromium` created `/tmp/fonts` before unpacking its bundled `fonts.conf`, so the unpack step treated the directory as complete and Chromium started without a fontconfig configuration. The Function now owns fontconfig initialization, registers the bundled browser-safe Noto Serif SC TrueType font, waits for the target family, and rejects PDFs whose pages lack font resources.
- **P1 — batch errors could not be located:** batch validation previously displayed only the number of invalid reports. It now lists every affected student, month, row, and reason, marks invalid reports in the student selector, and supports one-click navigation.
- **P1 — empty selects displayed phantom values:** a blank teacher or teaching type visually fell back to the first `<option>` while the model correctly remained empty. Required selects now show explicit “请选择…” placeholders; zero-priced complimentary lessons remain valid.

## Verification

- Real June sample parsed successfully in the browser.
- Gzip compression status displayed for all three source types.
- Duration edits immediately updated row payable amount, monthly hours, total payable, and preview.
- Manual payable overrides required a reason.
- Single PDF and batch ZIP downloads completed successfully.
- Browser console: no errors or warnings.
- Generated five-page PDF inspected visually: no clipping, overlap, or missing sections.
- Vercel preview Function verified with a full Chinese regression fixture: HTTP 200, five-page 759 KB PDF.
- Preview PDF font inspection confirms embedded `NotoSerifSC-Regular`; Chinese text extraction and all rendered pages pass.
- Real Batch 1 browser QA identified Caelyn, Claire, and Jack with their exact invalid price rows, and each error item navigated to the correct report.
- Real Batch 2 browser QA confirmed 姚凯榕 row 10 shows honest empty placeholders, accepts a ¥0 unit price, and clears validation after explicit teacher/type selection.

## Remaining severity

- P0: none
- P1: none
- P2: none
