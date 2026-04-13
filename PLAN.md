# PLAN — task-status-single rule

## Summary
Add a structural trailer-validate rule that rejects commits with more than one
`Task-Status` trailer. Record the delegation in lifecycle-check with a one-line
comment above its `first()` helper. No refactor of `parseTrailersMulti` or the
state machine.

## Files touched
1. `src/tools/trailer-validate.ts` — add the rule
2. `tests/tools/trailer-validate.test.ts` — add negative fixture(s)
3. `src/tools/lifecycle-check.ts` — add one delegation comment

---

## 1. The rule

### Shape
- **Rule ID:** `task-status-single`
- **Severity:** `error`
- **Fires when:** `trailers['Task-Status']?.length > 1`
- **Detail message:** `Task-Status must appear at most once; found N: '<v1>', '<v2>', ...`
  - Quotes each value so multi-word or empty values are visible.
  - Includes count because the AC says "the detail message includes both values"
    and we should tolerate N>2 gracefully by listing all of them.

### Where it goes
Today every rule reads the Task-Status value via
`const taskStatus = first(trailers, 'Task-Status');` on line 118. The
single-trailer check must run **before** any rule that dereferences
`taskStatus`, otherwise a malformed commit with two statuses would produce
secondary violations driven by whichever value `first()` picked — noise the
rule exists to prevent.

Placement: immediately after the `Session-Id required` block (line 115) and
**before** the `Task-Status: optional, but if present must be in enum` block
(line 117). This is the earliest point the Task-Status values are inspected.

### Exact code

```ts
// Task-Status: at most one per commit. The protocol defines exactly one
// state per commit; multiple Task-Status trailers are ambiguous and
// callers (lifecycle-check, etc.) would silently honor only the first.
const taskStatusAll = trailers['Task-Status'] ?? [];
if (taskStatusAll.length > 1) {
  const listed = taskStatusAll.map((v) => `'${v}'`).join(', ');
  violations.push({
    rule: 'task-status-single',
    detail: `Task-Status must appear at most once; found ${taskStatusAll.length}: ${listed}`,
    severity: 'error',
  });
}
```

No change to `parseTrailersMulti` or the `first()` helper. No registry
object — rules are written inline in the handler; "registering" a rule
just means pushing a `{rule, detail, severity}` onto `violations`. This
matches the pattern used by all 13 existing rules.

### Downstream rule interaction
The existing `taskStatus` local (from `first(trailers, 'Task-Status')`) is
untouched. When `task-status-single` fires, the other Task-Status-dependent
rules (`task-status-enum`, COMPLETED/BLOCKED/FAILED/ASSIGNED invariants)
still evaluate against `first()`. That is fine — they do not conflict
semantically with `task-status-single`, and the whole commit is already
rejected by the new error. Tests should assert `toContain('task-status-single')`
(not strict equality) to tolerate any co-violations.

---

## 2. Tests

Fixture harness already supports repeated trailers: `CommitOpts.trailers` is
`Record<string, string | string[]>` and `buildMessage` writes one trailer
line per array element. Confirmed in `tests/harness/fixture-repo.ts`.

### New cases (2 negatives, 0 new positives)

Placed in the "Negative cases" block, after `N13` and before the
"Adjacent edge cases" divider, so the existing ordering reads cleanly.

**N14: flags commit with two Task-Status trailers**
```ts
it('N14: flags commit with two Task-Status trailers', async () => {
  const repo = await fresh();
  const data = await runValidate(repo, {
    subject: 'test',
    trailers: {
      'Agent-Id': 'moss',
      'Session-Id': 'abc',
      'Task-Status': ['PLANNING', 'IMPLEMENTING'],
    },
  });
  expect(data.ok).toBe(false);
  expect(ruleIds(data.violations)).toContain('task-status-single');
  const v = data.violations.find((x) => x.rule === 'task-status-single');
  expect(v?.detail).toContain('PLANNING');
  expect(v?.detail).toContain('IMPLEMENTING');
});
```

**N15: flags three Task-Status trailers (defense against N>2)**
```ts
it('N15: flags three Task-Status trailers', async () => {
  const repo = await fresh();
  const data = await runValidate(repo, {
    subject: 'test',
    trailers: {
      'Agent-Id': 'moss',
      'Session-Id': 'abc',
      'Task-Status': ['ASSIGNED', 'PLANNING', 'COMPLETED'],
    },
  });
  expect(data.ok).toBe(false);
  expect(ruleIds(data.violations)).toContain('task-status-single');
});
```

### Why no new positive
AC says: *"Positive: valid commit with exactly one Task-Status passes (this
is already covered; no new positive needed unless the refactor changes
semantics)."* The refactor does not change semantics for N=1 commits — the
new block only fires when `length > 1`, so P2–P8 and every other positive
continue to pass unchanged.

---

## 3. lifecycle-check delegation comment

The task spec quotes an exact phrasing: *"trailer-validate enforces
task-status-single; we trust the first value here."*

Target: the `first()` helper at line 137, or its Task-Status call site
at line 240. I will place it at the call site (line 240), because:
- The helper `first()` is general-purpose (used for Agent-Id, Session-Id,
  Heartbeat, …). A comment there would be misleading — the delegation
  only applies to Task-Status.
- The call site is where the trust decision is actually made.

### Exact edit
Line 240:
```ts
      const rawStatus = first(trailers, 'Task-Status');
```
Becomes:
```ts
      // trailer-validate enforces task-status-single; we trust the first value here.
      const rawStatus = first(trailers, 'Task-Status');
```

Single line, verbatim from the spec. No surrounding prose added.

---

## 4. Risks / edge cases

1. **Empty-value repetition.** If someone writes `Task-Status:` twice with
   blank values, `parseTrailersMulti` will produce `['', '']` (length 2).
   Our rule fires correctly. Detail message will show `'' , ''` — ugly
   but honest. No special-casing.

2. **Mixed enum validity.** `['WAT', 'PLANNING']` will fire BOTH
   `task-status-single` AND `task-status-enum` (the latter via `first()`
   which returns `'WAT'`). This is fine — both are errors on the same
   commit, and tests use `toContain()`. Documenting it here so review
   doesn't flag it as a regression.

3. **Rule ordering vs. Heartbeat checks.** Heartbeat rules on line 253
   read `taskStatus` (from `first()`), which is unaffected. No interaction.

4. **`git interpret-trailers` behavior.** Git's own trailer parser (used
   by `%(trailers)`) preserves duplicate keys in order — confirmed by the
   existing Key-Finding tests (P6 uses three `Key-Finding` trailers and
   they round-trip through `%(trailers)` correctly). The same mechanism
   will work for repeated `Task-Status`.

5. **lifecycle-check still unsafe in isolation.** If lifecycle-check is
   invoked on a branch whose commits have not been trailer-validated
   first, a two-Task-Status commit will still silently pass. The task
   explicitly keeps lifecycle-check changes minimal (comment only); the
   delegation is documentation, not enforcement. Orchestrator chains
   trailer-validate → lifecycle-check. Acceptable per AC.

---

## 5. Protocol ambiguities
None. The task spec is unambiguous on rule ID, placement, severity,
detail-message requirement, test assertion pattern, and the exact
delegation-comment text.

## 6. Order of operations (implement phase)
1. Edit `src/tools/trailer-validate.ts` — add the rule block.
2. Edit `tests/tools/trailer-validate.test.ts` — add N14 and N15.
3. Edit `src/tools/lifecycle-check.ts` — add the delegation comment.
4. `npm test` — confirm full suite passes.
5. Review diff against scope; nothing outside the three listed files.
6. Commit as IMPLEMENTING then COMPLETED per protocol.

— Built by Moss
