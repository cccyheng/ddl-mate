import React, { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { AppButton, SectionCard } from './components'
import { MotionReveal } from './motion'
import { colors, spacing, typography } from './theme'

export interface QuickAction { label: string; onPress: () => void; hint?: string }
export function QuickActions({ title, actions }: { title: string; actions: QuickAction[] }): React.ReactElement {
  return <SectionCard title={title}>
    <View style={styles.grid}>{actions.map(action => <AppButton key={action.label} label={action.label}
      onPress={action.onPress} accessibilityHint={action.hint} variant="secondary" style={styles.tile} />)}</View>
  </SectionCard>
}

/** For supplementary tools/explanations only; never wrap blocking errors or required fields. */
export function ToolDisclosure({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return <View style={styles.disclosure}>
    <AppButton label={`${open ? '收起' : '展开'}${title}`} onPress={() => setOpen(value => !value)} variant="ghost" />
    {open ? <MotionReveal><Text style={styles.disclosureHint}>{title}</Text>{children}</MotionReveal> : null}
  </View>
}
const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { flexGrow: 1, flexBasis: 128, minWidth: 0 },
  disclosure: { marginBottom: spacing.lg },
  disclosureHint: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.md },
})
