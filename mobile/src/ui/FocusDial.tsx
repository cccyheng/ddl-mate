import React, { useState } from 'react'
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { MotionReveal } from './motion'
import { colors, typography } from './theme'

/** Native dial: no independent clock, imported timer library, or decorative running loop. */
export function FocusDial({ value, label, progress, rest, caption }: {
  value: string; label: string; progress: number | null; rest: boolean; caption: string
}): React.ReactElement {
  const [width, setWidth] = useState(260)
  const { fontScale } = useWindowDimensions()
  const size = Math.min(280, Math.max(1, width)), center = size / 2, radius = center - 12
  // Large text needs natural document flow rather than being squeezed into a fixed circle.
  const textLayout = fontScale > 1.3 || size < 220
  const accent = rest ? '#98702C' : '#285B47'
  const filled = progress === null ? 0 : Math.round(Math.max(0, Math.min(1, progress)) * 60)
  return <MotionReveal style={styles.outer}>
    <View style={styles.measure} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <View style={[styles.dial, textLayout ? styles.textLayout : { width: size, height: size }]}>
        {!textLayout ? <View pointerEvents="none" accessible={false} style={[styles.inner, { inset: 27, borderRadius: size, backgroundColor: rest ? '#FBF3E4' : '#EDF4EF', borderColor: rest ? '#EEE0C6' : '#D7E6DC' }]} /> : null}
        {!textLayout ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.marks}>
          {Array.from({ length: 60 }, (_, i) => {
            const angle = i * Math.PI / 30, height = i % 5 === 0 ? 14 : 8
            return <View key={i} style={{ position: 'absolute', width: 3, height, borderRadius: 2,
              left: center + Math.sin(angle) * radius - 1.5, top: center - Math.cos(angle) * radius - height / 2,
              transform: [{ rotate: `${i * 6}deg` }], backgroundColor: i < filled ? accent : rest ? '#E6D8BB' : '#CEDCD1' }} />
          })}
        </View> : null}
        <View style={[styles.face, textLayout && styles.textFace]}>
          <Text style={[styles.label, { color: accent }]}>{label}</Text>
          <Text style={[styles.value, { color: accent }]} adjustsFontSizeToFit numberOfLines={1} accessibilityLabel={`${label}，${value}`}>{value}</Text>
          <Text style={styles.caption}>{caption}</Text>
        </View>
      </View>
    </View>
  </MotionReveal>
}
const styles = StyleSheet.create({
  outer: { width: '100%', alignItems: 'center', paddingVertical: 12 }, measure: { width: '100%', alignItems: 'center' },
  dial: { alignItems: 'center', justifyContent: 'center' }, inner: { position: 'absolute', borderWidth: 1 },
  marks: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  face: { width: '70%', alignItems: 'center', gap: 10 },
  textLayout: { width: '100%', paddingVertical: 20 }, textFace: { width: '100%', gap: 16 },
  label: { ...typography.label, textAlign: 'center' }, value: { fontSize: 51, fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: -1.5, maxWidth: '100%' },
  caption: { ...typography.caption, textAlign: 'center', fontSize: 12 },
})
