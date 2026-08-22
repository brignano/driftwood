import type { Entity, Model, View } from '../model/schema.js'
import { matches } from '../model/validate.js'

/**
 * A view is a scoped slice of the model, matching entity ids or groups with an
 * optional trailing `*`. Shared by every renderer so scoping behaves
 * identically no matter which engine draws the picture.
 */
export function selectEntities(model: Model, view?: View): Entity[] {
  if (!view) return model.entities
  return model.entities.filter((e) => {
    const target = [e.id, e.group ?? '']
    const included =
      view.include.length === 0 ||
      view.include.some((p) => target.some((t) => t !== '' && matches(p, t)))
    const excluded = view.exclude.some((p) => target.some((t) => t !== '' && matches(p, t)))
    return included && !excluded
  })
}
