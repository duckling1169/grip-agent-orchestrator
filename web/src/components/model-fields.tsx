import { useId } from 'react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import { api } from '../api.js'
import { useDetail } from '../state.js'
import type { Engine } from '../types.js'
import { ErrorBanner } from './common.js'

const readModels = (_: string, signal: AbortSignal) => api.models(signal)

const defaultChoice = 'default'

/**
 * An agent's models and the efforts the chosen one offers; an empty string is the agent's default.
 * `pickModel` returns the next choice, resetting an effort the new model doesn't offer.
 */
export function useModelChoices(engine: Engine, model: string, effort: string) {
  const catalogs = useDetail('models', readModels)
  const catalog = catalogs.data?.find(list => list.engine === engine)
  const chosen = catalog?.models.find(option => option.id === model)
  const allEfforts = [...new Set(catalog?.models.flatMap(option => option.efforts) ?? [])]
  const efforts = engine === 'agy' ? [] : (chosen?.efforts ?? allEfforts)
  const defaultEffort = (chosen ?? catalog?.models.find(option => option.isDefault))?.defaultEffort ?? null
  const pickModel = (value: string) => {
    const next = catalog?.models.find(option => option.id === value)
    return { model: value, effort: effort && !(next?.efforts ?? allEfforts).includes(effort) ? '' : effort }
  }
  return {
    models: catalog?.models ?? [],
    chosen,
    efforts,
    defaultEffort,
    error: catalogs.error ?? catalog?.error,
    loading: !catalogs.data && !catalogs.error,
    pickModel,
  }
}

/** Model and effort pickers for the start dialogs. */
export function ModelFields({
  engine,
  model,
  effort,
  disabled,
  choose,
}: {
  engine: Engine
  model: string
  effort: string
  disabled: boolean
  choose: (next: { model: string; effort: string }) => void
}) {
  const id = useId()
  const { models, chosen, efforts, defaultEffort, error, loading, pickModel: next } = useModelChoices(engine, model, effort)
  const catalog = { models }
  const effortPlaceholder = engine === 'agy' ? 'Set by the model' : 'Not used by this model'
  const pickModel = (value: string) => choose(next(value))
  const label = undefined
  const trigger = 'min-h-11 w-full min-w-0 md:min-h-9'

  return (
    <div className="grid items-start gap-3 min-[360px]:grid-cols-2">
      <div className="grid min-w-0 gap-2">
        <Label className={label} htmlFor={`${id}-model`}>
          Model
        </Label>
        <Select
          value={model ? `model:${model}` : defaultChoice}
          onValueChange={value => pickModel(value === defaultChoice ? '' : value.slice('model:'.length))}
          disabled={disabled || loading}
        >
          <SelectTrigger id={`${id}-model`} className={trigger}>
            <SelectValue placeholder="Agent default" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={defaultChoice}>{loading ? 'Loading models…' : 'Agent default'}</SelectItem>
            {catalog?.models.map(option => (
              <SelectItem key={option.id} value={`model:${option.id}`}>
                {option.label}
              </SelectItem>
            ))}
            {/* A model chosen elsewhere, or no longer listed, still shows by its id. */}
            {model && !chosen && <SelectItem value={`model:${model}`}>{model}</SelectItem>}
          </SelectContent>
        </Select>
        {error && <ErrorBanner text={`Couldn't list models. ${error}`} />}
      </div>
      <div className="grid min-w-0 gap-2">
        <Label className={label} htmlFor={`${id}-effort`}>
          Effort
        </Label>
        <Select
          value={effort ? `effort:${effort}` : defaultChoice}
          onValueChange={value => choose({ model, effort: value === defaultChoice ? '' : value.slice('effort:'.length) })}
          disabled={disabled || !efforts.length}
        >
          <SelectTrigger id={`${id}-effort`} className={trigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={defaultChoice}>
              {efforts.length || (loading && engine !== 'agy') ? `Default${defaultEffort ? ` (${defaultEffort})` : ''}` : effortPlaceholder}
            </SelectItem>
            {efforts.map(option => (
              <SelectItem key={option} value={`effort:${option}`}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
