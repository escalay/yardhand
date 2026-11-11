/** Update routes (owner only): what is running, what is newest, the two switches, and asking for an update. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/system/updates'
export const TAG = 'Updates'

/** One update as the updater reports it: in `status.json` while it runs, a line of `history.jsonl` once it ended. */
export const StatusSchema = z
  .object({
    id: z.string().openapi({ description: 'The request it answers.' }),
    state: z.enum(['working', 'done', 'failed', 'refused']).openapi({
      description:
        '`working`: under way. `done`: the new version runs. `failed`: it didn’t come up healthy, so the old version and its data were put back. `refused`: it never started (a bad version, a signature that didn’t check, a version too old to upgrade directly).',
    }),
    step: z.string().openapi({ description: 'What it is doing, or the last thing it did.' }),
    from: z.string(),
    to: z.string(),
    startedAt: z.string(),
    at: z.string().openapi({ description: 'When this was written.' }),
    detail: z.string().nullable().openapi({ description: 'Why it failed or was refused.' }),
  })
  .openapi('UpdateRun', { description: 'One update, as the updater reports it.' })

const UpdatesSchema = z
  .object({
    current: z.string().openapi({ description: 'The version running.' }),
    latest: z
      .object({
        version: z.string(),
        checkedAt: z.string(),
        notes: z.string().openapi({ description: 'Its release notes.' }),
      })
      .nullable()
      .openapi({ description: 'The newest release the last check named; null before the first check.' }),
    newer: z.boolean().openapi({ description: 'The newest release is newer than the version running.' }),
    check: z.boolean().openapi({ description: 'The daily check is on.' }),
    auto: z.boolean().openapi({ description: 'A newer version is installed by itself, through the updater.' }),
    checkUrl: z.string().openapi({ description: 'Where the newest version is asked (GATEWAY_UPDATE_URL).' }),
    updater: z
      .object({
        present: z.boolean().openapi({ description: 'It wrote beside the data in the last 90 seconds.' }),
        version: z.string().nullable(),
      })
      .openapi({ description: 'The updater container beside this gateway.' }),
    hook: z.boolean().openapi({ description: 'A deploy hook is set (GATEWAY_UPDATE_HOOK).' }),
    how: z.enum(['updater', 'hook', 'manual']).openapi({
      description:
        'What an update request does here: the `updater` carries it out, the platform’s deploy `hook` is called, or `manual`: run the commands in `manual`.',
    }),
    manual: z.string().openapi({
      description:
        'The commands that update this install by hand: Docker Compose’s, or `helm upgrade` on a Helm install.',
    }),
    docs: z.string().openapi({ description: 'The page on updates.' }),
    // Described on the property's own wrapper: a description put on the nullable would make every UpdateRun nullable
    status: z.union([StatusSchema, z.null()]).openapi({ description: 'The update under way, or the last one.' }),
    history: z.array(StatusSchema).openapi({ description: 'The last 20 updates, newest first.' }),
    _links: LinksSchema,
  })
  .openapi('Updates', { description: 'Updates: the version running, the newest one, the switches and past runs.' })

const body = (description: string) => ({ content: { [HAL_JSON]: { schema: UpdatesSchema } }, description })

export const routes = {
  updates: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'getUpdates',
    tags: [TAG],
    summary: 'Updates',
    description:
      'The version running, the newest release the last check named with its release notes, whether the daily check and automatic updates are on, how an update happens here, and the last runs (owner only). Reading it asks nobody.',
    responses: { 200: body('Updates.'), ...problemResponses(401, 403, 409) },
  }),
  check: createRoute({
    method: 'post',
    path: `${PATH}/check`,
    operationId: 'checkForUpdates',
    tags: [TAG],
    summary: 'Check for a newer version now',
    description:
      'Asks for the newest release now: one plain request, with no id and no report, even when the daily check is off (owner only). A failed check is a 503; the daily check tries again.',
    responses: { 200: body('Updates, after the check.'), ...problemResponses(401, 403, 409, 503) },
  }),
  change: createRoute({
    method: 'patch',
    path: PATH,
    operationId: 'changeUpdates',
    tags: [TAG],
    summary: 'Switch the daily check or automatic updates',
    description:
      'Switches the daily check for a newer version, or automatic updates, on or off (owner only). Automatic updates need the updater container: without it this answers 409.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .strictObject({
                check: z.boolean().optional().openapi({ description: 'The daily check.' }),
                auto: z.boolean().optional().openapi({ description: 'Install a newer version by itself.' }),
              })
              .openapi('UpdatesChange', { description: 'The switches to change; one left out stays as it is.' }),
          },
        },
        required: true,
      },
    },
    responses: { 200: body('Updates, as they are now.'), ...problemResponses(400, 401, 403, 409) },
  }),
  request: createRoute({
    method: 'post',
    path: `${PATH}/requests`,
    operationId: 'requestUpdate',
    tags: [TAG],
    summary: 'Update to a newer version',
    description:
      'Asks for an update to `version`, or to the newest release known (owner only). The gateway never updates itself: with the updater it leaves a request beside its data, and the updater checks the release’s signature, starts it and puts the old version back if it doesn’t come up; with only a deploy hook it calls the hook. Follow `status` on `GET /api/system/updates`: the gateway restarts on the way. Answers 409 when nothing newer is known, an update is under way, or neither an updater nor a hook is there.',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .strictObject({
                version: z.string().max(40).optional().openapi({
                  description: 'The version to move to, as `1.2.3`. Left out: the newest release known.',
                  example: '0.3.0',
                }),
              })
              .openapi('UpdateRequest', { description: 'Which version to move to.' }),
          },
        },
        required: false,
      },
    },
    responses: {
      202: body('The request was left for the updater, or the hook was called.'),
      ...problemResponses(400, 401, 403, 409, 503),
    },
  }),
}
