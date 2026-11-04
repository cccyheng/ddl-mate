import React, { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { colors } from './theme'
import { useReducedMotion } from './motion'

export function TabMark({ name, focused }: { name: 'today' | 'tasks' | 'courses' | 'calendar'; focused: boolean }): React.ReactElement {
  const reduced = useReducedMotion()
  const progress = useRef(new Animated.Value(focused ? 1 : 0)).current
  useEffect(() => {
    if (reduced) { progress.setValue(focused ? 1 : 0); return }
    const animation = Animated.spring(progress, { toValue: focused ? 1 : 0, speed: 24, bounciness: 3, useNativeDriver: true })
    animation.start()
    return () => animation.stop()
  }, [focused, reduced, progress])
  const color = focused ? colors.primaryDark : colors.textMuted
  return <View style={styles.box} accessible={false} importantForAccessibility="no-hide-descendants">
    <Animated.View style={[styles.pill, { opacity: progress, transform: [{ scaleX: progress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }) }] }]} />
    <View style={[styles.icon, name !== 'today' && { borderWidth: 1.6, borderColor: color, borderRadius: name === 'courses' ? 3 : 5 }]}>
      {name === 'today' ? <View style={styles.tiles}>{[0, 1, 2, 3].map(i => <View key={i} style={[styles.tile, { backgroundColor: color }]} />)}</View> :
        name === 'courses' ? <View style={[styles.spine, { backgroundColor: color }]} /> :
        name === 'calendar' ? <><View style={[styles.calendarTop, { backgroundColor: color }]} /><View style={[styles.calendarDot, { backgroundColor: color }]} /></> :
        <View style={styles.lines}>{[0, 1, 2].map(i => <View key={i} style={[styles.line, { backgroundColor: color }]} />)}</View>}
    </View>
  </View>
}
const styles = StyleSheet.create({
  box: { width: 56, height: 30, alignItems: 'center', justifyContent: 'center' },
  pill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 15, backgroundColor: colors.primarySoft },
  icon: { width: 20, height: 20 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  tile: { width: 8, height: 8, borderRadius: 2 },
  spine: { width: 1.5, position: 'absolute', left: 5, top: 0, bottom: 0 },
  calendarTop: { height: 1.5, position: 'absolute', top: 4, left: 0, right: 0 },
  calendarDot: { width: 5, height: 5, position: 'absolute', top: 9, left: 6, borderRadius: 1 },
  lines: { padding: 3, gap: 2 },
  line: { height: 1.5, borderRadius: 1 },
})
