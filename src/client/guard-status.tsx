import type { GuardConfigState } from './config-controller'
import type { SelfCheckResult } from '../self-check.js'

/** The settings the status lines summarize; a draft's limits are still text. */
interface StatusValues {
  readonly observeOnly: boolean
  readonly failureEnabled: boolean
  readonly failureLimit: number | string
  readonly repeatEnabled: boolean
  readonly repeatLimit: number | string
  readonly resumeOnRepeat: boolean
  readonly fragmentObserveEnabled: boolean
  readonly fuzzyObserveEnabled: boolean
  readonly crossTurnObserveEnabled: boolean
  readonly activeSteerEnabled: boolean
  readonly stopSimulationEnabled: boolean
}

function describe(options: StatusValues): string {
  return [options.observeOnly ? '仅观察' : '正常防护',
    options.failureEnabled ? '连续失败 ' + (options.failureLimit || '—') + ' 次' : '连续失败防护关闭',
    options.repeatEnabled ? '复读 ' + (options.repeatLimit || '—') + ' 行' : '复读防护关闭',
    options.repeatEnabled && !options.observeOnly && options.resumeOnRepeat ? '自动续跑开启' : '自动续跑不生效',
    options.fragmentObserveEnabled ? '短碎片观察开启' : '短碎片观察关闭',
  ].join(' · ')
}

/**
 * The four experimental switches, on their own line so the mode line above stays
 * scannable. The steer entry names the reason it cannot fire, which is the whole
 * difference between "enabled" and "in effect": observation suppresses it, and
 * the older automatic resume keeps its turn when both are on.
 * @param options - the effective settings or the draft.
 */
function describeExperiments(options: StatusValues): string {
  const resumeWins = options.repeatEnabled && !options.observeOnly && options.resumeOnRepeat
  const steer = !options.activeSteerEnabled ? '主动引导关闭'
    : options.observeOnly ? '主动引导开启（观察抑制）'
      : resumeWins ? '主动引导开启（续跑优先）'
        : '主动引导开启'
  return [
    options.fuzzyObserveEnabled ? '模糊复读仅记录' : '模糊复读不观察',
    options.crossTurnObserveEnabled ? '跨轮重复仅记录' : '跨轮重复不观察',
    steer,
    options.stopSimulationEnabled ? '模拟停手记录开启' : '模拟停手记录关闭',
  ].join(' · ')
}

export function GuardStatus({ state }: { state: GuardConfigState }) {
  const preview = state.touched && (state.dirty || state.failureLimit.invalid || state.repeatLimit.invalid)
  return (
    <section className="dfg-mode" aria-label="配置生效状态" aria-live="polite">
      <p><strong>当前生效</strong>{state.effective ? describe(state.effective) : '暂无已读取的配置'}</p>
      {state.effective ? <p><strong>实验开关</strong>{describeExperiments(state.effective)}</p> : null}
      {preview ? (
        <p><strong>未保存预览</strong>{describe(state.draft)}{state.failureLimit.invalid || state.repeatLimit.invalid ? '（请修正阈值）' : ''}</p>
      ) : null}
      {preview ? <p><strong>实验项预览</strong>{describeExperiments(state.draft)}</p> : null}
    </section>
  )
}

const ACTION: Record<SelfCheckResult['action'], string> = {
  disabled: '规则已关闭', none: '样本未达到阈值', observed: '只记录命中',
  notified: '会发送停手提示', cut: '会截断复读',
}

export function GuardSelfCheck({ state, run }: { state: GuardConfigState; run: () => void }) {
  const result = state.selfCheck
  return (
    <section className="dfg-check" aria-label="防护自检">
      <div className="dfg-check-header">
        <h5>防护自检</h5>
        <button type="button" className="dfg-button" disabled={!state.effective || state.saving || result?.kind === 'running'} onClick={run}>
          {result?.kind === 'running' ? '正在自检…' : '运行自检'}
        </button>
      </div>
      <p className="dfg-note">仅用当前生效配置模拟连续失败与连续复读，不含短碎片实验；不调用模型、工具或写入会话。</p>
      <div aria-live="polite">
        {result?.kind === 'error' ? <p>自检未完成，请重试。</p> : null}
        {result?.kind === 'result' ? <ul className="dfg-check-results">
          {result.results.map(item => <li key={item.rule}>
            {item.rule === 'failure' ? '连续失败' : '复读'}：样本 {item.inputCount}，阈值 {item.threshold}；{ACTION[item.action]}{item.wouldResume ? '，随后可续跑一次' : ''}。
          </li>)}
        </ul> : null}
      </div>
    </section>
  )
}
