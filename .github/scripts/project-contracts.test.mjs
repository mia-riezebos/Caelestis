import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyTriage, labelIssue, readContext } from './pullfrog-project.mjs'

const context = () => ({
  issue: { id: 'issue', url: 'https://github.com/example/project/issues/1' },
  project: {
    id: 'project',
    url: 'https://github.com/users/example/projects/1',
    fields: [
      {
        id: 'status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [{ id: 'ready', name: 'Ready' }],
      },
      { id: 'effort', name: 'Effort', dataType: 'NUMBER' },
    ],
  },
  item: { id: 'item', fieldValues: { nodes: [] } },
})
const decision = { track: true, status: 'Ready', priority: null, effort: 2, blockers: [] }

test('triage only accepts authenticated automation payloads identifying an issue', () => {
  assert.equal(labelIssue({ inputs: { prompt: '{broken' } }), null)
  assert.equal(labelIssue({ inputs: { prompt: JSON.stringify({ type: 'auto-label' }) } }), null)
  const payload = {
    '~pullfrog': true,
    type: 'auto-label',
    event: { issue_number: 8, is_pr: false },
  }
  assert.equal(labelIssue({ inputs: { prompt: JSON.stringify(payload) } }), 8)
  assert.throws(
    () =>
      labelIssue({
        inputs: { prompt: JSON.stringify({ ...payload, event: { issue_number: 8, is_pr: true } }) },
      }),
    /identify an issue/,
  )
})

test('triage preserves fields changed after planning and verifies each applied value', async () => {
  const held = context()
  const values = [{ field: { id: 'status' }, name: 'In progress' }]
  const writes = []
  const api = async (query, variables) => {
    if (query.includes('updateProjectV2ItemFieldValue')) {
      writes.push(variables)
      values.push({ field: { id: variables.field }, number: variables.value.number })
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } }
    }
    assert.match(query, /query\(\$id:ID!\)/)
    assert.equal(variables.id, 'item')
    return {
      node: {
        project: { id: 'project' },
        content: { id: 'issue' },
        fieldValues: { pageInfo: { hasNextPage: false }, nodes: values },
      },
    }
  }
  assert.match(await applyTriage(held, decision, api), /updated 1 empty fields/)
  assert.deepEqual(
    writes.map(({ field, value }) => ({ field, value })),
    [{ field: 'effort', value: { number: 2 } }],
  )
  assert.equal(values[0].name, 'In progress')
  assert.equal(
    await applyTriage(held, { ...decision, track: false }, async () => {
      throw new Error('unexpected API call')
    }),
    'No project changes requested.',
  )
})

test('triage rejects unknown choices before writing and rejects unverified project membership', async () => {
  await assert.rejects(
    applyTriage(context(), { ...decision, status: 'Invented' }, async () => {
      throw new Error('unexpected write')
    }),
    /Unknown Status/,
  )
  await assert.rejects(
    applyTriage(context(), { ...decision, status: null, effort: null }, async () => ({
      node: { project: { id: 'other' }, content: { id: 'issue' } },
    })),
    /membership verification failed/,
  )
})

test('project lookup follows item pages and refuses incomplete field schemas', async () => {
  let pages = 0
  const api = async (query, variables) => {
    if (query.includes('repository(owner:'))
      return {
        repository: { issue: { id: 'issue' } },
        user: {
          projectV2: { id: 'project', fields: { pageInfo: { hasNextPage: false }, nodes: [] } },
        },
      }
    assert.equal(variables.id, 'issue')
    pages++
    assert.equal(variables.cursor, pages === 1 ? null : 'next')
    return {
      node: {
        projectItems: {
          pageInfo: { hasNextPage: pages === 1, endCursor: 'next' },
          nodes:
            pages === 1
              ? []
              : [
                  {
                    id: 'item',
                    project: { id: 'project' },
                    fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] },
                  },
                ],
        },
      },
    }
  }
  assert.equal(
    (await readContext('example/repo', 1, 'https://github.com/users/example/projects/2', api)).item
      .id,
    'item',
  )
  assert.equal(pages, 2)
  await assert.rejects(
    readContext('example/repo', 1, 'https://github.com/users/example/projects/2', async () => ({
      repository: { issue: { id: 'issue' } },
      user: { projectV2: { fields: { pageInfo: { hasNextPage: true } } } },
    })),
    /incomplete schema/,
  )
})
