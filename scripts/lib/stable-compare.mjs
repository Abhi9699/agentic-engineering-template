/**
 * Deterministic string ordering for generated artifacts.
 *
 * `String.prototype.localeCompare` is locale- and ICU-dependent: the same two
 * strings can order differently on a Windows developer machine and a Linux CI
 * runner. Any generated file whose contents are sorted with it is therefore not
 * reproducible, and a drift gate over that file fails for the wrong reason —
 * reporting "drift" that is really just a different collation table.
 *
 * That is exactly what happened on PR #37: `docs/generated/document-inventory.json`
 * passed locally and failed in CI, twice, with no content difference at all.
 *
 * `compareStable` orders by UTF-16 code unit, which is the same everywhere. It is
 * NOT the right choice for text shown to a human — use `localeCompare` for that —
 * but it is the only correct choice for bytes that must be byte-identical across
 * machines.
 */
export function compareStable(left, right) {
    const a = String(left);
    const b = String(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
