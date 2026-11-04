import React, { useCallback, useRef, useState } from 'react'
import { Text } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useAppStore } from '../store/AppStore'
import { focusDayStart, focusTotal, formatFocusDuration, type FocusStore } from '../domain/focusTime'
import { AppButton, SectionCard } from './components'
import { typography } from './theme'

export function FocusWeekSummary({ startDateKey, now }: { startDateKey: string; now: number }): React.ReactElement {
  const store = useAppStore()
  const api = useRef(store.focusTime); api.current = store.focusTime
  const [snapshot, setSnapshot] = useState<FocusStore | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useFocusEffect(useCallback(() => {
    let live = true; setSnapshot(null); setError('')
    void api.current.load().then(value => { if (live) setSnapshot(value) }, cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { live = false }
  }, [store.restoreEpoch, retry]))
  const from = focusDayStart(startDateKey)
  return <SectionCard title="所选周专注时长" subtitle="统计这一周已结束保存的计时；跨日按实际时段拆分，不使用预计用时。">
    <Text style={typography.title}>{snapshot ? formatFocusDuration(focusTotal(snapshot, from, from + 7 * 86400000, now)) : error ? '暂时无法读取' : '读取中…'}</Text>
    {error ? <><Text style={typography.caption}>{error}</Text><AppButton label="重新读取专注记录" onPress={() => setRetry(retry + 1)} /></> : null}
    {snapshot?.active ? <Text style={typography.caption}>还有一段专注尚未结束，保存后才会加入统计。</Text> : null}
  </SectionCard>
}
