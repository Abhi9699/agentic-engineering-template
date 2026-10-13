Binding rules (`docs/engineering/16-ai-prompt-spec.md` §7): any prompt-layer edit ships
with a SemVer bump **and** the recorded eval report, committed with the change; safety
stays `BLOCK_MEDIUM_AND_ABOVE`. The eval is dry (zero model calls, $0) unless `--live` is
passed with all seven ceilings. The pre-commit hook prints this reminder when a
prompt-layer file is staged.
