# Grading changes

This log records every change to how AIHUB's grading behaves: a new or changed model, prompt, or rubric and evaluation in an AI Service that can move the bands returned for the same input. It is separate from the [Public API changelog](../CHANGELOG.md), which records changes to the API contract. A grading change leaves the contract as it is, so it never bumps the contract version.

The policy is [ADR-0131](adr/0131-customers-are-told-when-grading-behavior-changes.md).

## When you are told

| Kind of change                                             | When AIHUB tells you                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| Planned, expected to move bands past the agreed tolerance  | At least 14 days before it takes effect   |
| Planned and smaller, or an urgent correction               | No later than the day it takes effect     |
| A shift AIHUB detects without having been told of a change | Once AIHUB confirms it, with the evidence |

For a change announced ahead of time, AIHUB also emails your Organization owner contact.

## What an entry says

- the effective date;
- the operations affected: Writing Task 1, Writing Task 2, Speaking;
- what changed, in plain words. AIHUB does not name models or providers;
- the band-shift evidence: the direction and typical size on a fixed reference set, or a statement that the shift is not yet measured;
- what to re-check in your own validation set.

## What AIHUB does not promise

AIHUB does not promise that scores stay the same, re-grade results already returned, roll back for a single customer, or compensate for a shift. You cannot pin or opt into a grading behavior. If a change proves to be a regression, AIHUB publishes a correction here, and the AI Service owner decides whether to roll it back for everyone.

Contact support with a `request_id` when your validation breaks; see "Getting help" in the [Integration Guide](integration-guide.md).

## Log

Newest first. No grading change has been recorded yet.
