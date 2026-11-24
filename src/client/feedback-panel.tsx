import { useId, useState } from 'react'
import type { GuardHit } from '../activity-shared.js'
import { buildFeedbackDocument, feedbackHit, feedbackLabels, FEEDBACK_RULES, REPORTED_ENABLEMENT, type FeedbackDocument } from './feedback.js'

const RULE_LABELS = {
  failure: '连续失败', repeat: '连续复读', fragment: '短碎片观察', fuzzy: '模糊复读观察',
  'cross-turn': '跨轮连败观察', steer: '主动引导排队', 'stop-simulation': '模拟停手',
} as const
const LABELS = { correct_hit: '命中正确', false_positive: '这是误报', false_negative: '报告漏报' } as const
const ENABLEMENT = { unknown: '不确定', enabled: '当时已开启', disabled: '当时未开启' } as const

export function FeedbackPanel(props: {
  readonly hits: readonly GuardHit[]
  readonly exporterVersion?: string
  readonly serialize: (data: FeedbackDocument) => string
  readonly download: (data: FeedbackDocument) => boolean
}) {
  const uid = useId()
  const [rule, setRule] = useState('')
  const [label, setLabel] = useState('')
  const [reportedEnablement, setReportedEnablement] = useState('unknown')
  const [includeVersion, setIncludeVersion] = useState(true)
  const [includeDetails, setIncludeDetails] = useState(true)
  const [status, setStatus] = useState<{ preview: string; text: string } | null>(null)
  const hit = feedbackHit(props.hits, rule)
  const labels = rule ? feedbackLabels(hit) : []
  const feedback = buildFeedbackDocument({ ...props, rule, label, reportedEnablement, includeVersion, includeDetails })
  const preview = feedback ? props.serialize(feedback) : ''
  return (
    <details className="dfg-feedback">
      <summary>标记防护反馈</summary>
      <div className="dfg-diag-field">
        <p className="dfg-diag-hint">只在点击下载时生成本地 JSON，不上传。反馈不包含会话内容、标识或诊断备注。</p>
        <label htmlFor={uid + '-rule'}>反馈规则</label>
        <select id={uid + '-rule'} value={rule} onChange={event => {
          setRule(event.currentTarget.value); setLabel(''); setReportedEnablement('unknown'); setStatus(null)
        }}>
          <option value="">选择一条规则</option>
          {FEEDBACK_RULES.map(key => <option key={key} value={key}>{RULE_LABELS[key]}</option>)}
        </select>
        {rule && <>
          <p className="dfg-diag-hint">{hit ? '本回合有这条规则的命中记录。' : '本回合没有可用的命中记录，无法据此判断规则当时是否开启或运行。'}</p>
          <label htmlFor={uid + '-label'}>你的判断</label>
          <select id={uid + '-label'} value={labels.some(value => value === label) ? label : ''} onChange={event => { setLabel(event.currentTarget.value); setStatus(null) }}>
            <option value="">选择判断</option>
            {labels.map(key => <option key={key} value={key}>{LABELS[key]}</option>)}
          </select>
          {!hit && <>
            <label htmlFor={uid + '-enabled'}>规则当时是否开启（按你的记忆）</label>
            <select id={uid + '-enabled'} value={reportedEnablement} onChange={event => { setReportedEnablement(event.currentTarget.value); setStatus(null) }}>
              {REPORTED_ENABLEMENT.map(key => <option key={key} value={key}>{ENABLEMENT[key]}</option>)}
            </select>
          </>}
        </>}
        {feedback && <>
          <fieldset className="dfg-diag-field">
            <legend>可选导出字段</legend>
            {props.exporterVersion && <label><input type="checkbox" checked={includeVersion} onChange={event => { setIncludeVersion(event.currentTarget.checked); setStatus(null) }} /> 导出插件版本</label>}
            {hit && <label><input type="checkbox" checked={includeDetails} onChange={event => { setIncludeDetails(event.currentTarget.checked); setStatus(null) }} /> 命中计数与处置</label>}
          </fieldset>
          <p className="dfg-diag-preview-label" id={uid + '-preview'}>反馈 JSON 预览</p>
          <pre className="dfg-diag-pre" role="region" tabIndex={0} aria-labelledby={uid + '-preview'}>{preview}</pre>
          <button className="dfg-diag-button dfg-diag-primary" type="button" onClick={() => {
            const ok = props.download(feedback)
            setStatus({ preview, text: ok ? '已请求本地下载。你可自行决定是否分享。' : '下载未完成，可复制上方预览。' })
          }}>下载反馈 JSON</button>
        </>}
        <p className="dfg-diag-hint" role="status">{status?.preview === preview ? status?.text : ''}</p>
      </div>
    </details>
  )
}
