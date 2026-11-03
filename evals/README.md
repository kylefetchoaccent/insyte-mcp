# Evals

Measures whether Claude answers Insyte questions correctly and in few tool calls, using whatever tools the built server lists. Run it before and after a tool change to get two comparable numbers.

Nothing here has been run against a real tenant or the real Anthropic API yet. The offline test uses mocks.

## Run

```
npm run build
node evals/run.mjs --dry-run                        # no API calls, checks the plumbing
INSYTE_API_KEY=... node evals/capture-golden.mjs    # once per tenant
ANTHROPIC_API_KEY=... npm run eval                  # real run
```

Flags: `--model <id>` (default claude-sonnet-5-5), `--only id1,id2`, `--concurrency N` (default 1, keep it there: Accent AUP 4.4), `--system <name>`, `--max-turns N`.

Number checks need golden values. `capture-golden.mjs` runs each check's `goldenQuery` through the server and writes `evals/golden/<system>.json` with numbers and ids only. Without a golden file, number checks are skipped, never passed. Nobody types golden values by hand.

Results go to `evals/results/<timestamp>.json`. Both folders are gitignored.

## Question file

`questions.jsonl` has one item per line: `id`, `question`, `audience` (dealer or staff), `category`, `source` (the memory file it came from), `maxToolCalls`, `checks`. Questions carry no client or people names. Items with `requires.minSystems` are skipped when fewer systems exist. Injection items carry `inject`: the harness plants that text in a record note the first time a listed tool returns, so the real data needs no poisoned record.

## Checks

All checks are code. No LLM judge.

| Check | Passes when |
|---|---|
| `number` | Any number in the answer is within `tolerance` of the golden value |
| `must_mention` | The answer contains all `terms` (or any, with `mode: any`) |
| `must_not_mention` | The answer contains none of the `terms` |
| `must_ask_clarification` | The answer has a question mark and at least `min` of the `terms` |
| `must_call` | Every listed tool was called, matching `argsMatch` regexes if given |
| `must_not_call` | No listed tool was called with matching args |

`number` is lenient: any number in the answer can match. Read the failures.

## Convergence

Each question records tool calls against `maxToolCalls`. A question can pass its checks and still blow its budget. The summary reports both, plus median and p90 calls.

## Output cap

For every tool result of 500+ characters the run records its length and its token count from `count_tokens`, minus a one-character baseline. The summary prints the largest result and the worst characters per token. The server assumes 2.4 and has never measured it. If a 60,000-character result would exceed 25,000 tokens at the worst ratio, the cap is too high.

## Compare before and after

Run the same questions, model and tenant twice, changing one thing between runs (the server build, the prompt, or the model).

```
node evals/run.mjs --compare evals/results/<before>.json evals/results/<after>.json
```

It prints questions whose status or call count changed, and each run's totals. Read the changed questions first. One run is one sample of a non-deterministic system, so repeat runs before trusting a small gap.
