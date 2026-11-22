/**
 * Runs builds in the gateway's process, one at a time per pack: the kit, a playbook per task, the skill, the checks
 * (and one repair), a rehearsal per task, then one proposal. Every ask is checked against the spend first; at the cap,
 * or when the provider refuses for money, the build stops and keeps what it has. Any other failure ends it `failed`
 * with what went wrong, and the pack can always be built again: the running id is freed whatever happens. Running
 * builds are known only in memory, so one left `running` by a restart reads as failed.
 */

import { SpendCapError } from '../../kit/vectors/index.js'
import type { Usage } from '../ai/clients.js'
import type { Ask, Model } from '../ai/model.js'
import type { Pipeline } from '../calls/pipeline.js'
import type { ManualContent } from '../catalog/content.js'
import type { CatalogRepo } from '../catalog/repo.js'
import { checkPack } from '../packs/checks.js'
import { packFlags } from '../packs/flags.js'
import { shownFindings } from '../packs/own.handlers.js'
import type { PacksRepo } from '../packs/repo.js'
import type { PackRow } from '../packs/schema.js'
import { SKILL_DOC } from '../packs/skill.js'
import { packStateOf } from '../packs/state.js'
import type { MeaningSearch } from '../tools/meaning.js'
import type { LiveTool, ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from '../upstreams/repo.js'
import {
  applyKit,
  applyPlaybook,
  applyRepair,
  applySkill,
  type BuildMode,
  brokenTexts,
  candidatesOf,
  contentsOfDraft,
  draftOf,
  kitAsk,
  playbookAsk,
  repairAsk,
  skillAsk,
} from './drafts.js'
import { type Draft, type Line, linesOf } from './proposal.js'
import { type Rehearsal, rehearsalPrincipal, rehearse, rehearses } from './rehearsal.js'
import type { BuildEstimate, BuildsRepo } from './repo.js'
import { BUILD_CAP_USD, createSpend, MAX_TOKENS, type Spent, TOKEN_BUDGET } from './spend.js'

export type Proposal = {
  mode: BuildMode
  /** The model that wrote it. */
  model: string
  lines: Line[]
  /** Tools it looked at and left out, each with why. */
  skipped: { name: string; reason: string }[]
  rehearsal: Rehearsal[]
  /** What the pack's checks find in the draft as a whole. */
  findings: ReturnType<typeof shownFindings>
  /** The draft the lines come from: never returned. */
  after: Draft
}

/** A build that stops early and keeps what it has. */
class Stop extends Error {
  constructor(readonly why: 'cap' | 'provider') {
    super(why)
  }
}

const MANUAL_CHARS = 4000
const changesThings = (tool: LiveTool) => !rehearses(tool)

export const createBuilder = ({
  builds,
  packs,
  tools,
  catalog,
  upstreams,
  meaning,
  model,
  pipeline,
}: {
  builds: BuildsRepo<Proposal>
  packs: PacksRepo
  tools: ToolsRepo
  catalog: CatalogRepo
  upstreams: UpstreamsRepo
  meaning: MeaningSearch | null
  model: Model
  pipeline: Pipeline
}) => {
  const repos = { packs, tools, catalog, upstreams }
  /** Running builds by pack id: which one, the step it is on, and what it has spent so far. */
  const running = new Map<string, { id: string; step: string; spent: () => Spent }>()

  /** What the manuals of these connections say, cut, for the skill's gotchas. */
  const manualsOf = async (upstreamIds: string[]) =>
    upstreamIds.length
      ? (await catalog.listLive({ kinds: ['manual'], upstreams: upstreamIds }))
          .slice(0, 3)
          .map((item) => (item.content as ManualContent).files['SKILL.md']?.slice(0, MANUAL_CHARS) ?? '')
          .filter(Boolean)
      : []

  const run = async (
    pack: PackRow,
    claim: { id: string; step: string; spent: () => Spent },
    mode: BuildMode,
    tasks: string[],
  ) => {
    // Read before anything can fail, so a failure still says what was spent
    let spend = createSpend({ capUsd: BUILD_CAP_USD, price: null, tokenBudget: TOKEN_BUDGET })
    let name = ''
    let before: Draft = {
      name: pack.name,
      title: pack.title,
      tools: [],
      variables: [],
      playbooks: [],
      skill: null,
      heldPlaybooks: [],
      manualPaths: [],
      upstreams: [],
    }
    let draft = before
    const reasons: Record<string, string> = {}
    const skipped: Proposal['skipped'] = []
    const rehearsal: Rehearsal[] = []
    const written = new Set<string>()
    const todo = [
      'the kit',
      ...tasks.map((task) => `the playbook for “${task}”`),
      'the skill',
      ...tasks.map((task) => `the rehearsal of “${task}”`),
    ]
    const did = (what: string) => todo.splice(todo.indexOf(what), 1)
    /** The build's one way to ask: the spend first, every answer counted, a refusal for money a stop. */
    const ask = async (input: Omit<Ask, 'maxTokens'>) => {
      const maxTokens = MAX_TOKENS[input.step]
      if (!spend.affords({ inputChars: input.system.length + input.user.length, maxTokens })) throw new Stop('cap')
      try {
        const answer = await model.ask({ ...input, maxTokens })
        spend.add(answer.usage)
        return answer.json
      } catch (error) {
        if (error instanceof SpendCapError) throw new Stop('provider')
        // An answer that came back in the wrong shape was still paid for
        const usage = (error as { usage?: Usage }).usage
        if (usage) spend.add(usage)
        throw error
      }
    }
    const proposalOf = (): Proposal => ({
      mode,
      model: name,
      lines: linesOf(before, draft, reasons),
      skipped,
      rehearsal,
      findings: shownFindings(checkPack(draft)),
      after: draft,
    })
    try {
      spend = createSpend({ capUsd: BUILD_CAP_USD, price: await model.price(), tokenBudget: TOKEN_BUDGET })
      claim.spent = () => spend.spent()
      name = await model.name()
      const contents = await packs.contentsOf(pack)
      before = draftOf(await packStateOf(repos, pack, contents), contents)
      draft = before
      claim.step = 'Drafting the kit'
      const candidates = await candidatesOf(
        { tools, upstreams, meaning },
        before.tools.map((tool) => tool.tool),
        [pack.description, ...tasks],
      )
      const flags =
        mode === 'refresh'
          ? // With no one's values: a person's flag names them and their value, and neither goes to the model
            (await packFlags({ packs, tools, clients: { ofPack: async () => [] } }))
              .filter((flagged) => flagged.pack.id === pack.id)
              .map((flagged) => ({ kind: flagged.kind, was: flagged.flag.was, now: flagged.flag.now }))
          : []
      const kit = applyKit(
        draft,
        await ask(kitAsk({ mode, pack, tasks, before, candidates, flags, changesThings })),
        candidates,
      )
      draft = kit.draft
      Object.assign(reasons, kit.reasons)
      skipped.push(...kit.skipped)
      did('the kit')
      for (const task of tasks) {
        claim.step = `Writing the playbook for “${task}”`
        const wrote = applyPlaybook(draft, await ask(playbookAsk(pack, draft, task, changesThings)), task, written)
        draft = wrote.draft
        reasons[`playbook:${wrote.name}`] = `For “${task}”.`
        did(`the playbook for “${task}”`)
      }
      claim.step = 'Writing the skill'
      const manuals = await manualsOf([
        ...new Set(draft.tools.map((tool) => tool.tool.slice(0, tool.tool.indexOf('.')))),
      ])
      draft = applySkill(draft, await ask(skillAsk(pack, draft, manuals, changesThings)))
      written.add(SKILL_DOC)
      did('the skill')
      const broken = brokenTexts(checkPack(draft), written)
      if (broken.errors.length) {
        claim.step = 'Fixing what the checks found'
        todo.unshift('fixing what the checks found')
        draft = applyRepair(draft, await ask(repairAsk(pack, draft, broken.errors, changesThings)), broken.paths)
        did('fixing what the checks found')
      }
      // The rehearsal runs as the drafted pack, built by the same lock its keys get, with the pack's own values
      const live = new Map(
        (await tools.liveMany(draft.tools.map((tool) => tool.tool))).map((tool) => [tool.name, tool]),
      )
      const principal = rehearsalPrincipal(pack, contentsOfDraft(pack, draft, contents))
      for (const task of tasks) {
        claim.step = `Rehearsing “${task}”`
        rehearsal.push(await rehearse({ task, principal, live, ask, pipeline }))
        did(`the rehearsal of “${task}”`)
      }
      await builds.finish(claim.id, { status: 'ready', proposal: proposalOf(), spent: spend.spent() })
    } catch (error) {
      if (error instanceof Stop)
        await builds.finish(claim.id, {
          status: 'stopped',
          proposal: proposalOf(),
          spent: spend.spent(),
          stopped: error.why,
          notDone: todo,
        })
      else
        await builds.finish(claim.id, {
          status: 'failed',
          proposal: null,
          spent: spend.spent(),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        })
    }
  }

  return {
    /** The build running for a pack, if any. */
    runningIn: (packId: string) => running.get(packId),
    /** Is this build running in this process? A `running` row it isn't was cut off by a restart. */
    holds: (packId: string, id: string) => running.get(packId)?.id === id,
    /**
     * Starts a build and answers its id at once; it runs in the background. The pack is claimed before anything is
     * awaited, so of two starts at once one gets the build and the other `busy`.
     */
    start: async (
      pack: PackRow,
      { mode, tasks, estimate }: { mode: BuildMode; tasks: string[]; estimate: BuildEstimate },
    ): Promise<{ id: string } | { busy: string }> => {
      const busy = running.get(pack.id)
      if (busy) return { busy: busy.id }
      const id = `pb_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      const claim = { id, step: 'Starting', spent: (): Spent => ({ usd: 0, tokens: 0, modelCalls: 0, known: false }) }
      running.set(pack.id, claim)
      try {
        await builds.create({ id, packId: pack.id, mode, tasks, estimate, packUpdatedAt: pack.updatedAt })
      } catch (error) {
        running.delete(pack.id)
        throw error
      }
      void run(pack, claim, mode, tasks)
        .catch((error: unknown) =>
          console.warn(`build ${id}: ${error instanceof Error ? error.message : String(error)}`),
        )
        .finally(() => running.delete(pack.id))
      return { id }
    },
  }
}

export type Builder = ReturnType<typeof createBuilder>
