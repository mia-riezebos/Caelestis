import type {
  Manifest,
  Node,
  Template,
  TemplateColourStatus,
  TemplateStatus,
} from '@caelestis/shared'

/**
 * Use the same progress terms as the userscript.
 * completed / mismatched / unpainted are the three meter segments, `known` is how much of the
 * template any tile observation has actually covered, and `total` is the denominator. The gap
 * between `known` and `total` is *unscanned*, not unpainted. The meter leaves it empty.
 */
export interface Progress {
  readonly completed: number
  readonly mismatched: number
  readonly unpainted: number
  readonly known: number
  readonly total: number
}

export const emptyProgress = (total: number): Progress => ({
  completed: 0,
  mismatched: 0,
  unpainted: 0,
  known: 0,
  total,
})

export const progressFromStatus = (template: Template, status?: TemplateStatus): Progress => {
  if (status === undefined) return emptyProgress(template.totalPixels)
  const known = status.correct + status.wrong + status.blank
  return {
    completed: status.correct,
    mismatched: status.wrong,
    unpainted: status.blank,
    known,
    total: template.totalPixels,
  }
}

export const sumProgress = (parts: readonly Progress[]): Progress =>
  parts.reduce(
    (sum, part) => ({
      completed: sum.completed + part.completed,
      mismatched: sum.mismatched + part.mismatched,
      unpainted: sum.unpainted + part.unpainted,
      known: sum.known + part.known,
      total: sum.total + part.total,
    }),
    emptyProgress(0),
  )

export interface TreeTemplate {
  readonly template: Template
  readonly status: TemplateStatus | undefined
  readonly progress: Progress
}

/** A manifest folder with its children resolved and its stats rolled up from every descendant. */
export interface TreeFolder {
  readonly node: Node
  readonly folders: TreeFolder[]
  readonly templates: TreeTemplate[]
  /** Aggregate over all templates in this folder and every folder beneath it. */
  readonly progress: Progress
  readonly templateCount: number
}

export interface TemplateTree {
  readonly folders: TreeFolder[]
  /** Templates that live at the server root, outside any folder. */
  readonly templates: TreeTemplate[]
  readonly progress: Progress
  readonly templateCount: number
}

const byName = (left: { name: string }, right: { name: string }): number =>
  left.name.localeCompare(right.name)

/**
 * Only published templates count toward a folder's total. Admins can still see drafts, but drafts
 * must not change progress for other users.
 */
const countable = (templates: readonly TreeTemplate[]): readonly Progress[] =>
  templates.filter((t) => t.template.published).map((t) => t.progress)

/**
 * Resolve the manifest's flat node/template lists into a rendered tree.
 *
 * A template with a missing `nodeId` falls back to the root. The manifest already drops orphaned
 * rows, so this only covers a read split between two polls.
 */
export const buildTree = (
  manifest: Manifest,
  statuses: ReadonlyMap<string, TemplateStatus>,
): TemplateTree => {
  const folderById = new Map<
    string,
    { node: Node; folders: TreeFolder[]; templates: TreeTemplate[] }
  >()
  for (const node of manifest.nodes) {
    folderById.set(node.id, { node, folders: [], templates: [] })
  }

  const rootTemplates: TreeTemplate[] = []
  for (const template of manifest.templates) {
    const entry: TreeTemplate = {
      template,
      status: statuses.get(template.id),
      progress: progressFromStatus(template, statuses.get(template.id)),
    }
    const parent = template.nodeId === null ? undefined : folderById.get(template.nodeId)
    if (parent === undefined) rootTemplates.push(entry)
    else parent.templates.push(entry)
  }

  const build = (id: string): TreeFolder => {
    const entry = folderById.get(id)
    if (entry === undefined) throw new Error(`unknown node ${id}`)
    const folders = manifest.nodes
      .filter((node) => node.parentId === id)
      .sort(byName)
      .map((node) => build(node.id))
    const templates = entry.templates.sort((a, b) => byName(a.template, b.template))
    const progress = sumProgress([...countable(templates), ...folders.map((f) => f.progress)])
    return {
      node: entry.node,
      folders,
      templates,
      progress,
      templateCount: templates.length + folders.reduce((n, f) => n + f.templateCount, 0),
    }
  }

  const folders = manifest.nodes
    .filter((node) => node.parentId === null)
    .sort(byName)
    .map((node) => build(node.id))
  const templates = rootTemplates.sort((a, b) => byName(a.template, b.template))
  return {
    folders,
    templates,
    progress: sumProgress([...countable(templates), ...folders.map((f) => f.progress)]),
    templateCount: templates.length + folders.reduce((n, f) => n + f.templateCount, 0),
  }
}

/**
 * Every published template id inside a folder, for folder-scoped history/leaderboard queries.
 * Skip unpublished IDs because they do not count toward totals. The server also hides them from
 * read tokens.
 */
export const folderTemplateIds = (folder: TreeFolder): string[] => [
  ...folder.templates.filter((t) => t.template.published).map((t) => t.template.id),
  ...folder.folders.flatMap(folderTemplateIds),
]

/**
 * Sum each palette index across published descendants. Return null if any template lacks colour
 * data because a partial total would be wrong.
 */
export const folderColourStatuses = (
  folder: TreeFolder,
): readonly TemplateColourStatus[] | null => {
  const reporting: TreeTemplate[] = []
  const collect = (current: TreeFolder): void => {
    for (const entry of current.templates) {
      if (entry.template.published && entry.status !== undefined) reporting.push(entry)
    }
    for (const child of current.folders) collect(child)
  }
  collect(folder)
  if (reporting.length === 0) return null
  if (reporting.some((entry) => entry.status?.colours === undefined)) return null
  const byIndex = new Map<
    number,
    { correct: number; wrong: number; blank: number; total: number }
  >()
  for (const entry of reporting) {
    for (const colour of entry.status?.colours ?? []) {
      const sum = byIndex.get(colour.index) ?? { correct: 0, wrong: 0, blank: 0, total: 0 }
      byIndex.set(colour.index, {
        correct: sum.correct + colour.correct,
        wrong: sum.wrong + colour.wrong,
        blank: sum.blank + colour.blank,
        total: sum.total + colour.total,
      })
    }
  }
  return [...byIndex.entries()]
    .map(([index, sums]) => ({ index, ...sums }))
    .sort((left, right) => left.index - right.index)
}
