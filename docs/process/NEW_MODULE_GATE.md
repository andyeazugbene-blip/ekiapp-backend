# New Module Gate

Before creating a new module in `src/modules/`, answer these questions:

## Required Evidence
1. **User/problem evidence:** What user problem does this solve? Link to support tickets, user research, or business requirement.
2. **Success metric:** How will we know this worked after 4 weeks? (e.g., "50% of vendors use feature X")
3. **Existing module check:** Can an existing module solve this? If yes, extend it instead.
4. **Security/financial risk:** Does this touch money, auth, or user data? If yes, requires senior review.
5. **Required tests:** List the test cases that must pass before merge.
6. **Owner:** Who maintains this module going forward?
7. **Deprecation plan:** If unused after 60 days, what happens? (feature flag → remove)

## Approval
- Non-money modules: any engineer can approve
- Money-adjacent modules: requires senior engineer review
- New payment provider: requires architecture review

## After Approval
- Add to `docs/MODULE_OWNERSHIP.md`
- Add tests before merge
- Add to `scripts/module-test-coverage.ts` money-adjacent list if applicable
