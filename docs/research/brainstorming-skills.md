# Brainstorming skills: research and design

## 1. Answer first

I found no institution-published, engine-neutral `SKILL.md` shown in a controlled study to produce better, diverse ideas for Moxy's tasks. There are tested components: Verbalized Sampling (VS) for diverse text, independent generation and critique designs for research ideas, and functional deduplication for measuring breadth. The published skills are useful workflow designs, not evidence that a whole skill works. The proposed combination below is a hypothesis to test, not an established result. Most studies use older models or research tasks, not daily games; several are preprints.

## 2. Findings

“Tested” refers to the cited experiment, not a test of our proposed skill. Costs below describe the original setup or the extra work needed; authors do not all report dollars. Prompt usability is about Moxy's available interfaces, not a claim of equivalent effect.

| Method or skill                                                                                                                                                                                                                                    | Evidence and measured effect                                                                                                                                                                                                                                                                | Cost; prompt usability and proposed translation                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [VS](https://arxiv.org/html/2510.01171), [authors' actual templates](https://github.com/CHATS-lab/verbalized-sampling)                                                                                                                             | **Tested:** creative-writing semantic diversity 1.6–2.1× direct prompting; human quality assessment is task-specific. The repository asks for five responses each with a numeric probability and sampling from the tail below 0.10.                                                         | Five outputs per call rather than one, with a fixed-output-budget comparison in the paper. **Yes:** request five alternatives and probabilities. The numbers are model-generated, not calibrated probabilities of another model proposing an idea; do not filter at 5% or treat them as evidence of novelty. Keep all five for later evaluation. |
| [Artificial Hivemind](https://arxiv.org/html/2510.22954)                                                                                                                                                                                           | **Tested diagnosis:** 50 responses per query across 70+ models; 79% of cases had average within-model embedding similarity over 0.8. Different models also converged. These are similarity measures, not duplicate rates.                                                                   | Many samples and embeddings; **no skill intervention tested**. Use multiple engines if affordable, but measure overlap. Its min-p decoding test still found high similarity; decoder controls are not reliably exposed by the CLIs.                                                                                                              |
| [NoveltyBench](https://arxiv.org/html/2504.05228)                                                                                                                                                                                                  | **Tested benchmark:** GPT-4o averaged 2.88 functionally distinct responses out of 10 across its benchmark. Human-labeled functional equivalence, not different wording, drives its distinct count; the trained classifier was 79% accurate on 100 held-out pairs.                           | 10 independent samples plus pairwise classification and quality scoring; its classifier requires a trained model. **Prompt approximation:** blind human or independent judge clusters by whether options provide different value, with an audit; not the benchmark score itself.                                                                 |
| [Multi-agent diversity collapse](https://arxiv.org/html/2604.18005)                                                                                                                                                                                | **Tested:** on research topics, at temperature 0.7, naive sequential discussion had Vendi diversity 3.092 versus 2.285 for leader-led discussion; this is not a test of isolated workers. In an appendix, horizontal and leader-led per-turn semantic novelty did not significantly differ. | Multiple multi-turn agents and embedding analysis. **Yes:** isolate generation as a plausible anti-anchoring design, not a proven effect size for Moxy; withhold leader's example solutions and peers' work.                                                                                                                                     |
| [Research ideation dialogue](https://arxiv.org/html/2507.08350)                                                                                                                                                                                    | **Tested:** on seven research topics, one to three parallel critics raised non-duplicate ratio from 0.77 to 0.80; three critique-revision iterations reached 0.85. Quality was judged by an LLM, not executed work.                                                                         | More critic calls and revisions; **yes:** use an independent critic after generation, bounded to one round by default. Three critics and repeated loops are optional, not guaranteed gains here.                                                                                                                                                 |
| [Google Co-Scientist](https://arxiv.org/abs/2502.18864), [DeepMind overview](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/), [published ablation](https://www.nature.com/articles/s41586-026-10644-y) | **Tested system:** generation, reflection, proximity clustering, pairwise Elo tournament, evolution and meta-review. Evolution raised GPQA precision from 70.9% to 75.4% and auto-judged hypothesis quality from 4.7 to 5.6 in reported tests; neither proves game quality.                 | Iterative multi-agent compute, retrieval and comparisons. **Partial prompt adaptation:** cluster, compare finalists and revise once; don't reproduce the full expensive system or imply Elo is required.                                                                                                                                         |
| [Si, Yang and Hashimoto](https://arxiv.org/html/2409.04109)                                                                                                                                                                                        | **Tested:** expert blind reviews rated AI research-idea novelty 5.64 versus 4.84 for human ideas on a 10-point scale; 4,000 seed ideas reduced to about 200 unique ideas by an embedding threshold. Seed deduplication is approximate.                                                      | Thousands of generations and expert reviews; **yes:** pool and dedupe early, and separate blind judgment from generation. Pitch novelty is not demonstrated execution success.                                                                                                                                                                   |
| [Sakana AI Scientist](https://arxiv.org/abs/2408.06292), [independent evaluation](https://arxiv.org/abs/2502.14297)                                                                                                                                | **Tested system:** generates ideas, searches literature, implements experiments and runs an automated review. Independent reviewers found inadequate novelty assessments; effect on Moxy game ideas is unmeasured.                                                                          | Full experimental runs and literature search; **partial:** search prior art and record uncertainty, then test a cheap instance rather than trust a novelty label.                                                                                                                                                                                |
| [Anthropic product-brainstorming](https://github.com/anthropics/knowledge-work-plugins/blob/main/product-management/skills/product-brainstorming/SKILL.md)                                                                                         | **Anecdotal skill:** reframes problems, questions assumptions and explores product options; no comparative evaluation found in the skill.                                                                                                                                                   | One interactive agent; **yes:** borrow problem and assumption framing.                                                                                                                                                                                                                                                                           |
| [obra brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)                                                                                                                                                  | **Anecdotal skill:** asks focused questions, compares approaches and records a design before implementation; no comparative evaluation found in the skill.                                                                                                                                  | Interactive design review; **yes:** borrow explicit design and tradeoffs, without its universal workflow gate.                                                                                                                                                                                                                                   |
| [jwynia brainstorming](https://github.com/jwynia/agent-skills/blob/main/skills/general/ideation/brainstorming/SKILL.md)                                                                                                                            | **Anecdotal skill:** identifies stuck states, extracts function, maps axes, uses random constraints and audits orthogonality; no comparative evaluation found in the skill.                                                                                                                 | One agent plus optional stimulus; **yes:** borrow distinct mechanisms and optional stimulus, not forced quotas.                                                                                                                                                                                                                                  |
| [lyndonkl diverge-converge](https://github.com/lyndonkl/claude/blob/main/skills/brainstorm-diverge-converge/SKILL.md)                                                                                                                              | **Anecdotal skill:** requirements, divergence, theme clustering, criteria and validation; no comparative outcome evaluation found in the skill.                                                                                                                                             | One agent and review; **yes:** borrow the phase boundaries. An included rubric is not evidence of effectiveness.                                                                                                                                                                                                                                 |
| [mthines ideate](https://github.com/mthines/agent-skills/blob/main/skills/analysis/ideate/SKILL.md)                                                                                                                                                | **Anecdotal skill:** isolated persona generators, independent judges, evolution and pre-mortem; cites research, but no comparative evaluation of the complete skill found in its source.                                                                                                    | Its deep mode estimates about 17 subagents; **yes:** borrow independent judging and an executable probe, with a smaller budget.                                                                                                                                                                                                                  |
| [chrisallenlane think-brainstorm](https://github.com/chrisallenlane/claude-swe-workflows/blob/master/skills/think-brainstorm/SKILL.md)                                                                                                             | **Anecdotal skill:** isolated technique-specific brainstormers, optional reframing, dedupe and flagged hybrids; no comparative evaluation found in the skill.                                                                                                                               | 3–6 brainstormers plus optional reframers; **yes:** borrow independent briefs and fit-for-purpose lenses.                                                                                                                                                                                                                                        |

The coding-agent workflows above are documented orchestrators: mthines carries candidates through independent judging and evolution; chrisallenlane stops at a catalog and delegates selection to a separate workflow. Co-Scientist and Sakana target scientific discovery and are much heavier. Their automatic judging and search results should not be mistaken for independent proof of novelty or playability.

## 3. Recommended protocol

1. **Frame.** Capture the user's goal, actual constraints, success criteria, budget and unknowns. Distinguish hard requirements from preferences. Agree on a small rubric before reading ideas. This borrows problem framing from Anthropic and guards against a persuasive pitch setting its own criteria.
2. **Diverge independently.** Give three fresh workers the same brief and different broad techniques, such as first principles, a real-world system, and inversion. Choose lenses for the task, not fixed personas. Each produces five mechanically distinct candidates using the VS template as an experiment. Optional random stimulus must change the mechanism, not merely its theme. No peer outputs, examples, or shared banned list. A private obvious-ideas exercise is optional; do not require or pass the list. This is motivated by Hivemind, VS and the collapse study; independent lenses are a design inference, not a separately proven intervention. A real user prohibition belongs in the brief.
3. **Converge.** After all workers finish, the leader pools, anonymizes and clusters by mechanism and user value, keeping provenance privately. Retain distinct high-potential options and a novel wildcard only if it clears basic constraints. A fresh judge scores the same rubric, cites concrete reasons and uncertainties, and sees candidates in randomized order without origin, model, scores or leader preference. Compare close finalists in reversed order to reduce position effects. Preserve disagreements and do not collapse criteria into a single weighted pitch score. Co-Scientist's proximity and tournament roles and NoveltyBench's functional equivalence motivate this.
4. **Validate.** Search for closest prior art for finalists; record links, search terms, differences and unknowns, not a declaration of global originality. An independent worker conducts the paper playtest below before any build. Ask for one bounded revision if a defect is repairable, then recheck it; otherwise retain another finalist or report no winner. In other domains, substitute a realistic walk-through and a cheap falsification test. Research-dialogue critique and Si's duplication results motivate separate critique; Sakana's novelty-check limitations motivate uncertainty.
5. **Decide.** Present a short shortlist, evidence, failures, cost and next experiment. The user chooses whether to build. A model's simulation is a screening tool, not observed human experience. Stop at the agreed worker and time budget; request a larger run only if necessary.

## 4. DIVIDE lessons and gates

The original [brief](../../../../daily-lab/docs/brief.md) specified one puzzle a day, but not several rounds; the preference for multiple rounds is new input and should override that earlier ambiguity. The [brainstorm record](../../../../daily-lab/docs/brainstorm.md) documents three lenses, 48 ideas and a blind judge. Its weighted rubric rewarded the pitch and first impression without testing repetition or the scoring baseline. The AI-native worker repeated a supplied banned list. A probability assigned to each pitch was treated as a rarity filter, although the VS template asks for a distribution of responses and does not validate such cross-model estimates.

- **Paper playtest before implementation:** for each finalist, a fresh worker specifies enough rules, scoring and five varied concrete instances to play them without inventing missing rules. For each, show the available information, a plausible decision, outcome and reasoning, plus the same simple strategy applied across all five. Name the strongest apparent repeatable strategy, its outcomes, when it fails and the knowledge needed to improve. If scoring or the correct answer cannot be computed from available information, mark the test inconclusive and propose the cheapest independent check; do not fabricate scores. For non-games, walk through five varied real use cases and test the simplest repeated workaround.
- **Depth after repetition is a gate:** compare a naive strategy and an informed one, and identify changing decisions across rounds. In [playtest 2](../../../../daily-lab/docs/playtest-2.md), a naive bisector still scored 72–82% on six later landscapes; best straight lines reached 88–92% on three. This qualifies the earlier fixes, and supports the user's concern even though some early boards improved. For other products, test whether the same shortcut handles every case.
- **Input is a separate gate:** describe the full action, accuracy demands, correction and feedback for both mouse and touch. A paper pass exposes likely friction; actual desktop mouse and phone touch testing are required before claiming usability. Scores must reflect the intended reasoning more than motor precision. In other domains, test each intended access mode and distinguish skill from interface friction. The second playtest included desktop layout checks as well as touch play; desktop layout observation is not evidence of a mouse gameplay test.
- **Session and art direction are explicit rubric criteria:** specify the number of rounds, timing and daily/session structure; use several rounds for this user's daily games unless they say otherwise. Require an actionable visual brief: references or specific layout, palette, typography, imagery, motion and what to avoid, with a small example screen. Review actual visuals later. For non-games, specify a complete session or workflow and its visual identity where relevant.
- **Independence:** ideators get no peers' ideas or banned lists. A shared list of examples anchors answers, as the repeated banned list demonstrated. Explicit user restrictions remain visible; similarity to known work is checked after generation. Random articles are optional provocation, not a quota or evidence of originality.

## 5. Draft skills

These are proposed texts, not installed skills. They use ordinary language and require no engine-specific tools.

### (a) Worker: `SKILL.md`

```markdown
---
name: creative-ideation
description: Independently generate distinct candidate ideas from a supplied brief.
---

Read the brief, constraints, assigned lens and output location. Do not read other
workers' ideas or lists of rejected or banned ideas. Honor actual user constraints.
Do not implement anything.

Generate five possible responses to the brief, each with its own text and a
numeric probability. Sample from the less typical tail; target a probability
below 0.10 for each, following Verbalized Sampling. These numbers are the
model's guesses, not measured probabilities or a novelty certificate. Do not
throw an idea away solely because of its number. If useful, use a random
stimulus to change a mechanism, and state the connection.

Make the five ideas differ in what the user does or how value is produced,
not merely in theme. For each give: name; one-sentence promise; concrete steps
of use; mechanism and what makes it different; constraints and feasible first
version; closest known prior art with uncertainty; the weakest assumption;
and the numeric typicality estimate. For interactive ideas include input and
feedback. For games include rounds per session and how choices vary.

State what would falsify each idea and what evidence is missing. Return all
five and their provenance in the requested output. Do not rank peers or claim
that a web search proves originality.
```

### (b) Leader: `SKILL.md`

```markdown
---
name: orchestrate-brainstorm
description: Run independent ideation, compare distinct ideas and validate finalists.
---

Use when the user wants a substantive brainstorm, subject to their budget and
instructions. Capture the goal, hard constraints, preferences, success rubric,
output format and budget; label assumptions. Ask only for information that
blocks useful work. The user controls whether implementation follows.

Choose three available engines or model families when practical using the
host's model and quota information. Choose suitable models and effort for the
task; respect the user's model, cost, quota and local-computer preferences.
If fewer are available, use independent fresh sessions and report the limitation.
Choose three broad, task-relevant lenses or techniques, such as first principles,
a system analogy and inversion; do not force a domain that does not fit.
Record engine, model, effort, lens and source for each result.

Delegate a separate copy of the worker ideation instructions and the same brief
to each worker, adding only its lens and output location. Tell workers not to
read peers' outputs or any banned-ideas list; use separate files and avoid
shared artifacts in their briefs. User-prohibited outcomes are real constraints
and must be included. Do not share your own preferred solution. Wait for all
results through the host's normal completion mechanism. If one fails, report it
and retry only within the budget; do not silently claim full independence.

Pool only after generation is complete. Anonymize candidates and cluster by
mechanism and user value; retain a map to provenance. Dedupe variants, keep
representative alternatives and report how many distinct clusters remain. Do
not suppress a promising outlier merely because it is unfamiliar.

Give a fresh, non-generator judge the candidates, original brief and rubric,
without authors, model names, scores or your preference. Randomize order;
reverse close comparisons. Require evidence and uncertainty per criterion, not
just a weighted total. Check prior art for finalists and record sources and gaps.

Before recommending a finalist, assign an independent reviewer to walk through
five varied concrete instances, including a simple repeatable strategy and an
informed alternative. Name the dominant strategy, outcomes, failure cases and
missing information; mark uncomputable results inconclusive. For games check
repeated depth, mouse and touch, correction, rounds per session and specific
art direction. Other tasks need an equivalent five-case workflow and shortcut
check. This screen does not replace real users or device tests.

Allow one bounded revision and recheck if the budget permits. Report distinct
candidates, judge disagreements, paper-test results, known prior art, costs,
uncertainty and the next cheapest test. A failed or inconclusive gate can mean
no recommendation. Present the result for the user's decision before building.
```

## 6. Evaluation plan

Run a small pilot on three different briefs: a daily game, a developer workflow and a consumer tool. Pre-register the briefs, rubric, number of ideas and pass criteria. For each, use the same three available engines/models, effort and fresh sessions in both conditions: a plain request for five distinct ideas versus the worker skill and three assigned lenses. Randomize condition order. That is 18 generation turns, producing up to 90 ideas; cap length and record token usage, elapsed time and actual cost or quota consumed. This compares the complete intervention, not VS alone. Repeat a subset if budget allows; one run per cell cannot establish reliability.

Blind source and condition; shuffle all ideas within each brief. An independent judge groups ideas with the same user value and mechanism, recording borderline decisions and cluster membership. Count distinct clusters per fixed 15-idea condition and clusters passing hard constraints. Audit a sample of pairs and disputed clusters yourself; report disagreement and sensitivity to alternate groupings. This is **in the style of** NoveltyBench, not its trained classifier or formal score. Use a separate blind judge and fixed rubric to rate individual ideas for usefulness, feasibility, novelty relative to known work, repeated-use depth and domain-specific constraints; randomize order and rejudge a sample with order reversed. Do not give judges the generator's self-rated probabilities.

Report per-brief results, paired differences, failures, runtime and cost, plus a few representative anonymized outputs. For the top candidate in each condition, perform the same five-instance probe and, where relevant, small human/device tests. Call the skill promising only if it produces more usable distinct clusters without a material quality or cost regression under a threshold the user sets in advance. With three briefs and model judges this is exploratory, not a statistically convincing victory; do not tune on these briefs and claim an independent win.

## 7. Where the skills should live

**Recommend Moxy as the canonical home**, for example `skills/creative-ideation/SKILL.md` and `skills/orchestrate-brainstorm/SKILL.md`. Moxy owns this leader-and-worker workflow, its quota handling and worktree boundaries. [agentic-devkit](../../../../../agentic-devkit/README.md) is a reusable upstream for generated project kits and a separate milestone runner, so it is a reasonable later home for a proven, host-neutral worker text; putting the orchestrator there now creates another dependency and splits ownership. Copy or upstream deliberately after evaluation, with provenance and a single maintained source.

Today Moxy's [implementation](../../IMPLEMENTATION.md) describes `delegate`, model/quota tools, durable task notes and asynchronous worker completions. [Worker service](../../src/workers/service.ts) applies shared rules; [leader prompt](../../src/moxy/leader-prompt.ts) directs delegation and turns to end instead of polling. A source search found no Moxy-owned skill discovery or injection mechanism. Native engines may have their own facilities, but their presence and visibility across worktrees are not a portable Moxy contract.

For a first implementation, add a short leader instruction identifying the available brainstorm workflow and how to read its packaged text **on demand**; include it in the packaged distribution at a stable, readable path and make that path available to every leader engine. The leader reads it when relevant, keeps stage and worker IDs in task notes, delegates, ends the turn, and resumes from inbox completions. It places the worker skill's actual text plus brief in each `delegate` prompt. This avoids relying on per-engine skill folders or copying user configuration into worktrees. It requires a small Moxy change to package and expose the text; it does not exist today. Verify delivery for every supported engine using fake-backed tests and deliberate bounded live checks. Do not add a general loader, new service, persistent workflow engine, or automatic skill installation for this first use.

## 8. Open questions

1. For daily games, should several rounds be a hard requirement, and what range and session length should the default target?
2. What worker, quota and elapsed-time budget is acceptable for a normal brainstorm and for a deeper run?
3. Should the leader always bring finalists back for a choice, or may it choose and proceed when the original task explicitly authorizes a build?
4. Which visual references or examples best express the user's desired art direction, and which styles should be avoided?
5. What minimum quality and maximum cost regression should the pilot accept when judging whether the skill beats the baseline?
