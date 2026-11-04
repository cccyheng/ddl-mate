import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, type StyleProp, type ViewStyle } from 'react-native'

// Default to stillness until the system preference has been read. One listener per app.
const ReducedMotion = createContext(true)
export function MotionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    let alive = true, changed = false
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      changed = true
      if (alive) setReduced(value)
    })
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (alive && !changed) setReduced(value)
    }).catch(() => { /* Leave decorative motion off when unavailable. */ })
    return () => { alive = false; subscription.remove() }
  }, [])
  return <ReducedMotion.Provider value={reduced}>{children}</ReducedMotion.Provider>
}
export function useReducedMotion(): boolean { return useContext(ReducedMotion) }

export function usePressMotion(disabled = false) {
  const reduced = useReducedMotion()
  const scale = useRef(new Animated.Value(1)).current
  const animation = useRef<Animated.CompositeAnimation | null>(null)
  const stop = () => { animation.current?.stop(); animation.current = null }
  useEffect(() => { stop(); scale.setValue(1); return stop }, [disabled, reduced, scale])
  const move = (pressed: boolean) => {
    stop()
    if (disabled || reduced) { scale.setValue(1); return }
    animation.current = Animated.spring(scale, {
      toValue: pressed ? 0.97 : 1, speed: 32, bounciness: pressed ? 0 : 5, useNativeDriver: true,
    })
    animation.current.start()
  }
  return { scale, onPressIn: () => move(true), onPressOut: () => move(false) }
}

/** A single short entrance, never a loop or a per-list-item animation. */
export function MotionReveal({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.ReactElement {
  const reduced = useReducedMotion()
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current
  useEffect(() => {
    if (reduced) { progress.setValue(1); return }
    const animation = Animated.timing(progress, { toValue: 1, duration: 200, useNativeDriver: true })
    animation.start()
    return () => animation.stop()
  }, [progress, reduced])
  return <Animated.View style={[style, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]}>{children}</Animated.View>
}
